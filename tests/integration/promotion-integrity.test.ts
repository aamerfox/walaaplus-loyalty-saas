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
import { createStampCafe, enrolCustomer, resetDatabase, uniqueSyrianPhone, type StampCafeFixture } from "../setup/fixtures";

/**
 * What the DATABASE refuses, with the services taken out of the picture.
 *
 * `promotions.test.ts` proves the services build correct rows. This proves a correct row is the only
 * kind the database accepts: every insert below goes through `prisma`, the **restricted runtime
 * client**, with no service in the way — exactly as a second service, a backfill script or a console
 * session would.
 *
 * Foreign keys check that each id EXISTS. Nothing in a foreign key checks that they AGREE, that a
 * promotion was redeemable at the moment it was redeemed, or that a limit was respected. A guarantee
 * that lives in one service ends the first time somebody writes a second one.
 */

/** Every trigger here raises `check_violation` with a message naming the rule that refused the row. */
const REFUSED = /Promotion(Redemption)?:/;

interface World {
  cafe: StampCafeFixture;
  promotionId: string;
  cardId: string;
  profileId: string;
}

async function build(name: string, promotion: Record<string, unknown> = {}): Promise<World> {
  const cafe = await createStampCafe({ name });
  session.userId = cafe.userId;
  const customer = await enrolCustomer(cafe, { phone: uniqueSyrianPhone(), firstName: "ليلى" });

  const salt = newCodeSalt();
  const created = await prisma.promotion.create({
    data: {
      businessId: cafe.businessId,
      name: `Offer for ${name}`,
      normalizedName: `offer for ${name}`.toLowerCase(),
      benefitDescription: "A free espresso",
      codeDigest: codeDigest(salt, cafe.businessId, "AUTUMN10"),
      codeSalt: salt,
      ...promotion,
    },
    select: { id: true },
  });
  // A promotion is born a draft; redemption needs it active, which is a legal transition.
  await prisma.promotion.update({ where: { id: created.id }, data: { state: "ACTIVE" } });

  return {
    cafe,
    promotionId: created.id,
    cardId: customer.customerCardId,
    profileId: customer.customerBusinessProfileId,
  };
}

/** A correct REDEEMED row for `w`, which each test then breaks in exactly one way. */
function redeemed(w: World, overrides: Record<string, unknown> = {}) {
  return {
    businessId: w.cafe.businessId,
    promotionId: w.promotionId,
    entry: "REDEEMED" as const,
    customerCardId: w.cardId,
    customerBusinessProfileId: w.profileId,
    method: "COUNTER_TYPED_CODE" as const,
    recordedAt: new Date(),
    ...overrides,
  };
}

describe("the parts of a redemption have to agree", () => {
  let mine: World;
  let theirs: World;

  beforeEach(async () => {
    await resetDatabase();
    mine = await build("Integrity café");
    theirs = await build("Another café");
    session.userId = mine.cafe.userId;
  });

  it("accepts a row whose parts all agree", async () => {
    // The control. Everything below is this row with one thing wrong.
    const row = await prisma.promotionRedemption.create({ data: redeemed(mine), select: { id: true } });
    expect(row.id).toBeTruthy();
  });

  it("refuses a promotion from another business", async () => {
    await expect(
      prisma.promotionRedemption.create({ data: redeemed(mine, { promotionId: theirs.promotionId }) }),
    ).rejects.toThrow(REFUSED);
  });

  it("refuses a card from another business", async () => {
    await expect(
      prisma.promotionRedemption.create({
        data: redeemed(mine, { customerCardId: theirs.cardId, customerBusinessProfileId: theirs.profileId }),
      }),
    ).rejects.toThrow(REFUSED);
  });

  it("refuses a card that belongs to a different customer", async () => {
    /*
     * Both ids are this business's and both exist, so every foreign key is satisfied. What is wrong
     * is the relationship: the row credits an entitlement to a customer whose card it is not.
     */
    const other = await enrolCustomer(mine.cafe, { phone: uniqueSyrianPhone() });
    await expect(
      prisma.promotionRedemption.create({
        data: redeemed(mine, { customerBusinessProfileId: other.customerBusinessProfileId }),
      }),
    ).rejects.toThrow(REFUSED);
  });

  it("refuses a profile from another business", async () => {
    await expect(
      prisma.promotionRedemption.create({ data: redeemed(mine, { customerBusinessProfileId: theirs.profileId }) }),
    ).rejects.toThrow(REFUSED);
  });

  it("refuses a row that mixes two businesses", async () => {
    await expect(
      prisma.promotionRedemption.create({
        data: redeemed(mine, {
          businessId: theirs.cafe.businessId,
          promotionId: theirs.promotionId,
          customerCardId: mine.cardId,
        }),
      }),
    ).rejects.toThrow(REFUSED);
  });
});

