/**
 * Phase 1a — the stamp engine, against real PostgreSQL.
 *
 * Everything here is about value that a customer will argue about at a counter: how many stamps
 * they have, whether the free coffee appeared, and whether tapping twice took it away twice.
 */
import { randomUUID } from "node:crypto";
import { CardStatus, OperationKind, OperationSource, UnitType } from "@prisma/client";
import { beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/db";
import { ConflictError, IdempotencyConflictError, NotFoundError, ValidationError } from "@/server/errors";
import {
  awardManualStamps,
  awardPurchaseStamps,
  awardVisitStamp,
  getCardBalances,
  redeemReward,
  reverseStampOperation,
} from "@/server/stamp/engine";
import {
  createStampCafe,
  enrolCustomer,
  expectReconciled,
  ownerCtx,
  resetDatabase,
  type StampCafeFixture,
} from "../setup/fixtures";

const key = () => `k-${randomUUID()}`;

/** A fresh enrolled card on the given café. */
async function freshCard(cafe: StampCafeFixture): Promise<string> {
  const enrolment = await enrolCustomer(cafe);
  return enrolment.customerCardId;
}

describe("stamp engine", () => {
  /** Manual earning, 10 stamps per reward. */
  let cafe: StampCafeFixture;
  /** Spend blocks: 1 stamp per 10,000 minor units. */
  let spendCafe: StampCafeFixture;
  /** One stamp per visit. */
  let visitCafe: StampCafeFixture;

  beforeAll(async () => {
    await resetDatabase();
    cafe = await createStampCafe({ mechanics: { stampsRequiredPerReward: 10, rewardValueMinor: 15_000 } });
    spendCafe = await createStampCafe({
      mechanics: {
        stampsRequiredPerReward: 10,
        earnMode: "SPEND_BLOCK",
        spendAmountPerBlockMinor: 10_000,
        stampsPerBlock: 1,
      },
    });
    visitCafe = await createStampCafe({ mechanics: { stampsRequiredPerReward: 3, earnMode: "PER_VISIT" } });
  });

  describe("manual award", () => {
    it("writes one row, updates the projection and counts as a visit", async () => {
      const cardId = await freshCard(cafe);
      const result = await awardManualStamps(cafe.ctx, {
        customerCardId: cardId,
        quantity: 3,
        idempotencyKey: key(),
        source: OperationSource.SCANNER,
        comment: "morning rush",
      });

      expect(result.stampBalance).toBe(3);
      expect(result.rewardBalance).toBe(0);
      expect(result.rewardsEarned).toBe(0);
      expect(result.stampsToNextReward).toBe(7);

      const rows = await prisma.loyaltyOperation.findMany({ where: { customerCardId: cardId } });
      expect(rows).toHaveLength(1);
      expect(rows[0].kind).toBe(OperationKind.MANUAL_AWARD);
      expect(rows[0].quantity).toBe(3);
      expect(rows[0].balanceAfter).toBe(3);
      expect(rows[0].countsAsVisit).toBe(true); // staff-initiated (PRODUCT-SPEC §5.4)
      expect(rows[0].performedByUserId).toBe(cafe.userId);
      expect(rows[0].locationId).toBe(cafe.locationId);
      expect(rows[0].comment).toBe("morning rush");
      await expectReconciled(cafe.businessId);
    });

    it("refuses a zero, negative or fractional quantity", async () => {
      const cardId = await freshCard(cafe);
      for (const quantity of [0, -1, 2.5]) {
        await expect(
          awardManualStamps(cafe.ctx, { customerCardId: cardId, quantity, idempotencyKey: key(), source: OperationSource.SCANNER }),
        ).rejects.toBeInstanceOf(ValidationError);
      }
      expect(await prisma.loyaltyOperation.count({ where: { customerCardId: cardId } })).toBe(0);
    });

    it("refuses money that is not integer minor units", async () => {
      const cardId = await freshCard(cafe);
      for (const purchaseAmountMinor of [10.5, -100]) {
        await expect(
          awardManualStamps(cafe.ctx, {
            customerCardId: cardId,
            quantity: 1,
            purchaseAmountMinor,
            idempotencyKey: key(),
            source: OperationSource.SCANNER,
          }),
        ).rejects.toBeInstanceOf(ValidationError);
      }
    });
  });

  describe("stamp-to-reward conversion", () => {
    it("converts immediately in one atomic group and carries the remainder", async () => {
      const cardId = await freshCard(cafe);
      await awardManualStamps(cafe.ctx, { customerCardId: cardId, quantity: 8, idempotencyKey: key(), source: OperationSource.SCANNER });

      const result = await awardManualStamps(cafe.ctx, {
        customerCardId: cardId,
        quantity: 5,
        idempotencyKey: key(),
        source: OperationSource.SCANNER,
      });

      // 8 + 5 = 13 → one reward, three stamps carried forward (PRODUCT-SPEC §5.3).
      expect(result.rewardsEarned).toBe(1);
      expect(result.stampBalance).toBe(3);
      expect(result.rewardBalance).toBe(1);

      const group = await prisma.loyaltyOperation.findMany({
        where: { transactionGroupId: result.transactionGroupId },
        orderBy: { createdAt: "asc" },
      });
      expect(group).toHaveLength(3);
      expect(group.map((r) => r.kind)).toEqual([
        OperationKind.MANUAL_AWARD,
        OperationKind.STAMP_CONVERTED,
        OperationKind.REWARD_EARNED,
      ]);
      expect(group.map((r) => r.quantity)).toEqual([5, -10, 1]);
      expect(group.map((r) => r.balanceAfter)).toEqual([13, 3, 1]);
      // One group: the award, the conversion and the reward commit together or not at all.
      expect(new Set(group.map((r) => r.transactionGroupId)).size).toBe(1);
      // Only the award is a visit; the conversion and the reward are consequences of it.
      expect(group.map((r) => r.countsAsVisit)).toEqual([true, false, false]);
      expect(group[2].rewardTierId).toBe(cafe.program.rewardTierId);
      await expectReconciled(cafe.businessId);
    });

    it("completes several rewards from one large award", async () => {
      const cardId = await freshCard(cafe);
      const result = await awardManualStamps(cafe.ctx, {
        customerCardId: cardId,
        quantity: 25,
        idempotencyKey: key(),
        source: OperationSource.SCANNER,
      });

      expect(result.rewardsEarned).toBe(2);
      expect(result.rewardBalance).toBe(2);
      expect(result.stampBalance).toBe(5);

      const group = await prisma.loyaltyOperation.findMany({ where: { transactionGroupId: result.transactionGroupId } });
      expect(group).toHaveLength(3);
      expect(group.find((r) => r.kind === OperationKind.STAMP_CONVERTED)!.quantity).toBe(-20);
      expect(group.find((r) => r.kind === OperationKind.REWARD_EARNED)!.quantity).toBe(2);
      await expectReconciled(cafe.businessId);
    });

    it("lands exactly on the threshold with nothing left over", async () => {
      const cardId = await freshCard(cafe);
      const result = await awardManualStamps(cafe.ctx, {
        customerCardId: cardId,
        quantity: 10,
        idempotencyKey: key(),
        source: OperationSource.SCANNER,
      });
      expect(result.stampBalance).toBe(0);
      expect(result.rewardBalance).toBe(1);
      expect(result.stampsToNextReward).toBe(10);
    });
  });

  describe("visit award", () => {
    it("grants exactly one stamp per visit", async () => {
      const cardId = await freshCard(visitCafe);
      const first = await awardVisitStamp(visitCafe.ctx, {
        customerCardId: cardId,
        idempotencyKey: key(),
        source: OperationSource.SCANNER,
      });
      expect(first.stampsAwarded).toBe(1);
      expect(first.stampBalance).toBe(1);

      const second = await awardVisitStamp(visitCafe.ctx, {
        customerCardId: cardId,
        idempotencyKey: key(),
        source: OperationSource.SCANNER,
      });
      const third = await awardVisitStamp(visitCafe.ctx, {
        customerCardId: cardId,
        idempotencyKey: key(),
        source: OperationSource.SCANNER,
      });
      expect(second.stampBalance).toBe(2);
      // Threshold is 3 here: the third visit completes the reward.
      expect(third.rewardsEarned).toBe(1);
      expect(third.rewardBalance).toBe(1);
      expect(third.stampBalance).toBe(0);
      await expectReconciled(visitCafe.businessId);
    });

    it("is refused on a program that does not earn per visit", async () => {
      const cardId = await freshCard(cafe);
      await expect(
        awardVisitStamp(cafe.ctx, { customerCardId: cardId, idempotencyKey: key(), source: OperationSource.SCANNER }),
      ).rejects.toThrow(/PER_VISIT/);
    });
  });

  describe("purchase award", () => {
    it("floors to whole blocks and discards the remainder", async () => {
      const cardId = await freshCard(spendCafe);
      const result = await awardPurchaseStamps(spendCafe.ctx, {
        customerCardId: cardId,
        purchaseAmountMinor: 25_000,
        idempotencyKey: key(),
        source: OperationSource.SCANNER,
      });

      expect(result.stampsAwarded).toBe(2); // 25,000 / 10,000 = 2 whole blocks
      expect(result.stampBalance).toBe(2);
      const row = await prisma.loyaltyOperation.findFirstOrThrow({ where: { transactionGroupId: result.transactionGroupId } });
      expect(row.kind).toBe(OperationKind.PURCHASE_AWARD);
      expect(row.purchaseAmountMinor).toBe(25_000);
    });

    it("does not carry the remainder into the next purchase", async () => {
      const cardId = await freshCard(spendCafe);
      // 5,000 + 5,000 is not 10,000: each purchase is floored on its own (PRODUCT-SPEC §5.5).
      for (const amount of [5_000, 5_000]) {
        await expect(
          awardPurchaseStamps(spendCafe.ctx, {
            customerCardId: cardId,
            purchaseAmountMinor: amount,
            idempotencyKey: key(),
            source: OperationSource.SCANNER,
          }),
        ).rejects.toThrow(/does not complete a block/);
      }
      const card = await prisma.customerCard.findUniqueOrThrow({ where: { id: cardId } });
      expect(card.stampBalance).toBe(0);
      expect(await prisma.loyaltyOperation.count({ where: { customerCardId: cardId } })).toBe(0);
    });

    it("crosses the threshold from one big purchase", async () => {
      const cardId = await freshCard(spendCafe);
      const result = await awardPurchaseStamps(spendCafe.ctx, {
        customerCardId: cardId,
        purchaseAmountMinor: 125_000,
        idempotencyKey: key(),
        source: OperationSource.SCANNER,
      });
      expect(result.stampsAwarded).toBe(12);
      expect(result.rewardsEarned).toBe(1);
      expect(result.stampBalance).toBe(2);
      await expectReconciled(spendCafe.businessId);
    });

    it("is refused on a program that does not earn by spend", async () => {
      const cardId = await freshCard(cafe);
      await expect(
        awardPurchaseStamps(cafe.ctx, {
          customerCardId: cardId,
          purchaseAmountMinor: 10_000,
          idempotencyKey: key(),
          source: OperationSource.SCANNER,
        }),
      ).rejects.toThrow(/SPEND_BLOCK/);
    });

    it("refuses money that is not integer minor units", async () => {
      const cardId = await freshCard(spendCafe);
      for (const purchaseAmountMinor of [10_000.5, -10_000]) {
        await expect(
          awardPurchaseStamps(spendCafe.ctx, {
            customerCardId: cardId,
            purchaseAmountMinor,
            idempotencyKey: key(),
            source: OperationSource.SCANNER,
          }),
        ).rejects.toBeInstanceOf(ValidationError);
      }
    });
  });

  describe("a program that requires the purchase amount", () => {
    it("refuses an award that omits it", async () => {
      const strict = await createStampCafe({ mechanics: { stampsRequiredPerReward: 10, requirePurchaseAmount: true } });
      const cardId = await freshCard(strict);

      await expect(
        awardManualStamps(strict.ctx, {
          customerCardId: cardId,
          quantity: 1,
          idempotencyKey: key(),
          source: OperationSource.SCANNER,
        }),
      ).rejects.toThrow(/requires the purchase amount/);

      const ok = await awardManualStamps(strict.ctx, {
        customerCardId: cardId,
        quantity: 1,
        purchaseAmountMinor: 7_500,
        idempotencyKey: key(),
        source: OperationSource.SCANNER,
      });
      expect(ok.stampBalance).toBe(1);
    });
  });

  describe("redemption", () => {
    it("decrements the reward balance and never touches stamps", async () => {
      const cardId = await freshCard(cafe);
      await awardManualStamps(cafe.ctx, { customerCardId: cardId, quantity: 13, idempotencyKey: key(), source: OperationSource.SCANNER });

      const result = await redeemReward(cafe.ctx, {
        customerCardId: cardId,
        idempotencyKey: key(),
        source: OperationSource.SCANNER,
        comment: "free latte",
      });

      expect(result.rewardBalance).toBe(0);
      expect(result.stampBalance).toBe(3); // untouched by the redemption
      expect(result.rewardsEarned).toBe(0);

      const row = await prisma.loyaltyOperation.findFirstOrThrow({ where: { transactionGroupId: result.transactionGroupId } });
      expect(row.kind).toBe(OperationKind.REWARD_REDEEMED);
      expect(row.unitType).toBe(UnitType.REWARD);
      expect(row.quantity).toBe(-1);
      expect(row.rewardTierId).toBe(cafe.program.rewardTierId);
      expect(row.redemptionValueMinor).toBe(15_000); // what it cost the merchant
      expect(row.countsAsVisit).toBe(false); // this program says a redemption is not a visit
      await expectReconciled(cafe.businessId);
    });

    it("follows the program version when it says a redemption IS a visit", async () => {
      const visitOnRedeem = await createStampCafe({
        mechanics: { stampsRequiredPerReward: 2, countRewardRedemptionAsVisit: true },
      });
      const cardId = await freshCard(visitOnRedeem);
      await awardManualStamps(visitOnRedeem.ctx, {
        customerCardId: cardId,
        quantity: 2,
        idempotencyKey: key(),
        source: OperationSource.SCANNER,
      });
      const result = await redeemReward(visitOnRedeem.ctx, {
        customerCardId: cardId,
        idempotencyKey: key(),
        source: OperationSource.SCANNER,
      });
      const row = await prisma.loyaltyOperation.findFirstOrThrow({ where: { transactionGroupId: result.transactionGroupId } });
      expect(row.countsAsVisit).toBe(true);
    });

    it("refuses when there is no reward to give", async () => {
      const cardId = await freshCard(cafe);
      await awardManualStamps(cafe.ctx, { customerCardId: cardId, quantity: 5, idempotencyKey: key(), source: OperationSource.SCANNER });
      await expect(
        redeemReward(cafe.ctx, { customerCardId: cardId, idempotencyKey: key(), source: OperationSource.SCANNER }),
      ).rejects.toBeInstanceOf(ConflictError);
      // The refusal wrote nothing at all.
      const card = await prisma.customerCard.findUniqueOrThrow({ where: { id: cardId } });
      expect(card.stampBalance).toBe(5);
      expect(card.rewardBalance).toBe(0);
      await expectReconciled(cafe.businessId);
    });
  });

  describe("reversal", () => {
    it("undoes a whole group with compensating rows", async () => {
      const cardId = await freshCard(cafe);
      const award = await awardManualStamps(cafe.ctx, {
        customerCardId: cardId,
        quantity: 4,
        idempotencyKey: key(),
        source: OperationSource.SCANNER,
      });

      const reversal = await reverseStampOperation(cafe.ctx, {
        transactionGroupId: award.transactionGroupId,
        reason: "cashier tapped twice",
        idempotencyKey: key(),
        source: OperationSource.DASHBOARD,
      });

      expect(reversal.stampBalance).toBe(0);
      expect(reversal.transactionGroupId).not.toBe(award.transactionGroupId);

      // The original rows are still there: history is never deleted or edited.
      expect(await prisma.loyaltyOperation.count({ where: { transactionGroupId: award.transactionGroupId } })).toBe(1);
      const compensating = await prisma.loyaltyOperation.findMany({ where: { transactionGroupId: reversal.transactionGroupId } });
      expect(compensating).toHaveLength(1);
      expect(compensating[0].kind).toBe(OperationKind.REVERSAL);
      expect(compensating[0].quantity).toBe(-4);
      expect(compensating[0].reason).toBe("cashier tapped twice");
      await expectReconciled(cafe.businessId);
    });

    it("undoes a conversion group as a whole, taking the reward back", async () => {
      const cardId = await freshCard(cafe);
      const award = await awardManualStamps(cafe.ctx, {
        customerCardId: cardId,
        quantity: 12,
        idempotencyKey: key(),
        source: OperationSource.SCANNER,
      });
      expect(award.rewardBalance).toBe(1);

      const reversal = await reverseStampOperation(cafe.ctx, {
        transactionGroupId: award.transactionGroupId,
        reason: "wrong customer",
        idempotencyKey: key(),
        source: OperationSource.DASHBOARD,
      });
      expect(reversal.stampBalance).toBe(0);
      expect(reversal.rewardBalance).toBe(0);
      expect(await prisma.loyaltyOperation.count({ where: { transactionGroupId: reversal.transactionGroupId } })).toBe(3);
      await expectReconciled(cafe.businessId);
    });

    it("refuses to un-earn a reward that has already been redeemed", async () => {
      const cardId = await freshCard(cafe);
      const award = await awardManualStamps(cafe.ctx, {
        customerCardId: cardId,
        quantity: 10,
        idempotencyKey: key(),
        source: OperationSource.SCANNER,
      });
      await redeemReward(cafe.ctx, { customerCardId: cardId, idempotencyKey: key(), source: OperationSource.SCANNER });

      await expect(
        reverseStampOperation(cafe.ctx, {
          transactionGroupId: award.transactionGroupId,
          reason: "too late",
          idempotencyKey: key(),
          source: OperationSource.DASHBOARD,
        }),
      ).rejects.toThrow(/manual correction/i);
      await expectReconciled(cafe.businessId);
    });
  });

  describe("idempotency", () => {
    it("replays a retried tap instead of awarding twice", async () => {
      const cardId = await freshCard(cafe);
      const sameKey = key();
      const input = { customerCardId: cardId, quantity: 2, idempotencyKey: sameKey, source: OperationSource.SCANNER } as const;

      const first = await awardManualStamps(cafe.ctx, input);
      const retry = await awardManualStamps(cafe.ctx, input);

      expect(retry.transactionGroupId).toBe(first.transactionGroupId);
      expect(retry.stampBalance).toBe(2);
      expect(await prisma.loyaltyOperation.count({ where: { customerCardId: cardId } })).toBe(1);
      const card = await prisma.customerCard.findUniqueOrThrow({ where: { id: cardId } });
      expect(card.stampBalance).toBe(2);
    });

    it("refuses the same key used for a different intent", async () => {
      const cardId = await freshCard(cafe);
      const sameKey = key();
      await awardManualStamps(cafe.ctx, {
        customerCardId: cardId,
        quantity: 2,
        idempotencyKey: sameKey,
        source: OperationSource.SCANNER,
      });
      await expect(
        awardManualStamps(cafe.ctx, { customerCardId: cardId, quantity: 5, idempotencyKey: sameKey, source: OperationSource.SCANNER }),
      ).rejects.toBeInstanceOf(IdempotencyConflictError);
    });

    it("executes a concurrent duplicate exactly once", async () => {
      const cardId = await freshCard(cafe);
      const sameKey = key();
      const input = { customerCardId: cardId, quantity: 3, idempotencyKey: sameKey, source: OperationSource.SCANNER } as const;

      const results = await Promise.all(Array.from({ length: 5 }, () => awardManualStamps(cafe.ctx, input)));
      expect(new Set(results.map((r) => r.transactionGroupId)).size).toBe(1);
      expect(await prisma.loyaltyOperation.count({ where: { customerCardId: cardId } })).toBe(1);
      const card = await prisma.customerCard.findUniqueOrThrow({ where: { id: cardId } });
      expect(card.stampBalance).toBe(3);
      await expectReconciled(cafe.businessId);
    });

    it("requires a key long enough to be a real one", async () => {
      const cardId = await freshCard(cafe);
      await expect(
        awardManualStamps(cafe.ctx, { customerCardId: cardId, quantity: 1, idempotencyKey: "short", source: OperationSource.SCANNER }),
      ).rejects.toBeInstanceOf(ValidationError);
    });
  });

  describe("concurrent distinct awards on one card", () => {
    it("serialises on the card lock, with exact balances and no lost update", async () => {
      const cardId = await freshCard(cafe);
      const attempts = 12;
      await Promise.all(
        Array.from({ length: attempts }, () =>
          awardManualStamps(cafe.ctx, {
            customerCardId: cardId,
            quantity: 1,
            idempotencyKey: key(),
            source: OperationSource.SCANNER,
          }),
        ),
      );

      const card = await prisma.customerCard.findUniqueOrThrow({ where: { id: cardId } });
      // 12 stamps → one reward at 10, two carried.
      expect(card.stampBalance).toBe(2);
      expect(card.rewardBalance).toBe(1);

      const awards = await prisma.loyaltyOperation.findMany({
        where: { customerCardId: cardId, kind: OperationKind.MANUAL_AWARD },
        select: { balanceAfter: true, quantity: true },
      });
      expect(awards).toHaveLength(attempts);
      expect(awards.reduce((sum, a) => sum + a.quantity, 0)).toBe(attempts);

      /**
       * No lost update: each award saw the balance the previous one left. The twelve +1 awards
       * therefore land on 1…10, the tenth converts and resets the stamp balance to 0, and the
       * remaining two land on 1 and 2 again. Sorted, that is exactly:
       *
       *   [1, 1, 2, 2, 3, 4, 5, 6, 7, 8, 9, 10]
       *
       * A lost update would duplicate some other value or skip one, and no ordering of correct
       * awards can produce a different multiset.
       */
      expect(awards.map((a) => a.balanceAfter).sort((x, y) => x - y)).toEqual([1, 1, 2, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
      await expectReconciled(cafe.businessId);
    });
  });

  describe("cards that may not transact", () => {
    it.each([[CardStatus.PAUSED], [CardStatus.EXPIRED], [CardStatus.DELETED]])("refuses awards and redemptions on a %s card", async (status) => {
      const cardId = await freshCard(cafe);
      await awardManualStamps(cafe.ctx, { customerCardId: cardId, quantity: 10, idempotencyKey: key(), source: OperationSource.SCANNER });
      await prisma.customerCard.update({ where: { id: cardId }, data: { status } });

      await expect(
        awardManualStamps(cafe.ctx, { customerCardId: cardId, quantity: 1, idempotencyKey: key(), source: OperationSource.SCANNER }),
      ).rejects.toBeInstanceOf(ConflictError);
      await expect(
        redeemReward(cafe.ctx, { customerCardId: cardId, idempotencyKey: key(), source: OperationSource.SCANNER }),
      ).rejects.toBeInstanceOf(ConflictError);

      const card = await prisma.customerCard.findUniqueOrThrow({ where: { id: cardId } });
      expect(card.stampBalance).toBe(0);
      expect(card.rewardBalance).toBe(1); // the reward earned before the pause is untouched
    });

    it("refuses a card whose expiry date has passed, whatever its status says", async () => {
      const cardId = await freshCard(cafe);
      await prisma.customerCard.update({ where: { id: cardId }, data: { expiresAt: new Date(Date.now() - 60_000) } });
      await expect(
        awardManualStamps(cafe.ctx, { customerCardId: cardId, quantity: 1, idempotencyKey: key(), source: OperationSource.SCANNER }),
      ).rejects.toThrow(/expired/i);
    });

    it("allows a card with an expiry still in the future", async () => {
      const cardId = await freshCard(cafe);
      await prisma.customerCard.update({ where: { id: cardId }, data: { expiresAt: new Date(Date.now() + 86_400_000) } });
      const result = await awardManualStamps(cafe.ctx, {
        customerCardId: cardId,
        quantity: 1,
        idempotencyKey: key(),
        source: OperationSource.SCANNER,
      });
      expect(result.stampBalance).toBe(1);
    });
  });

  /**
   * Phase 1a is one café at one counter. The location is resolved by the server from the business,
   * never taken from a screen or a request, so multi-location behaviour cannot start by accident
   * before Phase 1b builds it deliberately.
   */
  describe("one location only", () => {
    it("attributes every kind of operation to Main", async () => {
      const cardId = await freshCard(cafe);
      // A reversible award first: reversing the group that EARNED a reward after redeeming it is
      // refused by design, and that refusal has its own test.
      const reversible = await awardManualStamps(cafe.ctx, {
        customerCardId: cardId,
        quantity: 3,
        idempotencyKey: key(),
        source: OperationSource.SCANNER,
      });
      await reverseStampOperation(cafe.ctx, {
        transactionGroupId: reversible.transactionGroupId,
        reason: "one-location check",
        idempotencyKey: key(),
        source: OperationSource.DASHBOARD,
      });
      // Then an award that converts, and the redemption of what it earned.
      await awardManualStamps(cafe.ctx, {
        customerCardId: cardId,
        quantity: 10,
        idempotencyKey: key(),
        source: OperationSource.SCANNER,
      });
      await redeemReward(cafe.ctx, { customerCardId: cardId, idempotencyKey: key(), source: OperationSource.SCANNER });

      const rows = await prisma.loyaltyOperation.findMany({
        where: { customerCardId: cardId },
        select: { locationId: true, kind: true },
      });
      // award, reversal, award + conversion + reward earned, redemption
      expect(rows.length).toBeGreaterThanOrEqual(6);
      expect(new Set(rows.map((r) => r.kind)).size).toBeGreaterThanOrEqual(5);
      expect(new Set(rows.map((r) => r.locationId))).toEqual(new Set([cafe.locationId]));

      const main = await prisma.location.findUniqueOrThrow({ where: { id: cafe.locationId } });
      expect(main.isDefault).toBe(true);
      expect(main.name).toBe("Main");
    });

    it("refuses a caller-supplied location on every verb, writing nothing", async () => {
      const cardId = await freshCard(cafe);
      await awardManualStamps(cafe.ctx, { customerCardId: cardId, quantity: 10, idempotencyKey: key(), source: OperationSource.SCANNER });
      const group = await prisma.loyaltyOperation.findFirstOrThrow({
        where: { customerCardId: cardId, kind: OperationKind.MANUAL_AWARD },
        select: { transactionGroupId: true },
      });
      const secondCounter = await prisma.location.create({ data: { businessId: cafe.businessId, name: "Terrace" } });
      const before = await prisma.loyaltyOperation.count({ where: { customerCardId: cardId } });

      // Exactly what an untyped route handler spreading a request body could pass. The field is
      // gone from the contract, so this is the JavaScript-level attempt.
      const withLocation = (extra: object) => ({ customerCardId: cardId, idempotencyKey: key(), source: OperationSource.SCANNER, locationId: secondCounter.id, ...extra });

      await expect(
        awardManualStamps(cafe.ctx, withLocation({ quantity: 1 }) as unknown as Parameters<typeof awardManualStamps>[1]),
      ).rejects.toBeInstanceOf(ValidationError);
      await expect(
        awardVisitStamp(cafe.ctx, withLocation({}) as unknown as Parameters<typeof awardVisitStamp>[1]),
      ).rejects.toBeInstanceOf(ValidationError);
      await expect(
        awardPurchaseStamps(cafe.ctx, withLocation({ purchaseAmountMinor: 10_000 }) as unknown as Parameters<typeof awardPurchaseStamps>[1]),
      ).rejects.toBeInstanceOf(ValidationError);
      await expect(
        redeemReward(cafe.ctx, withLocation({}) as unknown as Parameters<typeof redeemReward>[1]),
      ).rejects.toBeInstanceOf(ValidationError);
      await expect(
        reverseStampOperation(cafe.ctx, {
          transactionGroupId: group.transactionGroupId,
          reason: "nope",
          idempotencyKey: key(),
          source: OperationSource.DASHBOARD,
          locationId: secondCounter.id,
        } as unknown as Parameters<typeof reverseStampOperation>[1]),
      ).rejects.toBeInstanceOf(ValidationError);

      // Not one row was written, and the second counter has no history at all.
      expect(await prisma.loyaltyOperation.count({ where: { customerCardId: cardId } })).toBe(before);
      expect(await prisma.loyaltyOperation.count({ where: { locationId: secondCounter.id } })).toBe(0);
      await expectReconciled(cafe.businessId);
    });

    it("refuses the Main location too: it is not the caller's to state", async () => {
      // Passing the RIGHT location is still passing one. The rule is about who decides.
      const cardId = await freshCard(cafe);
      await expect(
        awardManualStamps(cafe.ctx, {
          customerCardId: cardId,
          quantity: 1,
          idempotencyKey: key(),
          source: OperationSource.SCANNER,
          locationId: cafe.locationId,
        } as unknown as Parameters<typeof awardManualStamps>[1]),
      ).rejects.toThrow(/Main location/);
      expect(await prisma.loyaltyOperation.count({ where: { customerCardId: cardId } })).toBe(0);
    });
  });

  describe("tenant isolation", () => {
    it("refuses to touch another business's card, even with a real card id", async () => {
      const mine = await freshCard(cafe);
      const stranger = await createStampCafe();
      const strangerCtx = await ownerCtx(stranger);

      for (const attempt of [
        () => awardManualStamps(strangerCtx, { customerCardId: mine, quantity: 1, idempotencyKey: key(), source: OperationSource.SCANNER }),
        () => redeemReward(strangerCtx, { customerCardId: mine, idempotencyKey: key(), source: OperationSource.SCANNER }),
        () => getCardBalances(strangerCtx, mine),
      ]) {
        await expect(attempt()).rejects.toBeInstanceOf(NotFoundError);
      }
      expect(await prisma.loyaltyOperation.count({ where: { customerCardId: mine } })).toBe(0);
    });

    it("refuses to reverse a group belonging to another business", async () => {
      const cardId = await freshCard(cafe);
      const award = await awardManualStamps(cafe.ctx, {
        customerCardId: cardId,
        quantity: 1,
        idempotencyKey: key(),
        source: OperationSource.SCANNER,
      });
      const stranger = await createStampCafe();
      await expect(
        reverseStampOperation(await ownerCtx(stranger), {
          transactionGroupId: award.transactionGroupId,
          reason: "not mine",
          idempotencyKey: key(),
          source: OperationSource.DASHBOARD,
        }),
      ).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  describe("a failed operation leaves nothing behind", () => {
    it("keeps the ledger and the projections in agreement after refusals", async () => {
      const cardId = await freshCard(cafe);
      await awardManualStamps(cafe.ctx, { customerCardId: cardId, quantity: 4, idempotencyKey: key(), source: OperationSource.SCANNER });

      // A mix of refusals: bad quantity, no reward to redeem, wrong earn mode.
      await expect(
        awardManualStamps(cafe.ctx, { customerCardId: cardId, quantity: 0, idempotencyKey: key(), source: OperationSource.SCANNER }),
      ).rejects.toThrow();
      await expect(
        redeemReward(cafe.ctx, { customerCardId: cardId, idempotencyKey: key(), source: OperationSource.SCANNER }),
      ).rejects.toThrow();
      await expect(
        awardPurchaseStamps(cafe.ctx, {
          customerCardId: cardId,
          purchaseAmountMinor: 1_000,
          idempotencyKey: key(),
          source: OperationSource.SCANNER,
        }),
      ).rejects.toThrow();

      const card = await prisma.customerCard.findUniqueOrThrow({ where: { id: cardId } });
      expect(card.stampBalance).toBe(4);
      expect(await prisma.loyaltyOperation.count({ where: { customerCardId: cardId } })).toBe(1);
      await expectReconciled(cafe.businessId);
    });
  });

  describe("balance snapshot", () => {
    it("reports what the scanner screen needs", async () => {
      const cardId = await freshCard(cafe);
      await awardManualStamps(cafe.ctx, { customerCardId: cardId, quantity: 7, idempotencyKey: key(), source: OperationSource.SCANNER });
      const snapshot = await getCardBalances(cafe.ctx, cardId);
      expect(snapshot).toMatchObject({
        customerCardId: cardId,
        status: CardStatus.ISSUED,
        stampBalance: 7,
        rewardBalance: 0,
        stampsRequiredPerReward: 10,
        stampsToNextReward: 3,
      });
    });
  });
});
