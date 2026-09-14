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

import { prisma } from "@/server/db";
import { codeDigest, newCodeSalt } from "@/server/promotions/codes";
import {
  createStampCafe,
  enrolCustomer,
  migratorPrisma,
  resetDatabase,
  uniqueSyrianPhone,
  type StampCafeFixture,
} from "../setup/fixtures";

/**
 * What the DATABASE refuses, with the service taken out of the picture.
 *
 * `integration-events.test.ts` proves the services write correct rows. This proves a correct row is
 * the only kind the database accepts: every insert below goes through `prisma`, the **restricted
 * runtime client**, with no service in the way — exactly as a second service, a backfill script or a
 * console session would.
 *
 * The foreign key on `businessId` checks that the business exists. Nothing in a foreign key checks
 * that the entity belongs to it, that the entity is the kind the event type claims, that the event
 * describes something that actually happened, or **when it was written**.
 *
 * That last one is why most of this file inserts inside a transaction. An event is only valid when
 * it is written in the same transaction as the thing it describes, and the rule is enforced by
 * comparing two timestamps neither side can choose — see `sameTransaction` below.
 */

/** The trigger names the rule that refused the row; the grant refuses before the trigger can. */
const REFUSED = /IntegrationEvent:/;
const REFUSED_OR_DENIED = /IntegrationEvent|permission denied|append-only/i;
/** The one the no-backfill rule raises. */
const NOT_SAME_TRANSACTION = /same transaction as the thing it describes/;

interface World {
  cafe: StampCafeFixture;
  promotionId: string;
  cardId: string;
  profileId: string;
  /** Committed in their own transactions, which is what makes them useful for the refusal tests. */
  redeemedId: string;
  voidedId: string;
}

/** `entry` is a parameter rather than part of `extra` so the compiler can see it is always set. */
function redemptionData(w: World, entry: "REDEEMED" | "VOIDED", voidsRedemptionId?: string) {
  return {
    businessId: w.cafe.businessId,
    promotionId: w.promotionId,
    entry,
    customerCardId: w.cardId,
    customerBusinessProfileId: w.profileId,
    method: "COUNTER_TYPED_CODE" as const,
    ...(voidsRedemptionId ? { voidsRedemptionId } : {}),
  };
}

/** A café with a promotion, plus one committed REDEEMED row and one committed VOIDED row. */
async function build(name: string): Promise<World> {
  const cafe = await createStampCafe({ name });
  session.userId = cafe.userId;
  const customer = await enrolCustomer(cafe, { phone: uniqueSyrianPhone(), firstName: "ليلى" });

  const salt = newCodeSalt();
  const promotion = await prisma.promotion.create({
    data: {
      businessId: cafe.businessId,
      name: `Offer for ${name}`,
      normalizedName: `offer for ${name}`.toLowerCase(),
      benefitDescription: "A free espresso",
      codeDigest: codeDigest(salt, cafe.businessId, "AUTUMN10"),
      codeSalt: salt,
    },
    select: { id: true },
  });
  await prisma.promotion.update({ where: { id: promotion.id }, data: { state: "ACTIVE" } });

  const partial: World = {
    cafe,
    promotionId: promotion.id,
    cardId: customer.customerCardId,
    profileId: customer.customerBusinessProfileId,
    redeemedId: "",
    voidedId: "",
  };

  const redeemed = await prisma.promotionRedemption.create({
    data: redemptionData(partial, "REDEEMED"),
    select: { id: true },
  });
  const voided = await prisma.promotionRedemption.create({
    data: redemptionData(partial, "VOIDED", redeemed.id),
    select: { id: true },
  });

  return { ...partial, redeemedId: redeemed.id, voidedId: voided.id };
}

/** The envelope, minus the entity — which each helper below supplies. */
function envelope(w: World, overrides: Record<string, unknown> = {}) {
  return {
    businessId: w.cafe.businessId,
    envelopeVersion: 1,
    eventType: "PROMOTION_REDEMPTION_RECORDED" as const,
    entityType: "PROMOTION_REDEMPTION" as const,
    ...overrides,
  };
}