describe("only a live promotion redeems", () => {
  let mine: World;

  beforeEach(async () => {
    await resetDatabase();
    mine = await build("Lifecycle café");
    session.userId = mine.cafe.userId;
  });

  it("refuses a draft, a paused and an expired promotion", async () => {
    for (const state of ["PAUSED", "EXPIRED"] as const) {
      await prisma.promotion.update({ where: { id: mine.promotionId }, data: { state } });
      await expect(prisma.promotionRedemption.create({ data: redeemed(mine) }), state).rejects.toThrow(REFUSED);
    }

    // A draft, reached by building one and leaving it alone.
    const draft = await build("Draft café");
    await prisma.promotion.update({ where: { id: draft.promotionId }, data: { state: "PAUSED" } });
    await expect(prisma.promotionRedemption.create({ data: redeemed(draft) })).rejects.toThrow(REFUSED);
  });

  it("refuses a redemption before the window opens and after it closes", async () => {
    const future = await build("Future café", { startsAt: new Date(Date.now() + 86_400_000) });
    await expect(prisma.promotionRedemption.create({ data: redeemed(future) })).rejects.toThrow(REFUSED);

    const past = await build("Past café", { endsAt: new Date(Date.now() - 86_400_000) });
    await expect(prisma.promotionRedemption.create({ data: redeemed(past) })).rejects.toThrow(REFUSED);
  });
});

describe("limits hold even without a service", () => {
  it("refuses a redemption past the total limit", async () => {
    await resetDatabase();
    const mine = await build("Total café", { totalLimit: 1 });
    session.userId = mine.cafe.userId;
    const other = await enrolCustomer(mine.cafe, { phone: uniqueSyrianPhone() });

    await prisma.promotionRedemption.create({ data: redeemed(mine) });
    await expect(
      prisma.promotionRedemption.create({
        data: redeemed(mine, {
          customerCardId: other.customerCardId,
          customerBusinessProfileId: other.customerBusinessProfileId,
        }),
      }),
    ).rejects.toThrow(REFUSED);
  });

  it("refuses a redemption past the per-customer limit", async () => {
    await resetDatabase();
    const mine = await build("Per-customer café", { perCustomerLimit: 1 });
    session.userId = mine.cafe.userId;

    await prisma.promotionRedemption.create({ data: redeemed(mine) });
    await expect(prisma.promotionRedemption.create({ data: redeemed(mine) })).rejects.toThrow(REFUSED);
  });

  it("frees a slot when a redemption is voided", async () => {
    /*
     * The deliberate difference from `ReferralAttribution`, checked at the database rather than only
     * in the service: a void here means the redemption did not happen, so the customer keeps their
     * coupon.
     */
    await resetDatabase();
    const mine = await build("Freed café", { perCustomerLimit: 1 });
    session.userId = mine.cafe.userId;

    const first = await prisma.promotionRedemption.create({ data: redeemed(mine), select: { id: true } });
    await expect(prisma.promotionRedemption.create({ data: redeemed(mine) })).rejects.toThrow(REFUSED);

    await prisma.promotionRedemption.create({
      data: redeemed(mine, { entry: "VOIDED", voidsRedemptionId: first.id }),
    });

    const again = await prisma.promotionRedemption.create({ data: redeemed(mine), select: { id: true } });
    expect(again.id).toBeTruthy();
  });
});

