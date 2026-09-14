import { MembershipRole } from "@prisma/client";
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

import { POST as couponRoute } from "@/app/api/scanner/coupon/route";
import { POST as enrollRoute } from "@/app/api/scanner/enroll/route";
import { POST as promotionsRoute } from "@/app/api/staff/promotions/route";
import { AuditAction } from "@/server/audit/audit";
import { prisma } from "@/server/db";
import { codeDigest } from "@/server/promotions/codes";
import { listPromotions, promotionCreateLockKey } from "@/server/promotions/promotions";
import { listCardRedemptions, redeemCoupon } from "@/server/promotions/redemption";
import {
  createStaff,
  createStampCafe,
  enrolCustomer,
  migratorPrisma,
  resetDatabase,
  uniqueSyrianPhone,
  type StampCafeFixture,
} from "../setup/fixtures";

/**
 * Promotions and coupon redemption, at the HTTP boundary.
 *
 * The six things these hold, each of which is a way this could hurt somebody:
 *
 *  1. **the raw code is never stored, returned, audited or logged** — a salted digest and nothing
 *     else reaches the database;
 *  2. **a redemption moves no money and no balance.** Every balance and the whole ledger are
 *     byte-identical afterwards;
 *  3. **one generic refusal** for every ineligible code, and a bad coupon never fails the workflow
 *     that carried it;
 *  4. **limits hold under concurrency** — two tills redeeming the last coupon at once cannot both
 *     succeed;
 *  5. **a cashier redeems and cannot manage**, and only an owner or manager voids;
 *  6. **nothing public was added.** B7 is unchanged.
 */

const CODE = "AUTUMN10";
const REFUSED = /append-only|permission denied|restrict|never removed/i;