/**
 * A redemption and its event, written in ONE transaction — the way a service does it.
 *
 * This is the only shape the database accepts, so it is the shape the positive controls have to
 * take. `overrides` breaks exactly one thing about the event; `entry` decides which kind of
 * redemption is created for it.
 */
async function sameTransaction(
  w: World,
  overrides: Record<string, unknown> = {},
  entry: "REDEEMED" | "VOIDED" = "REDEEMED",
) {
  return prisma.$transaction(async (tx) => {
    const redeemed = await tx.promotionRedemption.create({
      data: redemptionData(w, "REDEEMED"),
      select: { id: true },
    });
    const subject =
      entry === "REDEEMED"
        ? redeemed
        : await tx.promotionRedemption.create({
            data: redemptionData(w, "VOIDED", redeemed.id),
            select: { id: true },
          });

    return tx.integrationEvent.create({
      data: { ...envelope(w), entityId: subject.id, ...overrides },
      select: { id: true, occurredAt: true, entityId: true },
    });
  });
}

describe("an event has to describe something that happened", () => {
  let mine: World;
  let theirs: World;

  beforeEach(async () => {
    await resetDatabase();
    mine = await build("Integrity café");
    theirs = await build("Another café");
    session.userId = mine.cafe.userId;
  });

  it("accepts a well-formed event written with its redemption", async () => {
    // The control. Everything below is this row with one thing wrong.
    const row = await sameTransaction(mine);
    expect(row.id).toBeTruthy();
  });

  it("accepts a withdrawal event naming the void row", async () => {
    const row = await sameTransaction(mine, { eventType: "PROMOTION_REDEMPTION_VOIDED" }, "VOIDED");
    expect(row.id).toBeTruthy();
  });

  it("refuses an entity that does not exist", async () => {
    await expect(
      sameTransaction(mine, { entityId: "00000000-0000-0000-0000-000000000000" }),
    ).rejects.toThrow(REFUSED);
  });

  it("refuses another business's redemption", async () => {
    /*
     * The tenant rule, and the reason it is a trigger. A foreign key on `entityId` would have been
     * satisfied by this row: the redemption exists. What is wrong is whose it is — and an event
     * that named it would publish one merchant's activity into another's feed.
     *
     * It fails on the tenant rule rather than the same-transaction one because the trigger checks
     * them in that order, which is what keeps each refusal specific.
     */
    await expect(sameTransaction(mine, { entityId: theirs.redeemedId })).rejects.toThrow(
      /belongs to a different business/,
    );
  });

  it("refuses a recorded event that names a void row", async () => {
    await expect(sameTransaction(mine, {}, "VOIDED")).rejects.toThrow(/names a VOIDED row/);
  });

  it("refuses a withdrawal event that names a live redemption", async () => {
    await expect(sameTransaction(mine, { eventType: "PROMOTION_REDEMPTION_VOIDED" })).rejects.toThrow(
      /names a REDEEMED row/,
    );
  });

  it("refuses an envelope version nothing produces", async () => {
    // A consumer written against version 1 that meets a version 2 row should stop, not guess. A row
    // may not claim a shape no writer in this codebase can produce.
    for (const envelopeVersion of [0, 2, 99]) {
      await expect(sameTransaction(mine, { envelopeVersion }), String(envelopeVersion)).rejects.toThrow(
        /check constraint|IntegrationEvent/i,
      );
    }
  });

  it("allows only one event per entity per type", async () => {
    /*
     * What makes emission idempotent: a retry, a second service, or a backfill script that ran
     * twice all collide here rather than producing two rows a future consumer would deliver twice.
     *
     * Both inserts are in the one transaction, because a second transaction would be refused by the
     * same-transaction rule before the unique index could speak.
     */
    await expect(
      prisma.$transaction(async (tx) => {
        const row = await tx.promotionRedemption.create({
          data: redemptionData(mine, "REDEEMED"),
          select: { id: true },
        });
        await tx.integrationEvent.create({ data: { ...envelope(mine), entityId: row.id } });
        await tx.integrationEvent.create({ data: { ...envelope(mine), entityId: row.id } });
      }),
    ).rejects.toThrow(/Unique constraint|duplicate key/i);
  });
});