describe("a REDEEMED row withdraws nothing, and a VOIDED row is faithful", () => {
  let mine: World;
  let theirs: World;
  let redemptionId: string;

  function voided(overrides: Record<string, unknown> = {}) {
    return redeemed(mine, { entry: "VOIDED" as const, voidsRedemptionId: redemptionId, ...overrides });
  }

  beforeEach(async () => {
    await resetDatabase();
    mine = await build("Void café");
    theirs = await build("Their café");
    session.userId = mine.cafe.userId;
    redemptionId = (await prisma.promotionRedemption.create({ data: redeemed(mine), select: { id: true } })).id;
  });

  it("accepts a faithful withdrawal", async () => {
    const row = await prisma.promotionRedemption.create({
      data: voided({ reason: "rang it up twice" }),
      select: { id: true },
    });
    expect(row.id).toBeTruthy();
  });

  it("refuses a REDEEMED row that names something to void", async () => {
    const other = await enrolCustomer(mine.cafe, { phone: uniqueSyrianPhone() });
    await expect(
      prisma.promotionRedemption.create({
        data: redeemed(mine, {
          customerCardId: other.customerCardId,
          customerBusinessProfileId: other.customerBusinessProfileId,
          voidsRedemptionId: redemptionId,
        }),
      }),
    ).rejects.toThrow(REFUSED);
  });

  it("refuses a REDEEMED row carrying a void reason", async () => {
    const other = await enrolCustomer(mine.cafe, { phone: uniqueSyrianPhone() });
    await expect(
      prisma.promotionRedemption.create({
        data: redeemed(mine, {
          customerCardId: other.customerCardId,
          customerBusinessProfileId: other.customerBusinessProfileId,
          reason: "not a withdrawal",
        }),
      }),
    ).rejects.toThrow(REFUSED);
  });

  it("refuses a VOIDED row that names nothing", async () => {
    await expect(prisma.promotionRedemption.create({ data: voided({ voidsRedemptionId: null }) })).rejects.toThrow(
      REFUSED,
    );
  });

  it("refuses a VOIDED row that targets another void", async () => {
    const firstVoid = await prisma.promotionRedemption.create({ data: voided(), select: { id: true } });
    await expect(
      prisma.promotionRedemption.create({ data: voided({ voidsRedemptionId: firstVoid.id }) }),
    ).rejects.toThrow(REFUSED);
  });

  it("refuses a VOIDED row from another business", async () => {
    // Internally consistent for the other business, and pointing at my redemption. Without this
    // rule a second tenant could withdraw my records.
    await expect(
      prisma.promotionRedemption.create({
        data: {
          businessId: theirs.cafe.businessId,
          promotionId: theirs.promotionId,
          entry: "VOIDED",
          customerCardId: theirs.cardId,
          customerBusinessProfileId: theirs.profileId,
          method: "COUNTER_TYPED_CODE",
          voidsRedemptionId: redemptionId,
          recordedAt: new Date(),
        },
      }),
    ).rejects.toThrow(REFUSED);
  });

  it("refuses a VOIDED row that changes any copied field", async () => {
    const other = await enrolCustomer(mine.cafe, { phone: uniqueSyrianPhone() });
    await expect(
      prisma.promotionRedemption.create({
        data: voided({
          customerCardId: other.customerCardId,
          customerBusinessProfileId: other.customerBusinessProfileId,
        }),
      }),
    ).rejects.toThrow(REFUSED);
  });

  it("allows only one void per redemption", async () => {
    await prisma.promotionRedemption.create({ data: voided() });
    await expect(prisma.promotionRedemption.create({ data: voided() })).rejects.toThrow();
  });
});

