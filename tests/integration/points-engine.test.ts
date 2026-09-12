import { OperationKind, OperationSource, UnitType } from "@prisma/client";
import { beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/db";
import { ConflictError, LedgerInvariantError, NotFoundError, ValidationError } from "@/server/errors";
import {
  awardManualPoints,
  awardPurchasePoints,
  awardVisitPoints,
  getPointsCardSummary,
  redeemRewardTier,
  reversePointsOperation,
} from "@/server/points/engine";
import { awardManualStamps } from "@/server/stamp/engine";
import {
  createPointsShop,
  createStampCafe,
  enrolCustomer,
  enrolPointsCustomer,
  expectReconciled,
  resetDatabase,
  type PointsShopFixture,
} from "../setup/fixtures";

/**
 * The points lifecycle, against a real PostgreSQL.
 *
 * These tests exist because points are the first program in this codebase where the customer
 * chooses what their balance buys. Everything that follows from that — a redemption that debits a
 * configured price, a tier that may only be taken so many times, a reversal that gives the points
 * back — has no equivalent in the stamp engine and therefore no existing coverage.
 */

const key = () => `k-${Math.random().toString(36).slice(2)}-${Date.now()}`;

async function shopWithCard(opts: Parameters<typeof createPointsShop>[0] = {}) {
  const shop = await createPointsShop(opts);
  const card = await enrolPointsCustomer(shop);
  return { shop, customerCardId: card.customerCardId };
}

describe("points: earning", () => {
  beforeAll(async () => {
    await resetDatabase();
  });

  it("awards manual points and leaves stamps and rewards untouched", async () => {
    const { shop, customerCardId } = await shopWithCard();

    const result = await awardManualPoints(shop.ctx, {
      customerCardId,
      quantity: 25,
      idempotencyKey: key(),
      source: OperationSource.SCANNER,
    });

    expect(result.pointBalance).toBe(25);
    expect(result.pointsDelta).toBe(25);
    expect(result.rewardTierId).toBeNull();

    const card = await prisma.customerCard.findUniqueOrThrow({ where: { id: customerCardId } });
    expect(card.pointBalance).toBe(25);
    // A points card has no stamps and no reward balance. Not "zero because nothing happened" —
    // zero because this engine never writes those units at all.
    expect(card.stampBalance).toBe(0);
    expect(card.rewardBalance).toBe(0);
    await expectReconciled(shop.businessId);
  });

  it("earns whole blocks of spend and discards the remainder", async () => {
    const { shop, customerCardId } = await shopWithCard();

    // 25,400 minor units at 1,000 per block = 25 points. The 400 remainder is gone, not carried.
    const result = await awardPurchasePoints(shop.ctx, {
      customerCardId,
      purchaseAmountMinor: 25_400,
      idempotencyKey: key(),
      source: OperationSource.SCANNER,
    });
    expect(result.pointBalance).toBe(25);

    const again = await awardPurchasePoints(shop.ctx, {
      customerCardId,
      purchaseAmountMinor: 700,
      idempotencyKey: key(),
      source: OperationSource.SCANNER,
    }).catch((e: unknown) => e);
    // A purchase too small to complete one block earns nothing and says so, rather than writing a
    // zero-quantity row the ledger would refuse anyway.
    expect(again).toBeInstanceOf(ValidationError);

    const card = await prisma.customerCard.findUniqueOrThrow({ where: { id: customerCardId } });
    expect(card.pointBalance).toBe(25);
  });

  it("never produces a fractional point", async () => {
    // 3 points per 2,000 is the shape a merchant reaches for when they want "1.5 per 1,000".
    const { shop, customerCardId } = await shopWithCard({
      mechanics: { earnMode: "SPEND_BLOCK", spendAmountPerBlockMinor: 2_000, pointsPerBlock: 3 },
    });

    const result = await awardPurchasePoints(shop.ctx, {
      customerCardId,
      purchaseAmountMinor: 5_999,
      idempotencyKey: key(),
      source: OperationSource.SCANNER,
    });
    // floor(5999 / 2000) = 2 blocks = 6 points. Not 8.9985.
    expect(result.pointBalance).toBe(6);
    expect(Number.isInteger(result.pointBalance)).toBe(true);

    const rows = await prisma.loyaltyOperation.findMany({ where: { customerCardId }, select: { quantity: true, balanceAfter: true } });
    for (const row of rows) {
      expect(Number.isInteger(row.quantity)).toBe(true);
      expect(Number.isInteger(row.balanceAfter)).toBe(true);
    }
  });

  it("awards a fixed number of points per visit, and refuses a visit award on a spend program", async () => {
    const visitShop = await createPointsShop({
      mechanics: { earnMode: "PER_VISIT", pointsPerVisit: 7, spendAmountPerBlockMinor: undefined, pointsPerBlock: undefined },
    });
    const card = await enrolPointsCustomer(visitShop);

    const result = await awardVisitPoints(visitShop.ctx, {
      customerCardId: card.customerCardId,
      idempotencyKey: key(),
      source: OperationSource.SCANNER,
    });
    expect(result.pointBalance).toBe(7);

    const spendShop = await shopWithCard();
    await expect(
      awardVisitPoints(spendShop.shop.ctx, {
        customerCardId: spendShop.customerCardId,
        idempotencyKey: key(),
        source: OperationSource.SCANNER,
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("bounds a manual award when the program sets a ceiling", async () => {
    const { shop, customerCardId } = await shopWithCard({ mechanics: { maxPointsPerManualAward: 100 } });

    await expect(
      awardManualPoints(shop.ctx, { customerCardId, quantity: 101, idempotencyKey: key(), source: OperationSource.SCANNER }),
    ).rejects.toBeInstanceOf(ValidationError);

    const ok = await awardManualPoints(shop.ctx, {
      customerCardId,
      quantity: 100,
      idempotencyKey: key(),
      source: OperationSource.SCANNER,
    });
    expect(ok.pointBalance).toBe(100);
  });

  it("grants the welcome bonus once, on the card that was created", async () => {
    const shop = await createPointsShop({ mechanics: { welcomePoints: 5 } });
    const phone = `+9639${Date.now().toString().slice(-8)}`;

    const first = await enrolPointsCustomer(shop, { phone });
    const second = await enrolPointsCustomer(shop, { phone });

    expect(first.created).toBe(true);
    expect(first.welcomeUnitsGranted).toBe(5);
    expect(second.created).toBe(false);
    expect(second.welcomeUnitsGranted).toBe(0);
    expect(second.customerCardId).toBe(first.customerCardId);

    const card = await prisma.customerCard.findUniqueOrThrow({ where: { id: first.customerCardId } });
    expect(card.pointBalance).toBe(5);

    const bonuses = await prisma.loyaltyOperation.count({
      where: { customerCardId: first.customerCardId, kind: OperationKind.WELCOME_BONUS },
    });
    expect(bonuses).toBe(1);
    await expectReconciled(shop.businessId);
  });

  it("enforces the daily award limit by counting operations, not points", async () => {
    const { shop, customerCardId } = await shopWithCard({ mechanics: { dailyAwardLimit: 2 } });

    await awardManualPoints(shop.ctx, { customerCardId, quantity: 5, idempotencyKey: key(), source: OperationSource.SCANNER });
    await awardManualPoints(shop.ctx, { customerCardId, quantity: 5, idempotencyKey: key(), source: OperationSource.SCANNER });

    const third = await awardManualPoints(shop.ctx, {
      customerCardId,
      quantity: 5,
      idempotencyKey: key(),
      source: OperationSource.SCANNER,
    }).catch((e: unknown) => e);
    expect(third).toBeInstanceOf(ConflictError);
    expect((third as ConflictError).message).toMatch(/daily limit/i);
  });
});

describe("points: redeeming a reward tier", () => {
  let shop: PointsShopFixture;

  beforeAll(async () => {
    await resetDatabase();
    shop = await createPointsShop();
  });

  async function cardWith(points: number): Promise<string> {
    const card = await enrolPointsCustomer(shop);
    if (points > 0) {
      await awardManualPoints(shop.ctx, {
        customerCardId: card.customerCardId,
        quantity: points,
        idempotencyKey: key(),
        source: OperationSource.SCANNER,
      });
    }
    return card.customerCardId;
  }

  it("writes exactly one row: the points debit, carrying the tier", async () => {
    const customerCardId = await cardWith(30);

    const result = await redeemRewardTier(shop.ctx, {
      customerCardId,
      rewardTierId: shop.cheapTierId,
      idempotencyKey: key(),
      source: OperationSource.SCANNER,
    });

    expect(result.pointBalance).toBe(20); // 30 − 10
    expect(result.pointsDelta).toBe(-10);
    expect(result.rewardTierId).toBe(shop.cheapTierId);

    const rows = await prisma.loyaltyOperation.findMany({
      where: { transactionGroupId: result.transactionGroupId },
      select: { kind: true, unitType: true, quantity: true, rewardTierId: true, balanceAfter: true, redemptionValueMinor: true },
    });
    // One row. No +1 REWARD row (nothing to hold) and no STAMP_CONVERTED row (nothing converted).
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: OperationKind.REWARD_REDEEMED,
      unitType: UnitType.POINT,
      quantity: -10,
      rewardTierId: shop.cheapTierId,
      balanceAfter: 20,
      redemptionValueMinor: 5_000,
    });

    const card = await prisma.customerCard.findUniqueOrThrow({ where: { id: customerCardId } });
    expect(card.rewardBalance).toBe(0);
    await expectReconciled(shop.businessId);
  });

  it("refuses a redemption the card cannot afford, and writes nothing", async () => {
    const customerCardId = await cardWith(9);
    const before = await prisma.loyaltyOperation.count({ where: { customerCardId } });

    const failed = await redeemRewardTier(shop.ctx, {
      customerCardId,
      rewardTierId: shop.cheapTierId,
      idempotencyKey: key(),
      source: OperationSource.SCANNER,
    }).catch((e: unknown) => e);

    expect(failed).toBeInstanceOf(ConflictError);
    expect(await prisma.loyaltyOperation.count({ where: { customerCardId } })).toBe(before);
    const card = await prisma.customerCard.findUniqueOrThrow({ where: { id: customerCardId } });
    expect(card.pointBalance).toBe(9);
  });

  it("honours a tier's per-card usage limit, and a reversal frees a use", async () => {
    const limited = await createPointsShop({
      existing: { userId: shop.userId, businessId: shop.businessId, locationId: shop.locationId },
      name: "Limited rewards",
      tiers: [{ name: "مرة واحدة", requiredPoints: 10, usageLimit: 1 }],
    });
    const card = await enrolPointsCustomer(limited);
    await awardManualPoints(limited.ctx, {
      customerCardId: card.customerCardId,
      quantity: 40,
      idempotencyKey: key(),
      source: OperationSource.SCANNER,
    });

    const first = await redeemRewardTier(limited.ctx, {
      customerCardId: card.customerCardId,
      rewardTierId: limited.cheapTierId,
      idempotencyKey: key(),
      source: OperationSource.SCANNER,
    });

    await expect(
      redeemRewardTier(limited.ctx, {
        customerCardId: card.customerCardId,
        rewardTierId: limited.cheapTierId,
        idempotencyKey: key(),
        source: OperationSource.SCANNER,
      }),
    ).rejects.toBeInstanceOf(ConflictError);

    // Undo the first one: the customer never received the reward, so the use comes back with the
    // points. A limit that counted reversed redemptions would punish the merchant's own correction.
    await reversePointsOperation(limited.ctx, {
      transactionGroupId: first.transactionGroupId,
      reason: "wrong reward handed over",
      idempotencyKey: key(),
      source: OperationSource.SCANNER,
    });

    const retry = await redeemRewardTier(limited.ctx, {
      customerCardId: card.customerCardId,
      rewardTierId: limited.cheapTierId,
      idempotencyKey: key(),
      source: OperationSource.SCANNER,
    });
    expect(retry.rewardTierId).toBe(limited.cheapTierId);
    await expectReconciled(limited.businessId);
  });

  it("refuses a tier belonging to another program, and one belonging to another business", async () => {
    const customerCardId = await cardWith(100);

    const otherProgram = await createPointsShop({
      existing: { userId: shop.userId, businessId: shop.businessId, locationId: shop.locationId },
      name: "Another points card",
    });
    const rival = await createPointsShop({ name: "Rival" });

    for (const foreignTier of [otherProgram.cheapTierId, rival.cheapTierId]) {
      await expect(
        redeemRewardTier(shop.ctx, {
          customerCardId,
          rewardTierId: foreignTier,
          idempotencyKey: key(),
          source: OperationSource.SCANNER,
        }),
      ).rejects.toBeInstanceOf(NotFoundError);
    }

    const card = await prisma.customerCard.findUniqueOrThrow({ where: { id: customerCardId } });
    expect(card.pointBalance).toBe(100);
  });

  it("replays a retried redemption instead of charging twice", async () => {
    const customerCardId = await cardWith(30);
    const idempotencyKey = key();

    const first = await redeemRewardTier(shop.ctx, {
      customerCardId,
      rewardTierId: shop.cheapTierId,
      idempotencyKey,
      source: OperationSource.SCANNER,
    });
    const retry = await redeemRewardTier(shop.ctx, {
      customerCardId,
      rewardTierId: shop.cheapTierId,
      idempotencyKey,
      source: OperationSource.SCANNER,
    });

    expect(retry.transactionGroupId).toBe(first.transactionGroupId);
    expect(retry.pointBalance).toBe(20);
    expect(await prisma.loyaltyOperation.count({ where: { customerCardId, kind: OperationKind.REWARD_REDEEMED } })).toBe(1);
  });

  it("lets exactly one of two concurrent redemptions win when only one is affordable", async () => {
    const customerCardId = await cardWith(10);

    const results = await Promise.allSettled([
      redeemRewardTier(shop.ctx, { customerCardId, rewardTierId: shop.cheapTierId, idempotencyKey: key(), source: OperationSource.SCANNER }),
      redeemRewardTier(shop.ctx, { customerCardId, rewardTierId: shop.cheapTierId, idempotencyKey: key(), source: OperationSource.SCANNER }),
    ]);

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const card = await prisma.customerCard.findUniqueOrThrow({ where: { id: customerCardId } });
    expect(card.pointBalance).toBe(0);
    expect(await prisma.loyaltyOperation.count({ where: { customerCardId, kind: OperationKind.REWARD_REDEEMED } })).toBe(1);
    await expectReconciled(shop.businessId);
  });

  it("shows a staff screen which tiers the card can afford", async () => {
    const customerCardId = await cardWith(12);
    const summary = await getPointsCardSummary(shop.ctx, customerCardId);

    expect(summary.pointBalance).toBe(12);
    expect(summary.tiers.map((t) => t.affordable)).toEqual([true, false]);
    expect(summary.tiers[0].requiredPoints).toBeLessThan(summary.tiers[1].requiredPoints);
  });
});

describe("points: reversal", () => {
  let shop: PointsShopFixture;

  beforeAll(async () => {
    await resetDatabase();
    shop = await createPointsShop();
  });

  it("gives the points back and cannot be applied twice", async () => {
    const card = await enrolPointsCustomer(shop);
    const award = await awardManualPoints(shop.ctx, {
      customerCardId: card.customerCardId,
      quantity: 40,
      idempotencyKey: key(),
      source: OperationSource.SCANNER,
    });

    const reversal = await reversePointsOperation(shop.ctx, {
      transactionGroupId: award.transactionGroupId,
      reason: "rang up the wrong customer",
      idempotencyKey: key(),
      source: OperationSource.SCANNER,
    });
    expect(reversal.pointBalance).toBe(0);
    expect(reversal.pointsDelta).toBe(-40);

    await expect(
      reversePointsOperation(shop.ctx, {
        transactionGroupId: award.transactionGroupId,
        reason: "again",
        idempotencyKey: key(),
        source: OperationSource.SCANNER,
      }),
    ).rejects.toBeInstanceOf(ConflictError);

    // Nothing was mutated: the original row is still there, and the correction is a new row.
    const rows = await prisma.loyaltyOperation.findMany({
      where: { customerCardId: card.customerCardId },
      orderBy: { createdAt: "asc" },
      select: { kind: true, quantity: true, reversalOfOperationId: true },
    });
    expect(rows.filter((r) => r.kind === OperationKind.MANUAL_AWARD)).toHaveLength(1);
    expect(rows.filter((r) => r.kind === OperationKind.REVERSAL)).toHaveLength(1);
    await expectReconciled(shop.businessId);
  });

  it("restores the points a redemption spent", async () => {
    const card = await enrolPointsCustomer(shop);
    await awardManualPoints(shop.ctx, {
      customerCardId: card.customerCardId,
      quantity: 30,
      idempotencyKey: key(),
      source: OperationSource.SCANNER,
    });
    const redemption = await redeemRewardTier(shop.ctx, {
      customerCardId: card.customerCardId,
      rewardTierId: shop.cheapTierId,
      idempotencyKey: key(),
      source: OperationSource.SCANNER,
    });
    expect(redemption.pointBalance).toBe(20);

    const reversal = await reversePointsOperation(shop.ctx, {
      transactionGroupId: redemption.transactionGroupId,
      reason: "reward was out of stock",
      idempotencyKey: key(),
      source: OperationSource.SCANNER,
    });
    expect(reversal.pointBalance).toBe(30);
    expect(reversal.rewardTierId).toBe(shop.cheapTierId);
    await expectReconciled(shop.businessId);
  });

  it("refuses to reverse an award whose points have since been spent", async () => {
    const card = await enrolPointsCustomer(shop);
    const award = await awardManualPoints(shop.ctx, {
      customerCardId: card.customerCardId,
      quantity: 10,
      idempotencyKey: key(),
      source: OperationSource.SCANNER,
    });
    await redeemRewardTier(shop.ctx, {
      customerCardId: card.customerCardId,
      rewardTierId: shop.cheapTierId,
      idempotencyKey: key(),
      source: OperationSource.SCANNER,
    });

    // Taking the award back would push the balance below zero, which the ledger refuses. The error
    // says to correct it manually rather than leaving a negative balance on a customer's card.
    const failed = await reversePointsOperation(shop.ctx, {
      transactionGroupId: award.transactionGroupId,
      reason: "too late",
      idempotencyKey: key(),
      source: OperationSource.SCANNER,
    }).catch((e: unknown) => e);
    expect(failed).toBeInstanceOf(LedgerInvariantError);
    await expectReconciled(shop.businessId);
  });
});

describe("points and stamps cannot reach each other", () => {
  beforeAll(async () => {
    await resetDatabase();
  });

  it("refuses a stamp card handed to the points engine", async () => {
    const cafe = await createStampCafe();
    const card = await enrolCustomer(cafe);

    for (const attempt of [
      () => awardManualPoints(cafe.ctx, { customerCardId: card.customerCardId, quantity: 5, idempotencyKey: key(), source: OperationSource.SCANNER }),
      () => getPointsCardSummary(cafe.ctx, card.customerCardId),
    ]) {
      await expect(attempt()).rejects.toBeInstanceOf(LedgerInvariantError);
    }

    const after = await prisma.customerCard.findUniqueOrThrow({ where: { id: card.customerCardId } });
    expect(after.pointBalance).toBe(0);
    expect(after.stampBalance).toBe(0);
  });

  it("refuses a points card handed to the stamp engine", async () => {
    const shop = await createPointsShop();
    const card = await enrolPointsCustomer(shop);

    await expect(
      awardManualStamps(shop.ctx, {
        customerCardId: card.customerCardId,
        quantity: 1,
        idempotencyKey: key(),
        source: OperationSource.SCANNER,
      }),
    ).rejects.toBeInstanceOf(LedgerInvariantError);

    const after = await prisma.customerCard.findUniqueOrThrow({ where: { id: card.customerCardId } });
    expect(after.stampBalance).toBe(0);
    expect(after.pointBalance).toBe(0);
  });

  it("keeps two programs of one business completely separate on one customer", async () => {
    const cafe = await createStampCafe({ name: "Coffee stamps" });
    const shop = await createPointsShop({
      existing: { userId: cafe.userId, businessId: cafe.businessId, locationId: cafe.locationId },
      name: "Shop points",
    });

    const phone = `+9639${Date.now().toString().slice(-8)}`;
    const stampCard = await enrolCustomer(cafe, { phone });
    const pointsCard = await enrolPointsCustomer(shop, { phone });

    // One person, one profile, two cards — one per program, never two on one.
    expect(pointsCard.customerCardId).not.toBe(stampCard.customerCardId);
    expect(pointsCard.customerBusinessProfileId).toBe(stampCard.customerBusinessProfileId);

    await awardManualStamps(cafe.ctx, {
      customerCardId: stampCard.customerCardId,
      quantity: 3,
      idempotencyKey: key(),
      source: OperationSource.SCANNER,
    });
    await awardManualPoints(shop.ctx, {
      customerCardId: pointsCard.customerCardId,
      quantity: 60,
      idempotencyKey: key(),
      source: OperationSource.SCANNER,
    });

    const stamps = await prisma.customerCard.findUniqueOrThrow({ where: { id: stampCard.customerCardId } });
    const points = await prisma.customerCard.findUniqueOrThrow({ where: { id: pointsCard.customerCardId } });
    expect(stamps.stampBalance).toBe(3);
    expect(stamps.pointBalance).toBe(0);
    expect(points.pointBalance).toBe(60);
    expect(points.stampBalance).toBe(0);
    await expectReconciled(cafe.businessId);
  });
});