describe("an event is written with the action, and never backfilled", () => {
  /*
   * The gap this rule closes: everything else about a row can be correct — the redemption exists,
   * it is this business's, it is the right kind — and the event can still be a fabrication written
   * months later for a redemption that never had one.
   *
   * Both timestamps come from `now()`, which is the TRANSACTION's start time, and neither side can
   * be chosen by the caller: each is overwritten by its own trigger before anything reads it. So
   * equality means "same transaction", and a later writer cannot imitate it by supplying a matching
   * value.
   */
  let mine: World;

  beforeEach(async () => {
    await resetDatabase();
    mine = await build("Backfill café");
    session.userId = mine.cafe.userId;
  });

  it("accepts an event inserted alongside a brand-new redemption", async () => {
    const row = await sameTransaction(mine);
    const redemption = await prisma.promotionRedemption.findUniqueOrThrow({
      where: { id: row.entityId },
      select: { recordedAt: true },
    });
    // The two agree exactly, which is the property the rule reads.
    expect(row.occurredAt.getTime()).toBe(redemption.recordedAt.getTime());
  });

  it("refuses an event for a redemption committed in an earlier transaction", async () => {
    // `mine.redeemedId` was committed by `build`, in its own transaction, and has no event.
    await expect(
      prisma.integrationEvent.create({ data: { ...envelope(mine), entityId: mine.redeemedId } }),
    ).rejects.toThrow(NOT_SAME_TRANSACTION);

    // And nothing was written. A refused backfill leaves no trace to tidy up.
    expect(
      await migratorPrisma().integrationEvent.count({ where: { businessId: mine.cafe.businessId } }),
    ).toBe(0);
  });

  it("refuses a withdrawal event for a void row committed earlier", async () => {
    await expect(
      prisma.integrationEvent.create({
        data: { ...envelope(mine, { eventType: "PROMOTION_REDEMPTION_VOIDED" }), entityId: mine.voidedId },
      }),
    ).rejects.toThrow(NOT_SAME_TRANSACTION);
    expect(
      await migratorPrisma().integrationEvent.count({ where: { businessId: mine.cafe.businessId } }),
    ).toBe(0);
  });

  it("cannot be imitated by supplying the redemption's own recorded time", async () => {
    /*
     * The obvious attempt, and the reason the rule works: the supplied value is discarded before it
     * is compared. A writer that knows exactly when the redemption happened still cannot claim to
     * have been there.
     */
    const redemption = await prisma.promotionRedemption.findUniqueOrThrow({
      where: { id: mine.redeemedId },
      select: { recordedAt: true },
    });
    await expect(
      prisma.integrationEvent.create({
        data: { ...envelope(mine), entityId: mine.redeemedId, occurredAt: redemption.recordedAt },
      }),
    ).rejects.toThrow(NOT_SAME_TRANSACTION);
  });

  it("refuses one written in a later transaction even seconds afterwards", async () => {
    // Not a stale-row problem: a redemption created moments ago is still a different transaction.
    const fresh = await prisma.promotionRedemption.create({
      data: redemptionData(mine, "REDEEMED"),
      select: { id: true },
    });
    await expect(
      prisma.integrationEvent.create({ data: { ...envelope(mine), entityId: fresh.id } }),
    ).rejects.toThrow(NOT_SAME_TRANSACTION);
  });
});

describe("the moment belongs to the server", () => {
  let mine: World;

  beforeEach(async () => {
    await resetDatabase();
    mine = await build("Clock café");
    session.userId = mine.cafe.userId;
  });

  const YEAR = 365 * 24 * 60 * 60 * 1000;

  it("ignores a supplied occurrence time, in both directions", async () => {
    /*
     * Ordering is the one thing a future consumer will trust. A writer that chose `occurredAt`
     * would choose the order events are delivered in, and could place a withdrawal before the
     * redemption it withdraws.
     */
    for (const supplied of [new Date(Date.now() - YEAR), new Date(Date.now() + YEAR)]) {
      const row = await sameTransaction(mine, { occurredAt: supplied });
      expect(row.occurredAt.getTime(), String(supplied)).not.toBe(supplied.getTime());
      expect(Math.abs(row.occurredAt.getTime() - Date.now()), String(row.occurredAt)).toBeLessThan(60_000);
    }
  });
});

