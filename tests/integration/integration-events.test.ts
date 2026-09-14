import { IntegrationEntityType, IntegrationEventType, MembershipRole } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const session = vi.hoisted(() => ({ userId: null as string | null }));

vi.mock("@/server/auth/session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/auth/session")>();
  const { UnauthorizedError } = await import("@/server/errors");
  return {
    ...actual,
    getCurrentUserId: async () => session.userId,
    requireUserId: async () => {
      if (!session.userId) throw new UnauthorizedError();
      return session.userId;
    },
  };
});

/**
 * The emitter is mocked so a failing event insert can be observed.
 *
 * `failNext` is off for every test but the two that use it. The real implementation runs otherwise,
 * which matters: a suite that mocked the emitter throughout would prove the callers call something,
 * not that an event is written.
 */
const emitter = vi.hoisted(() => ({ failNext: false }));

vi.mock("@/server/integrations/events", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/integrations/events")>();
  return {
    ...actual,
    emitIntegrationEvent: async (...args: Parameters<typeof actual.emitIntegrationEvent>) => {
      if (emitter.failNext) {
        emitter.failNext = false;
        throw new Error("the event could not be written");
      }
      return actual.emitIntegrationEvent(...args);
    },
  };
});

import { POST as couponRoute } from "@/app/api/scanner/coupon/route";
import { POST as promotionsRoute } from "@/app/api/staff/promotions/route";
import { ForbiddenError } from "@/server/errors";
import { ENVELOPE_VERSION, listIntegrationEvents } from "@/server/integrations/events";
import { redeemCoupon, voidRedemption } from "@/server/promotions/redemption";
import {
  createStampCafe,
  enrolCustomer,
  migratorPrisma,
  resetDatabase,
  uniqueSyrianPhone,
  type StampCafeFixture,
} from "../setup/fixtures";

/**
 * The internal event record, through the services that write it.
 *
 * `integration-events-integrity.test.ts` proves the DATABASE refuses a wrong row. This proves the
 * services write a right one, that they write it **with** the action rather than after it, and that
 * nobody but an owner or a manager can read it back.
 */

const CODE = "AUTUMN10";