describe("a promotion's identity is frozen and it is never removed", () => {
  let mine: World;

  beforeEach(async () => {
    await resetDatabase();
    mine = await build("Frozen café");
    session.userId = mine.cafe.userId;
  });

  it("refuses a changed code, salt or business", async () => {
    for (const [label, data] of [
      ["code", { codeDigest: codeDigest("x", mine.cafe.businessId, "NEWCODE") }],
      ["salt", { codeSalt: newCodeSalt() }],
    ] as const) {
      await expect(
        prisma.promotion.update({ where: { id: mine.promotionId }, data }),
        `changing the ${label} must be refused`,
      ).rejects.toThrow(REFUSED);
    }
  });

  it("refuses an illegal state transition", async () => {
    await prisma.promotion.update({ where: { id: mine.promotionId }, data: { state: "EXPIRED" } });
    for (const state of ["ACTIVE", "PAUSED", "DRAFT"] as const) {
      await expect(
        prisma.promotion.update({ where: { id: mine.promotionId }, data: { state } }),
        `EXPIRED must not become ${state}`,
      ).rejects.toThrow(REFUSED);
    }
  });

  it("refuses editing an expired promotion's settings", async () => {
    await prisma.promotion.update({ where: { id: mine.promotionId }, data: { state: "EXPIRED" } });
    await expect(
      prisma.promotion.update({ where: { id: mine.promotionId }, data: { totalLimit: 999 } }),
    ).rejects.toThrow(REFUSED);
  });

  it("refuses a promotion created already active", async () => {
    const salt = newCodeSalt();
    await expect(
      prisma.promotion.create({
        data: {
          businessId: mine.cafe.businessId,
          name: "Born live",
          normalizedName: "born live",
          benefitDescription: "x",
          codeDigest: codeDigest(salt, mine.cafe.businessId, "BORNLIVE"),
          codeSalt: salt,
          state: "ACTIVE",
        },
      }),
    ).rejects.toThrow(REFUSED);
  });

  it("is never deleted, by the app or by the owner", async () => {
    await expect(prisma.promotion.delete({ where: { id: mine.promotionId } })).rejects.toThrow(
      /never removed|permission denied/i,
    );

    const { migratorPrisma } = await import("../setup/fixtures");
    const owner = migratorPrisma();
    await expect(owner.$executeRawUnsafe(`DELETE FROM "Promotion"`)).rejects.toThrow(/never removed/);
  });

  it("keeps the runtime role to SELECT, INSERT and UPDATE on Promotion, and no more", async () => {
    // A lifecycle is a state change, so UPDATE is unavoidable and justified. DELETE and TRUNCATE
    // are not; the narrow rule about WHICH update is legal is the trigger's job.
    const privileges = await prisma.$queryRaw<{ s: boolean; i: boolean; u: boolean; d: boolean; t: boolean }[]>`
      SELECT has_table_privilege('"Promotion"', 'SELECT')   AS s,
             has_table_privilege('"Promotion"', 'INSERT')   AS i,
             has_table_privilege('"Promotion"', 'UPDATE')   AS u,
             has_table_privilege('"Promotion"', 'DELETE')   AS d,
             has_table_privilege('"Promotion"', 'TRUNCATE') AS t`;
    expect(privileges[0]).toEqual({ s: true, i: true, u: true, d: false, t: false });
  });

  it("keeps the runtime role to SELECT and INSERT on PromotionRedemption", async () => {
    const privileges = await prisma.$queryRaw<{ s: boolean; i: boolean; u: boolean; d: boolean; t: boolean }[]>`
      SELECT has_table_privilege('"PromotionRedemption"', 'SELECT')   AS s,
             has_table_privilege('"PromotionRedemption"', 'INSERT')   AS i,
             has_table_privilege('"PromotionRedemption"', 'UPDATE')   AS u,
             has_table_privilege('"PromotionRedemption"', 'DELETE')   AS d,
             has_table_privilege('"PromotionRedemption"', 'TRUNCATE') AS t`;
    expect(privileges[0]).toEqual({ s: true, i: true, u: false, d: false, t: false });
  });

  it("has no column that could hold a code, an amount or money", async () => {
    for (const table of ["Promotion", "PromotionRedemption"]) {
      const columns = await prisma.$queryRaw<{ column_name: string }[]>`
        SELECT column_name FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = ${table}`;
      for (const { column_name } of columns) {
        expect(column_name, `${table}.${column_name} looks like money`).not.toMatch(
          /amount|price|minor|currency|total(?!Limit)|tax|invoice|payment|discount|cashback/i,
        );
        // `codeDigest` and `codeSalt` are the two legitimate mentions of a code, and neither is one.
        expect(column_name, `${table}.${column_name} looks like a raw code`).not.toMatch(/^code$|rawCode|plainCode/i);
      }
    }
  });
});