describe("an event is never edited or removed", () => {
  let mine: World;
  let eventId: string;

  beforeEach(async () => {
    await resetDatabase();
    mine = await build("Append café");
    session.userId = mine.cafe.userId;
    eventId = (await sameTransaction(mine)).id;
  });

  it("refuses UPDATE and DELETE from the runtime role", async () => {
    // The grant refuses first; the trigger is what would refuse somebody holding more than the app.
    await expect(
      prisma.integrationEvent.update({ where: { id: eventId }, data: { entityId: mine.voidedId } }),
    ).rejects.toThrow(REFUSED_OR_DENIED);
    await expect(prisma.integrationEvent.delete({ where: { id: eventId } })).rejects.toThrow(REFUSED_OR_DENIED);
  });

  it("refuses UPDATE, DELETE and TRUNCATE even for the table owner", async () => {
    const owner = migratorPrisma();
    await expect(
      owner.integrationEvent.update({ where: { id: eventId }, data: { envelopeVersion: 1 } }),
    ).rejects.toThrow(/append-only/i);
    await expect(owner.integrationEvent.delete({ where: { id: eventId } })).rejects.toThrow(/append-only/i);
    await expect(owner.$executeRawUnsafe('TRUNCATE TABLE "IntegrationEvent"')).rejects.toThrow(/append-only/i);
  });

  it("keeps the runtime role to SELECT and INSERT", async () => {
    /*
     * Asked as the runtime client itself, so `has_table_privilege` answers about the role the
     * services actually connect as — no role name to hard-code and get wrong.
     *
     * The grant and the trigger are two layers with different jobs. The grant stops the
     * application; the trigger stops anyone holding more than the application does, which is why
     * both are checked rather than one standing in for the other.
     */
    const [p] = await prisma.$queryRawUnsafe<Record<string, boolean>[]>(
      `SELECT has_table_privilege('"IntegrationEvent"', 'SELECT')   AS s,
              has_table_privilege('"IntegrationEvent"', 'INSERT')   AS i,
              has_table_privilege('"IntegrationEvent"', 'UPDATE')   AS u,
              has_table_privilege('"IntegrationEvent"', 'DELETE')   AS d,
              has_table_privilege('"IntegrationEvent"', 'TRUNCATE') AS t`,
    );
    expect({ ...p }).toEqual({ s: true, i: true, u: false, d: false, t: false });
  });
});

describe("the table has nowhere to put anything sensitive", () => {
  it("has no column that could hold a contact detail, a capability, a code or an amount", async () => {
    /*
     * The design, asserted rather than described. Typed columns and no JSON bag means a phone
     * number cannot be added at two in the morning by somebody debugging a delivery failure — they
     * would have to write a migration, which is a thing a person reviews.
     */
    const columns = await migratorPrisma().$queryRawUnsafe<{ column_name: string; data_type: string }[]>(
      `SELECT column_name, data_type FROM information_schema.columns
        WHERE table_name = 'IntegrationEvent' ORDER BY column_name`,
    );
    const names = columns.map((c) => c.column_name);

    expect(names).toEqual([
      "businessId",
      "createdAt",
      "entityId",
      "entityType",
      "envelopeVersion",
      "eventType",
      "id",
      "occurredAt",
    ]);

    // No JSON anywhere, so there is no untyped place for a value to appear later.
    expect(columns.map((c) => c.data_type)).not.toContain("jsonb");
    expect(columns.map((c) => c.data_type)).not.toContain("json");

    const FORBIDDEN =
      /phone|email|name|address|code|digest|salt|token|secret|key|password|payload|wallet|pass|amount|price|currency|total|balance|points|stamps|reward|url|endpoint|webhook|metadata|payment/i;
    for (const name of names) {
      expect(name, `${name} is a place something sensitive could go`).not.toMatch(FORBIDDEN);
    }
  });
});