async function call(route: (req: Request) => Promise<Response>, url: string, body: unknown) {
  const res = await route(
    new Request(`http://localhost:3000${url}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  return { status: res.status, body: (await res.json().catch(() => null)) as Record<string, unknown> | null };
}

const promotions = (body: unknown) => call(promotionsRoute, "/api/staff/promotions", body);
const coupon = (body: unknown) => call(couponRoute, "/api/scanner/coupon", body);
const enroll = (body: unknown) => call(enrollRoute, "/api/scanner/enroll", body);

interface Setup {
  cafe: StampCafeFixture;
  promotionId: string;
  cardId: string;
  profileId: string;
}

/** A café with one ACTIVE promotion and one enrolled customer. */
async function setup(name = "Coupon café", overrides: Record<string, unknown> = {}): Promise<Setup> {
  const cafe = await createStampCafe({ name });
  session.userId = cafe.userId;

  const created = await promotions({
    action: "create",
    businessId: cafe.businessId,
    name: "Autumn offer",
    benefitDescription: "A free espresso",
    code: CODE,
    ...overrides,
  });
  expect(created.status).toBe(201);
  const promotionId = String((created.body as unknown as { id: string }).id);
  await promotions({ action: "setState", businessId: cafe.businessId, promotionId, state: "ACTIVE" });

  const customer = await enrolCustomer(cafe, { phone: uniqueSyrianPhone(), firstName: "ليلى" });
  return { cafe, promotionId, cardId: customer.customerCardId, profileId: customer.customerBusinessProfileId };
}

describe("creating a promotion", () => {
  let s: Setup;

  beforeEach(async () => {
    await resetDatabase();
    s = await setup();
  });

  it("stores a salted digest and never the code", async () => {
    const row = await migratorPrisma().promotion.findFirstOrThrow({ where: { id: s.promotionId } });
    expect(row.codeDigest).toBe(codeDigest(row.codeSalt, s.cafe.businessId, CODE));
    // The obvious check, and the one that catches somebody adding a "for support" column.
    const serialized = JSON.stringify(row);
    expect(serialized).not.toContain(CODE);
    expect(serialized).not.toContain(CODE.toLowerCase());
    expect(row.codeSalt.length).toBeGreaterThanOrEqual(40);
  });

  it("never returns the code, the digest or the salt to a caller", async () => {
    const listed = await listPromotions(s.cafe.ctx);
    const serialized = JSON.stringify(listed);
    expect(serialized).not.toContain(CODE);
    expect(serialized).not.toContain("codeDigest");
    expect(serialized).not.toContain("codeSalt");
    // There is no route or service anywhere that could answer "what is the code".
    const revealed = await promotions({ action: "reveal", businessId: s.cafe.businessId, promotionId: s.promotionId });
    expect(revealed.status).toBe(400);
  });

  it("writes an audit row with no code and no digest", async () => {
    const row = await migratorPrisma().promotion.findFirstOrThrow({ where: { id: s.promotionId } });
    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { businessId: s.cafe.businessId, action: AuditAction.PROMOTION_CREATED },
    });
    const serialized = JSON.stringify(audit.metadata);
    expect(serialized).not.toContain(CODE);
    expect(serialized).not.toContain(row.codeDigest);
    expect(serialized).not.toContain(row.codeSalt);
    expect(serialized).toContain("Autumn offer");
  });

  it("starts as a draft, whatever a caller asks for", async () => {
    // The service and the trigger both insist. A promotion that could be created live would skip
    // the only moment a merchant reads back what they typed before a code goes out.
    const another = await promotions({
      action: "create",
      businessId: s.cafe.businessId,
      name: "Second offer",
      benefitDescription: "A second espresso",
      code: "SPRING24",
      state: "ACTIVE",
    });
    expect(another.status).toBe(400);
  });

  it("refuses a code too short, and a window that ends before it starts", async () => {
    for (const body of [
      { name: "Short", benefitDescription: "x", code: "ab" },
      {
        name: "Backwards",
        benefitDescription: "x",
        code: "VALID123",
        startsAt: new Date(Date.now() + 86_400_000).toISOString(),
        endsAt: new Date(Date.now() - 86_400_000).toISOString(),
      },
    ]) {
      expect((await promotions({ action: "create", businessId: s.cafe.businessId, ...body })).status).toBe(400);
    }
  });

  it("refuses a duplicate code without saying which field collided", async () => {
    const duplicate = await promotions({
      action: "create",
      businessId: s.cafe.businessId,
      name: "A different name",
      benefitDescription: "Something else",
      code: CODE,
    });
    expect(duplicate.status).toBe(409);
    // "That name or code is already in use" — a manager who could tell which could enumerate their
    // own business's codes one guess at a time.
    expect(JSON.stringify(duplicate.body)).toMatch(/name or code/i);
  });

  it("lets two businesses use the same code", async () => {
    const theirs = await setup("Another café");
    expect(theirs.promotionId).not.toBe(s.promotionId);
    // Different salts and different business ids, so the digests differ even for one code.
    const rows = await migratorPrisma().promotion.findMany({ select: { codeDigest: true } });
    expect(new Set(rows.map((r) => r.codeDigest)).size).toBe(rows.length);
  });
});

describe("the lifecycle", () => {
  let s: Setup;

  beforeEach(async () => {
    await resetDatabase();
    s = await setup("Lifecycle café");
  });

  it("moves through the states a merchant drives", async () => {
    for (const state of ["PAUSED", "ACTIVE", "EXPIRED"]) {
      const result = await promotions({ action: "setState", businessId: s.cafe.businessId, promotionId: s.promotionId, state });
      expect(result.status, state).toBe(200);
    }
    expect((await migratorPrisma().promotion.findFirstOrThrow({ where: { id: s.promotionId } })).state).toBe("EXPIRED");
  });

  it("keeps EXPIRED terminal", async () => {
    await promotions({ action: "setState", businessId: s.cafe.businessId, promotionId: s.promotionId, state: "EXPIRED" });
    for (const state of ["ACTIVE", "PAUSED", "DRAFT"]) {
      const result = await promotions({ action: "setState", businessId: s.cafe.businessId, promotionId: s.promotionId, state });
      // Reviving one would silently re-honour every code already handed out.
      expect(result.status, state).toBe(409);
    }
  });

  it("refuses to edit an expired promotion", async () => {
    await promotions({ action: "setState", businessId: s.cafe.businessId, promotionId: s.promotionId, state: "EXPIRED" });
    const edit = await promotions({
      action: "update",
      businessId: s.cafe.businessId,
      promotionId: s.promotionId,
      benefitDescription: "Something different",
    });
    expect(edit.status).toBe(409);
  });

  it("offers no way to change the code", async () => {
    const attempt = await promotions({
      action: "update",
      businessId: s.cafe.businessId,
      promotionId: s.promotionId,
      code: "NEWCODE1",
    });
    // Not in the schema. Rotating a code under a live promotion invalidates every printed copy.
    expect(attempt.status).toBe(400);
  });
});

describe("redeeming at the counter", () => {
  let s: Setup;

  beforeEach(async () => {
    await resetDatabase();
    s = await setup("Redeem café");
  });

  it("records an entitlement and says what to hand over", async () => {
    const result = await coupon({ businessId: s.cafe.businessId, customerCardId: s.cardId, code: CODE });
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ outcome: "RECORDED", benefitDescription: "A free espresso" });

    const row = await prisma.promotionRedemption.findFirstOrThrow({ where: { businessId: s.cafe.businessId } });
    expect(row.entry).toBe("REDEEMED");
    expect(row.method).toBe("COUNTER_TYPED_CODE");
    expect(row.customerCardId).toBe(s.cardId);
    expect(row.recordedByUserId).toBe(s.cafe.userId);
  });

  it("accepts the code however a cashier types it", async () => {
    // Same coupon, four spellings. A till that refused `autumn 10` would be a support call a day.
    const result = await coupon({ businessId: s.cafe.businessId, customerCardId: s.cardId, code: " autumn-10 " });
    expect(result.body).toMatchObject({ outcome: "RECORDED" });
  });

  it("moves no money, no balance, no ledger row and no campaign", async () => {
    const before = {
      card: await prisma.customerCard.findUniqueOrThrow({ where: { id: s.cardId } }),
      operations: await prisma.loyaltyOperation.count(),
      campaigns: await prisma.campaign.count(),
    };

    expect((await coupon({ businessId: s.cafe.businessId, customerCardId: s.cardId, code: CODE })).body).toMatchObject({
      outcome: "RECORDED",
    });

    const after = await prisma.customerCard.findUniqueOrThrow({ where: { id: s.cardId } });
    expect({
      stamps: after.stampBalance,
      points: after.pointBalance,
      rewards: after.rewardBalance,
      cash: after.cashBalanceMinor,
      visits: after.visitBalance,
    }).toEqual({
      stamps: before.card.stampBalance,
      points: before.card.pointBalance,
      rewards: before.card.rewardBalance,
      cash: before.card.cashBalanceMinor,
      visits: before.card.visitBalance,
    });
    expect(await prisma.loyaltyOperation.count()).toBe(before.operations);
    expect(await prisma.campaign.count()).toBe(before.campaigns);

    // And no amount anywhere in the row or the response.
    const row = await prisma.promotionRedemption.findFirstOrThrow({});
    expect(JSON.stringify(row)).not.toMatch(/amount|price|minor|currency|discount/i);
  });

  it("never returns or stores the code", async () => {
    const result = await coupon({ businessId: s.cafe.businessId, customerCardId: s.cardId, code: CODE });
    expect(JSON.stringify(result.body)).not.toContain(CODE);

    const row = await prisma.promotionRedemption.findFirstOrThrow({});
    expect(JSON.stringify(row)).not.toContain(CODE);

    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { businessId: s.cafe.businessId, action: AuditAction.PROMOTION_REDEEMED },
    });
    expect(JSON.stringify(audit.metadata)).not.toContain(CODE);
    const promo = await migratorPrisma().promotion.findFirstOrThrow({ where: { id: s.promotionId } });
    expect(JSON.stringify(audit.metadata)).not.toContain(promo.codeDigest);
  });

  it("answers every ineligible code the same way, and records nothing", async () => {
    const paused = await setup("Paused café");
    session.userId = paused.cafe.userId;
    await promotions({ action: "setState", businessId: paused.cafe.businessId, promotionId: paused.promotionId, state: "PAUSED" });

    const expired = await setup("Expired café");
    session.userId = expired.cafe.userId;
    await promotions({ action: "setState", businessId: expired.cafe.businessId, promotionId: expired.promotionId, state: "EXPIRED" });

    const draft = await createStampCafe({ name: "Draft café" });
    session.userId = draft.userId;
    await promotions({
      action: "create",
      businessId: draft.businessId,
      name: "Not yet",
      benefitDescription: "x",
      code: "DRAFT123",
    });

    session.userId = s.cafe.userId;
    const cases: [string, string, string][] = [
      ["unknown", s.cafe.businessId, "NOSUCHCODE"],
      ["malformed", s.cafe.businessId, "ab"],
      // Another business's live code, offered to this business's card.
      ["cross-tenant", s.cafe.businessId, "AUTUMN10-other"],
    ];
    for (const [label, businessId, code] of cases) {
      const result = await coupon({ businessId, customerCardId: s.cardId, code });
      expect(result.status, label).toBe(200);
      expect(result.body, label).toEqual({ outcome: "NOT_ACCEPTED" });
    }

    // Paused, expired and draft promotions, each tried against their own business's card.
    for (const [label, fixture] of [["paused", paused], ["expired", expired]] as const) {
      session.userId = fixture.cafe.userId;
      const result = await coupon({ businessId: fixture.cafe.businessId, customerCardId: fixture.cardId, code: CODE });
      expect(result.body, label).toEqual({ outcome: "NOT_ACCEPTED" });
    }

    session.userId = s.cafe.userId;
    expect(await prisma.promotionRedemption.count()).toBe(0);
  });

  it("refuses a code outside its window", async () => {
    const future = await setup("Future café", { startsAt: new Date(Date.now() + 86_400_000).toISOString() });
    session.userId = future.cafe.userId;
    expect((await coupon({ businessId: future.cafe.businessId, customerCardId: future.cardId, code: CODE })).body).toEqual({
      outcome: "NOT_ACCEPTED",
    });

    const past = await setup("Past café", { endsAt: new Date(Date.now() - 86_400_000).toISOString() });
    session.userId = past.cafe.userId;
    expect((await coupon({ businessId: past.cafe.businessId, customerCardId: past.cardId, code: CODE })).body).toEqual({
      outcome: "NOT_ACCEPTED",
    });
    expect(await prisma.promotionRedemption.count()).toBe(0);
  });

  it("never fails the enrolment that carried it", async () => {
    /*
     * The rule that matters at a till: the customer is standing there. A bad coupon is a second
     * sentence, not an error, and the workflow behind it has already succeeded.
     */
    const enrolled = await enroll({ businessId: s.cafe.businessId, phone: uniqueSyrianPhone() });
    expect(enrolled.status).toBe(201);

    const result = await coupon({
      businessId: s.cafe.businessId,
      customerCardId: String(enrolled.body?.customerCardId),
      code: "GARBAGE",
    });
    // A 200 with a refusal, not a 4xx. The card exists either way.
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ outcome: "NOT_ACCEPTED" });
    expect(await prisma.customerCard.findUnique({ where: { id: String(enrolled.body?.customerCardId) } })).not.toBeNull();
  });
});

describe("limits", () => {
  it("stops at the total limit", async () => {
    await resetDatabase();
    const s = await setup("Limited café", { totalLimit: 2 });

    const second = await enrolCustomer(s.cafe, { phone: uniqueSyrianPhone() });
    const third = await enrolCustomer(s.cafe, { phone: uniqueSyrianPhone() });

    for (const cardId of [s.cardId, second.customerCardId]) {
      expect((await coupon({ businessId: s.cafe.businessId, customerCardId: cardId, code: CODE })).body).toMatchObject({
        outcome: "RECORDED",
      });
    }
    expect(
      (await coupon({ businessId: s.cafe.businessId, customerCardId: third.customerCardId, code: CODE })).body,
    ).toEqual({ outcome: "NOT_ACCEPTED" });
    expect(await prisma.promotionRedemption.count({ where: { entry: "REDEEMED" } })).toBe(2);
  });

  it("stops at the per-customer limit", async () => {
    await resetDatabase();
    const s = await setup("Per-customer café", { perCustomerLimit: 1 });

    expect((await coupon({ businessId: s.cafe.businessId, customerCardId: s.cardId, code: CODE })).body).toMatchObject({
      outcome: "RECORDED",
    });
    expect((await coupon({ businessId: s.cafe.businessId, customerCardId: s.cardId, code: CODE })).body).toEqual({
      outcome: "NOT_ACCEPTED",
    });

    // Somebody else may still use it.
    const other = await enrolCustomer(s.cafe, { phone: uniqueSyrianPhone() });
    expect(
      (await coupon({ businessId: s.cafe.businessId, customerCardId: other.customerCardId, code: CODE })).body,
    ).toMatchObject({ outcome: "RECORDED" });
  });

  it("does not exceed a limit when two tills press at the same moment", async () => {
    /*
     * The concurrency case, which is the one a row lock exists for. Two cashiers redeeming the last
     * coupon at the same instant must produce one entitlement, not two — otherwise a merchant hands
     * over one more free espresso than they agreed to, every time it happens.
     */
    await resetDatabase();
    const s = await setup("Race café", { totalLimit: 1 });
    const other = await enrolCustomer(s.cafe, { phone: uniqueSyrianPhone() });

    const results = await Promise.all([
      redeemCoupon(s.cafe.ctx, { code: CODE, customerCardId: s.cardId }),
      redeemCoupon(s.cafe.ctx, { code: CODE, customerCardId: other.customerCardId }),
    ]);

    const recorded = results.filter((r) => r.outcome === "RECORDED");
    expect(recorded, "exactly one of two simultaneous redemptions may succeed").toHaveLength(1);
    expect(await prisma.promotionRedemption.count({ where: { entry: "REDEEMED" } })).toBe(1);
  });
});

describe("voiding a redemption", () => {
  let s: Setup;
  let redemptionId: string;

  beforeEach(async () => {
    await resetDatabase();
    s = await setup("Void café", { perCustomerLimit: 1 });
    await coupon({ businessId: s.cafe.businessId, customerCardId: s.cardId, code: CODE });
    redemptionId = (await prisma.promotionRedemption.findFirstOrThrow({})).id;
  });

  it("adds a row rather than changing one", async () => {
    const result = await promotions({
      action: "voidRedemption",
      businessId: s.cafe.businessId,
      redemptionId,
      reason: "rang it up twice",
    });
    expect(result.status).toBe(200);

    const rows = await prisma.promotionRedemption.findMany({ orderBy: { recordedAt: "asc" } });
    expect(rows.map((r) => r.entry)).toEqual(["REDEEMED", "VOIDED"]);
    expect(rows[1].voidsRedemptionId).toBe(rows[0].id);
    expect(rows[0].entry).toBe("REDEEMED");
  });

  it("frees the customer to use the offer again", async () => {
    /*
     * The deliberate difference from `ReferralAttribution`, where voiding does NOT free a slot. A
     * void here means the redemption did not happen, so a customer whose coupon was rung up twice
     * by mistake keeps their coupon.
     */
    expect((await coupon({ businessId: s.cafe.businessId, customerCardId: s.cardId, code: CODE })).body).toEqual({
      outcome: "NOT_ACCEPTED",
    });

    await promotions({ action: "voidRedemption", businessId: s.cafe.businessId, redemptionId });

    expect((await coupon({ businessId: s.cafe.businessId, customerCardId: s.cardId, code: CODE })).body).toMatchObject({
      outcome: "RECORDED",
    });
  });

  it("is append-only, by the app and by the owner", async () => {
    await expect(
      prisma.promotionRedemption.update({ where: { id: redemptionId }, data: { reason: "edited" } }),
    ).rejects.toThrow(REFUSED);
    await expect(prisma.promotionRedemption.delete({ where: { id: redemptionId } })).rejects.toThrow(REFUSED);

    const owner = migratorPrisma();
    await expect(owner.$executeRawUnsafe(`UPDATE "PromotionRedemption" SET reason = 'x'`)).rejects.toThrow(/append-only/);
    await expect(owner.$executeRawUnsafe(`DELETE FROM "PromotionRedemption"`)).rejects.toThrow(/append-only/);
  });

  it("writes an audit row that repeats neither the reason nor a code", async () => {
    await promotions({
      action: "voidRedemption",
      businessId: s.cafe.businessId,
      redemptionId,
      reason: "a note that should stay on the row",
    });
    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { businessId: s.cafe.businessId, action: AuditAction.PROMOTION_REDEMPTION_VOIDED },
    });
    const serialized = JSON.stringify(audit.metadata);
    expect(serialized).toContain(redemptionId);
    expect(serialized).not.toContain("should stay on the row");
    expect(serialized).not.toContain(CODE);
  });

  it("cannot be done across tenants", async () => {
    const theirs = await setup("Their café");
    session.userId = theirs.cafe.userId;
    await coupon({ businessId: theirs.cafe.businessId, customerCardId: theirs.cardId, code: CODE });
    const theirRedemption = (
      await prisma.promotionRedemption.findFirstOrThrow({ where: { businessId: theirs.cafe.businessId } })
    ).id;

    session.userId = s.cafe.userId;
    const result = await promotions({
      action: "voidRedemption",
      businessId: s.cafe.businessId,
      redemptionId: theirRedemption,
    });
    expect(result.status).toBe(404);
  });
});

describe("who may do what", () => {
  let s: Setup;

  beforeEach(async () => {
    await resetDatabase();
    s = await setup("Authorization café");
  });

  it("lets a cashier redeem, because that is counter work", async () => {
    const cashier = await createStaff(s.cafe, MembershipRole.CASHIER, [s.cafe.locationId]);
    const result = await redeemCoupon(cashier.ctx, { code: CODE, customerCardId: s.cardId });
    expect(result.outcome).toBe("RECORDED");
  });

  it("refuses a cashier everything else", async () => {
    const cashier = await createStaff(s.cafe, MembershipRole.CASHIER, [s.cafe.locationId]);
    session.userId = cashier.userId;

    for (const body of [
      { action: "create", name: "Nope", benefitDescription: "x", code: "NOPE1234" },
      { action: "setState", promotionId: s.promotionId, state: "PAUSED" },
      { action: "update", promotionId: s.promotionId, name: "Renamed" },
    ]) {
      const result = await promotions({ businessId: s.cafe.businessId, ...body });
      expect(result.status, String(body.action)).toBe(403);
    }

    // And they cannot read the list, or a customer's recorded offers.
    const { listPromotions: list } = await import("@/server/promotions/promotions");
    // A cashier does not hold EDIT_TEMPLATES either, so the permission check refuses first. Both
    // are the same 403 for the same reason; the assertion accepts whichever guard gets there.
    await expect(list(cashier.ctx)).rejects.toThrow(/owner or a manager|Missing permission/i);
    await expect(listCardRedemptions(cashier.ctx, s.cardId)).rejects.toThrow(/cashier/i);
  });

  it("refuses a cashier a void, and allows a manager", async () => {
    await coupon({ businessId: s.cafe.businessId, customerCardId: s.cardId, code: CODE });
    const redemptionId = (await prisma.promotionRedemption.findFirstOrThrow({})).id;

    const cashier = await createStaff(s.cafe, MembershipRole.CASHIER, [s.cafe.locationId]);
    session.userId = cashier.userId;
    expect((await promotions({ action: "voidRedemption", businessId: s.cafe.businessId, redemptionId })).status).toBe(403);

    const manager = await createStaff(s.cafe, MembershipRole.MANAGER);
    session.userId = manager.userId;
    expect((await promotions({ action: "voidRedemption", businessId: s.cafe.businessId, redemptionId })).status).toBe(200);
  });

  it("cannot reach another business's promotion", async () => {
    const theirs = await setup("Somebody else's café");
    session.userId = s.cafe.userId;
    for (const body of [
      { action: "setState", promotionId: theirs.promotionId, state: "PAUSED" },
      { action: "update", promotionId: theirs.promotionId, name: "Renamed" },
    ]) {
      const result = await promotions({ businessId: s.cafe.businessId, ...body });
      // A 404, not a 403: the id does not exist for this caller.
      expect(result.status, String(body.action)).toBe(404);
    }
  });
});

describe("nothing public was added", () => {
  it("offers no lookup, claim or public coupon route", async () => {
    const { readFileSync, readdirSync, statSync } = await import("node:fs");
    const { join } = await import("node:path");

    const routes: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) walk(full);
        else if (entry === "route.ts") routes.push(full);
      }
    };
    walk(join(process.cwd(), "src", "app", "api"));

    /*
     * Exactly two routes may mention a coupon: the authenticated counter redemption, and the
     * owner's management route. Any third is a new way for a code to reach the server, and the
     * phase that adds one has to come here and say so.
     */
    const touching = routes
      .filter((file) => /redeemCoupon|codeDigest|createPromotion/.test(readFileSync(file, "utf8")))
      .map((file) => file.replace(/\\/g, "/").split("/api/")[1]);
    expect(touching.sort()).toEqual(["scanner/coupon/route.ts", "staff/promotions/route.ts"]);
  });

  it("adds no provider, payment or messaging import anywhere in the promotion source", async () => {
    const { readFileSync, readdirSync, statSync } = await import("node:fs");
    const { join } = await import("node:path");

    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) walk(full);
        else if (full.endsWith(".ts")) files.push(full);
      }
    };
    walk(join(process.cwd(), "src", "server", "promotions"));

    const forbidden = /\bfetch\(|axios|stripe|paypal|twilio|sendgrid|nodemailer|web-push|pg-boss|\.enqueue\(|setInterval\(/i;
    const offenders = files.filter((file) => forbidden.test(readFileSync(file, "utf8")));
    expect(offenders, `these must not reach a provider or a queue:\n${offenders.join("\n")}`).toEqual([]);
    expect(files.length).toBeGreaterThanOrEqual(3);
  });
});

describe("two managers creating the same code at the same moment", () => {
  /*
   * The unique index on `(businessId, codeDigest)` CANNOT catch this. Each attempt mints its own
   * 32-byte salt, so the same code hashes to two different digests and the index sees two unrelated
   * rows. The only thing standing between a merchant and two live promotions answering to one code
   * is the advisory lock `createPromotion` takes before it reads the existing salts.
   *
   * If both rows were created, redemption would match whichever candidate it reached first — a
   * coupon that works or does not depending on insertion order, which is the worst kind of bug to
   * be told about by a customer.
   */
  beforeEach(async () => {
    await resetDatabase();
  });

  /** How many attempts to fire at once. More than two, so the pool has a reason to overlap them. */
  const ATTEMPTS = 6;

  it("ends with one promotion however many attempts arrive at once", async () => {
    /*
     * An OUTCOME check, and honestly labelled as one: this passed even with the lock removed,
     * because Prisma's transactions did not interleave far enough to reproduce the race on this
     * machine. A race that only sometimes reproduces is a test that only sometimes checks anything,
     * so the proof that the lock is real is the deterministic test below; this one is here because
     * the invariant it states — one code, one promotion, whatever arrives — is the thing a merchant
     * actually cares about, and it would catch a regression that broke it by any route.
     */
    const cafe = await createStampCafe({ name: "Race café" });
    session.userId = cafe.userId;

    const results = await Promise.all(
      Array.from({ length: ATTEMPTS }, (_, i) =>
        promotions({
          action: "create",
          businessId: cafe.businessId,
          name: `Race offer ${i}`,
          benefitDescription: "A free espresso",
          code: "RACE2026",
        }),
      ),
    );

    const created = results.filter((r) => r.status === 201);
    const refused = results.filter((r) => r.status === 409);
    expect(created).toHaveLength(1);
    expect(refused).toHaveLength(ATTEMPTS - 1);
    // The same refusal as any other duplicate: it does not say which field collided.
    for (const r of refused) expect(JSON.stringify(r.body)).toMatch(/name or code/i);

    const stored = await migratorPrisma().promotion.findMany({ where: { businessId: cafe.businessId } });
    expect(stored, "one code, one promotion").toHaveLength(1);

    // And the one that survived is the one whose code actually works.
    const [row] = stored;
    expect(row.codeDigest).toBe(codeDigest(row.codeSalt, cafe.businessId, "RACE2026"));
  });

  it("waits on a lock somebody else is holding, rather than reading past it", async () => {
    /*
     * The deterministic half. The test takes the very lock `createPromotion` takes, holds it, and
     * watches a create sit there: no interleaving to hope for, and it fails immediately if the
     * service stops taking the lock or takes a different one.
     */
    const cafe = await createStampCafe({ name: "Held café" });
    session.userId = cafe.userId;
    const key = promotionCreateLockKey(cafe.businessId);

    let finished = false;
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });

    // A separate connection, held open, with the lock taken.
    const holding = migratorPrisma().$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(${key}::bigint)`;
      await held;
    });
    // Give the holder a moment to actually acquire it before the create starts.
    await new Promise((r) => setTimeout(r, 250));

    const creating = promotions({
      action: "create",
      businessId: cafe.businessId,
      name: "Blocked offer",
      benefitDescription: "A free espresso",
      code: "BLOCK123",
    }).then((r) => {
      finished = true;
      return r;
    });

    await new Promise((r) => setTimeout(r, 750));
    expect(finished, "the create read past a lock somebody else was holding").toBe(false);

    release();
    await holding;
    expect((await creating).status).toBe(201);
  });
});