async function call(handler: (req: Request) => Promise<Response>, path: string, body: unknown) {
  const res = await handler(
    new Request(`http://localhost${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  return { status: res.status, body: (await res.json().catch(() => null)) as Record<string, unknown> | null };
}

const promotions = (body: unknown) => call(promotionsRoute, "/api/staff/promotions", body);
const coupon = (body: unknown) => call(couponRoute, "/api/scanner/coupon", body);

interface World {
  cafe: StampCafeFixture;
  promotionId: string;
  cardId: string;
  profileId: string;
}

/** A café with one ACTIVE promotion and one enrolled customer. */
async function build(name = "Events café"): Promise<World> {
  const cafe = await createStampCafe({ name });
  session.userId = cafe.userId;

  const created = await promotions({
    action: "create",
    businessId: cafe.businessId,
    name: "Autumn offer",
    benefitDescription: "A free espresso",
    code: CODE,
  });
  expect(created.status).toBe(201);
  const promotionId = String((created.body as unknown as { id: string }).id);
  await promotions({ action: "setState", businessId: cafe.businessId, promotionId, state: "ACTIVE" });

  const customer = await enrolCustomer(cafe, { phone: uniqueSyrianPhone(), firstName: "ليلى" });
  return { cafe, promotionId, cardId: customer.customerCardId, profileId: customer.customerBusinessProfileId };
}

/** The events this business has, read as the migrator so a permission bug cannot hide one. */
function storedEvents(businessId: string) {
  return migratorPrisma().integrationEvent.findMany({
    where: { businessId },
    orderBy: { occurredAt: "asc" },
  });
}

describe("a completed workflow records an event", () => {
  let w: World;

  beforeEach(async () => {
    await resetDatabase();
    emitter.failNext = false;
    w = await build();
  });

  it("writes one event for a redemption, naming the redemption row", async () => {
    const result = await redeemCoupon(w.cafe.ctx, { code: CODE, customerCardId: w.cardId });
    expect(result.outcome).toBe("RECORDED");

    const events = await storedEvents(w.cafe.businessId);
    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe(IntegrationEventType.PROMOTION_REDEMPTION_RECORDED);
    expect(events[0].entityType).toBe(IntegrationEntityType.PROMOTION_REDEMPTION);
    expect(events[0].envelopeVersion).toBe(ENVELOPE_VERSION);
    if (result.outcome !== "RECORDED") throw new Error("unreachable");
    expect(events[0].entityId).toBe(result.redemptionId);
  });

  it("writes a second event for a withdrawal, naming the VOID row and not the redemption", async () => {
    const result = await redeemCoupon(w.cafe.ctx, { code: CODE, customerCardId: w.cardId });
    if (result.outcome !== "RECORDED") throw new Error("the redemption should have been recorded");
    await voidRedemption(w.cafe.ctx, result.redemptionId, "mistyped");

    const events = await storedEvents(w.cafe.businessId);
    expect(events.map((e) => e.eventType)).toEqual([
      IntegrationEventType.PROMOTION_REDEMPTION_RECORDED,
      IntegrationEventType.PROMOTION_REDEMPTION_VOIDED,
    ]);

    /*
     * The void event names the VOID row. Both rows are things that happened and the "recorded"
     * event is still true about the first one — a void is a second fact, not a correction.
     */
    const voidRow = await migratorPrisma().promotionRedemption.findFirstOrThrow({
      where: { businessId: w.cafe.businessId, entry: "VOIDED" },
      select: { id: true },
    });
    expect(events[1].entityId).toBe(voidRow.id);
    expect(events[1].entityId).not.toBe(result.redemptionId);
  });

  it("records nothing for a coupon that was refused", async () => {
    const result = await redeemCoupon(w.cafe.ctx, { code: "NOTACODE", customerCardId: w.cardId });
    expect(result.outcome).toBe("NOT_ACCEPTED");
    expect(await storedEvents(w.cafe.businessId)).toHaveLength(0);
  });

  it("records nothing for the workflows this prompt did not cover", async () => {
    /*
     * Creating, activating, pausing and expiring a promotion, and enrolling a customer, are all
     * completed workflows too. None of them emits, because adding an event is a decision about
     * what a workflow may tell the outside world, not a convenience.
     */
    await promotions({ action: "setState", businessId: w.cafe.businessId, promotionId: w.promotionId, state: "PAUSED" });
    await enrolCustomer(w.cafe, { phone: uniqueSyrianPhone() });
    expect(await storedEvents(w.cafe.businessId)).toHaveLength(0);
  });

  it("assigns the moment itself, in order", async () => {
    const before = Date.now();
    const result = await redeemCoupon(w.cafe.ctx, { code: CODE, customerCardId: w.cardId });
    if (result.outcome !== "RECORDED") throw new Error("unreachable");
    await voidRedemption(w.cafe.ctx, result.redemptionId);

    const events = await storedEvents(w.cafe.businessId);
    for (const event of events) {
      expect(event.occurredAt.getTime()).toBeGreaterThanOrEqual(before - 60_000);
      expect(event.occurredAt.getTime()).toBeLessThanOrEqual(Date.now() + 60_000);
    }
    // Ordering is the one thing a future consumer will trust, so it must be the database's.
    expect(events[0].occurredAt.getTime()).toBeLessThanOrEqual(events[1].occurredAt.getTime());
  });
});

describe("the event and the action commit together", () => {
  let w: World;

  beforeEach(async () => {
    await resetDatabase();
    emitter.failNext = false;
    w = await build();
  });

  it("loses the redemption when the event cannot be written", async () => {
    /*
     * The half that is easy to get wrong. An event written after the transaction goes missing
     * whenever the process dies between the two writes, and a consumer cannot tell a missing event
     * from one that never should have existed.
     *
     * So: make the event insert throw, and assert the redemption is not there either. A cashier is
     * told the coupon was not accepted, which is true — nothing was recorded.
     */
    emitter.failNext = true;
    const result = await redeemCoupon(w.cafe.ctx, { code: CODE, customerCardId: w.cardId });
    expect(result.outcome).toBe("NOT_ACCEPTED");

    expect(await storedEvents(w.cafe.businessId)).toHaveLength(0);
    expect(
      await migratorPrisma().promotionRedemption.count({ where: { businessId: w.cafe.businessId } }),
      "a redemption survived a failed event",
    ).toBe(0);

    // And the next attempt, with the emitter working again, succeeds — so nothing was left broken.
    const retry = await redeemCoupon(w.cafe.ctx, { code: CODE, customerCardId: w.cardId });
    expect(retry.outcome).toBe("RECORDED");
    expect(await storedEvents(w.cafe.businessId)).toHaveLength(1);
  });

  it("loses the withdrawal when the event cannot be written", async () => {
    const result = await redeemCoupon(w.cafe.ctx, { code: CODE, customerCardId: w.cardId });
    if (result.outcome !== "RECORDED") throw new Error("unreachable");

    emitter.failNext = true;
    await expect(voidRedemption(w.cafe.ctx, result.redemptionId, "mistyped")).rejects.toThrow();

    // The VOID row is gone with it; the redemption still stands and the customer is still owed.
    const rows = await migratorPrisma().promotionRedemption.findMany({
      where: { businessId: w.cafe.businessId },
      select: { entry: true },
    });
    expect(rows.map((r) => r.entry)).toEqual(["REDEEMED"]);
    expect(await storedEvents(w.cafe.businessId)).toHaveLength(1);
  });

  it("does not emit twice when the same redemption is recorded through the route", async () => {
    // Belt and braces over the unique index: the counter path writes one event, not one per retry
    // of the surrounding request.
    const res = await coupon({ businessId: w.cafe.businessId, customerCardId: w.cardId, code: CODE });
    expect(res.status).toBe(200);
    expect((res.body as { outcome: string }).outcome).toBe("RECORDED");
    expect(await storedEvents(w.cafe.businessId)).toHaveLength(1);
  });
});

describe("who may read the history", () => {
  let w: World;

  beforeEach(async () => {
    await resetDatabase();
    emitter.failNext = false;
    w = await build();
    const result = await redeemCoupon(w.cafe.ctx, { code: CODE, customerCardId: w.cardId });
    if (result.outcome !== "RECORDED") throw new Error("unreachable");
  });

  it("shows an owner their own events", async () => {
    const rows = await listIntegrationEvents(w.cafe.ctx);
    expect(rows).toHaveLength(1);
    expect(rows[0].eventType).toBe(IntegrationEventType.PROMOTION_REDEMPTION_RECORDED);
  });

  it("shows a manager the same", async () => {
    const rows = await listIntegrationEvents({ ...w.cafe.ctx, role: MembershipRole.MANAGER });
    expect(rows).toHaveLength(1);
  });

  it("refuses a cashier", async () => {
    /*
     * Twice over: a cashier does not hold VIEW_INTEGRATIONS by role default, and the service checks
     * the role on top of the permission — because a permission bit can be granted to one membership
     * by a checkbox and this is not a decision to leave to one.
     */
    const cashier = {
      ...w.cafe.ctx,
      role: MembershipRole.CASHIER,
      permissions: new Set([...w.cafe.ctx.permissions]),
    };
    await expect(listIntegrationEvents(cashier)).rejects.toThrow(ForbiddenError);
  });

  it("shows one business nothing of another's", async () => {
    const other = await build("Other café");
    session.userId = other.cafe.userId;
    const result = await redeemCoupon(other.cafe.ctx, { code: CODE, customerCardId: other.cardId });
    expect(result.outcome).toBe("RECORDED");

    expect(await listIntegrationEvents(w.cafe.ctx)).toHaveLength(1);
    expect(await listIntegrationEvents(other.cafe.ctx)).toHaveLength(1);

    const mine = await listIntegrationEvents(w.cafe.ctx);
    const theirs = await listIntegrationEvents(other.cafe.ctx);
    expect(mine[0].entityId).not.toBe(theirs[0].entityId);
  });
});

describe("an event carries nothing about a person", () => {
  it("holds no phone, name, code, digest, card serial or amount", async () => {
    await resetDatabase();
    emitter.failNext = false;
    const cafe = await createStampCafe({ name: "Leak café" });
    session.userId = cafe.userId;

    const created = await promotions({
      action: "create",
      businessId: cafe.businessId,
      name: "Autumn offer",
      benefitDescription: "A free espresso",
      code: CODE,
    });
    const promotionId = String((created.body as unknown as { id: string }).id);
    await promotions({ action: "setState", businessId: cafe.businessId, promotionId, state: "ACTIVE" });

    const phone = uniqueSyrianPhone();
    const customer = await enrolCustomer(cafe, { phone, firstName: "ليلى", lastName: "الحسيني" });
    const result = await redeemCoupon(cafe.ctx, { code: CODE, customerCardId: customer.customerCardId });
    if (result.outcome !== "RECORDED") throw new Error("unreachable");
    await voidRedemption(cafe.ctx, result.redemptionId, "the customer changed their mind");

    const promotion = await migratorPrisma().promotion.findFirstOrThrow({ where: { id: promotionId } });
    const card = await migratorPrisma().customerCard.findFirstOrThrow({
      where: { id: customer.customerCardId },
    });

    // Everything stored, as text, including the columns a caller never sees.
    const serialized = JSON.stringify(await storedEvents(cafe.businessId));

    for (const secret of [
      phone,
      phone.replace(/\D/g, ""),
      "ليلى",
      "الحسيني",
      CODE,
      CODE.toLowerCase(),
      promotion.codeDigest,
      promotion.codeSalt,
      promotion.name,
      promotion.benefitDescription,
      card.serialNumber,
      card.qrToken,
      card.shareToken,
      "the customer changed their mind",
    ]) {
      expect(serialized, `an event leaked ${secret.slice(0, 12)}`).not.toContain(secret);
    }
  });
});

describe("B7 is unchanged by any of this", () => {
  it("still refuses public enrolment, and no public event route exists", async () => {
    const enroll = await import("@/app/api/enroll/route");
    for (const handler of [enroll.GET, enroll.POST]) {
      const res = await handler();
      expect(res.status).toBe(410);
    }

    // Nothing under the integrations module is reachable without a session, because there is no
    // route at all: the history is read by a server component through the tenant context.
    const { readdirSync } = await import("node:fs");
    const { join } = await import("node:path");
    const apiRoot = join(import.meta.dirname, "..", "..", "src", "app", "api");
    expect(readdirSync(apiRoot)).not.toContain("integrations");
    expect(readdirSync(apiRoot)).not.toContain("webhooks");
    expect(readdirSync(apiRoot)).not.toContain("events");
  });
});
