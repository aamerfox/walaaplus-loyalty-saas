/**
 * Phase 1a — `dailyAwardLimit`, counted per card per BUSINESS-timezone day (PRODUCT-SPEC §5.6).
 *
 * Two separate things are proven here. That the limit is enforced at all, under the card lock so
 * a concurrent burst cannot slip past it. And that the day it counts is the merchant's day, not
 * the server's — the same instant falls on different dates for two businesses in different zones,
 * and a café that closes after midnight must not have its limit reset mid-shift.
 */
import { randomUUID } from "node:crypto";
import { OperationKind, OperationSource, UnitType } from "@prisma/client";
import { beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/db";
import { ConflictError } from "@/server/errors";
import { awardManualStamps, countAwardsInBusinessDay, redeemReward } from "@/server/stamp/engine";
import { businessDayRange } from "@/server/time/business-day";
import { createStampCafe, enrolCustomer, expectReconciled, resetDatabase, type StampCafeFixture } from "../setup/fixtures";

const key = () => `k-${randomUUID()}`;

/**
 * Write an award row at a chosen instant, the way yesterday's trading would look.
 *
 * The ledger is append-only, so history cannot be edited into place — it has to be inserted with
 * the timestamp it should have had. The card projection is moved by the same amount, so
 * reconciliation stays clean and these rows are indistinguishable from real ones.
 */
async function backdatedAward(fx: StampCafeFixture, customerCardId: string, createdAt: Date, quantity = 1): Promise<void> {
  const card = await prisma.customerCard.findUniqueOrThrow({
    where: { id: customerCardId },
    select: { businessId: true, templateId: true, programVersionId: true, customerBusinessProfileId: true, stampBalance: true, profile: { select: { customerId: true } } },
  });
  await prisma.loyaltyOperation.create({
    data: {
      transactionGroupId: randomUUID(),
      businessId: card.businessId,
      locationId: fx.locationId,
      customerId: card.profile.customerId,
      customerBusinessProfileId: card.customerBusinessProfileId,
      customerCardId,
      templateId: card.templateId,
      programVersionId: card.programVersionId,
      performedByUserId: fx.userId,
      kind: OperationKind.MANUAL_AWARD,
      unitType: UnitType.STAMP,
      quantity,
      balanceAfter: card.stampBalance + quantity,
      countsAsVisit: true,
      source: OperationSource.SCANNER,
      createdAt,
    },
  });
  await prisma.customerCard.update({
    where: { id: customerCardId },
    data: { stampBalance: { increment: quantity } },
  });
}

describe("daily award limit", () => {
  beforeAll(async () => {
    await resetDatabase();
  });

  describe("enforcement", () => {
    it("allows exactly the configured number of awards, then refuses", async () => {
      const cafe = await createStampCafe({ mechanics: { stampsRequiredPerReward: 20, dailyAwardLimit: 3 } });
      const { customerCardId } = await enrolCustomer(cafe);

      for (let i = 1; i <= 3; i++) {
        const result = await awardManualStamps(cafe.ctx, {
          customerCardId,
          quantity: 1,
          idempotencyKey: key(),
          source: OperationSource.SCANNER,
        });
        expect(result.stampBalance, `award ${i}`).toBe(i);
      }

      await expect(
        awardManualStamps(cafe.ctx, { customerCardId, quantity: 1, idempotencyKey: key(), source: OperationSource.SCANNER }),
      ).rejects.toBeInstanceOf(ConflictError);

      const card = await prisma.customerCard.findUniqueOrThrow({ where: { id: customerCardId } });
      expect(card.stampBalance).toBe(3);
      await expectReconciled(cafe.businessId);
    });

    it("counts OPERATIONS, not stamps: one award of five is one award", async () => {
      const cafe = await createStampCafe({ mechanics: { stampsRequiredPerReward: 50, dailyAwardLimit: 2 } });
      const { customerCardId } = await enrolCustomer(cafe);

      await awardManualStamps(cafe.ctx, { customerCardId, quantity: 5, idempotencyKey: key(), source: OperationSource.SCANNER });
      await awardManualStamps(cafe.ctx, { customerCardId, quantity: 5, idempotencyKey: key(), source: OperationSource.SCANNER });
      await expect(
        awardManualStamps(cafe.ctx, { customerCardId, quantity: 1, idempotencyKey: key(), source: OperationSource.SCANNER }),
      ).rejects.toThrow(/daily limit of 2/);

      const card = await prisma.customerCard.findUniqueOrThrow({ where: { id: customerCardId } });
      expect(card.stampBalance).toBe(10);
    });

    it("applies per card, not per business", async () => {
      const cafe = await createStampCafe({ mechanics: { stampsRequiredPerReward: 20, dailyAwardLimit: 1 } });
      const first = await enrolCustomer(cafe);
      const second = await enrolCustomer(cafe);

      await awardManualStamps(cafe.ctx, {
        customerCardId: first.customerCardId,
        quantity: 1,
        idempotencyKey: key(),
        source: OperationSource.SCANNER,
      });
      await expect(
        awardManualStamps(cafe.ctx, {
          customerCardId: first.customerCardId,
          quantity: 1,
          idempotencyKey: key(),
          source: OperationSource.SCANNER,
        }),
      ).rejects.toBeInstanceOf(ConflictError);

      // The next customer is unaffected.
      const other = await awardManualStamps(cafe.ctx, {
        customerCardId: second.customerCardId,
        quantity: 1,
        idempotencyKey: key(),
        source: OperationSource.SCANNER,
      });
      expect(other.stampBalance).toBe(1);
    });

    it("cannot be slipped past by a concurrent burst", async () => {
      const cafe = await createStampCafe({ mechanics: { stampsRequiredPerReward: 20, dailyAwardLimit: 2 } });
      const { customerCardId } = await enrolCustomer(cafe);

      const attempts = 8;
      const results = await Promise.allSettled(
        Array.from({ length: attempts }, () =>
          awardManualStamps(cafe.ctx, { customerCardId, quantity: 1, idempotencyKey: key(), source: OperationSource.SCANNER }),
        ),
      );

      // The limit check runs under the card lock, so exactly two win however they interleave.
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(2);
      expect(results.filter((r) => r.status === "rejected")).toHaveLength(attempts - 2);
      const card = await prisma.customerCard.findUniqueOrThrow({ where: { id: customerCardId } });
      expect(card.stampBalance).toBe(2);
      await expectReconciled(cafe.businessId);
    });

    it("does not limit redemptions or reversals, only awards", async () => {
      const cafe = await createStampCafe({ mechanics: { stampsRequiredPerReward: 2, dailyAwardLimit: 1 } });
      const { customerCardId } = await enrolCustomer(cafe);
      await awardManualStamps(cafe.ctx, { customerCardId, quantity: 2, idempotencyKey: key(), source: OperationSource.SCANNER });

      // The award budget is spent, but the customer may still collect what they earned.
      const redemption = await redeemReward(cafe.ctx, {
        customerCardId,
        idempotencyKey: key(),
        source: OperationSource.SCANNER,
      });
      expect(redemption.rewardBalance).toBe(0);
      await expectReconciled(cafe.businessId);
    });

    it("is absent when the program sets no limit", async () => {
      const cafe = await createStampCafe({ mechanics: { stampsRequiredPerReward: 100 } });
      const { customerCardId } = await enrolCustomer(cafe);
      for (let i = 0; i < 6; i++) {
        await awardManualStamps(cafe.ctx, { customerCardId, quantity: 1, idempotencyKey: key(), source: OperationSource.SCANNER });
      }
      const card = await prisma.customerCard.findUniqueOrThrow({ where: { id: customerCardId } });
      expect(card.stampBalance).toBe(6);
    });
  });

  describe("the day boundary is the business's, not the server's", () => {
    it("excludes an award made before local midnight", async () => {
      // Damascus is UTC+3, so its day begins at 21:00 UTC the evening before.
      const cafe = await createStampCafe({ mechanics: { stampsRequiredPerReward: 50, dailyAwardLimit: 2 }, timezone: "Asia/Damascus" });
      const { customerCardId } = await enrolCustomer(cafe);

      const now = new Date();
      const today = businessDayRange(now, "Asia/Damascus");
      // One second before this local day started: yesterday's trading.
      await backdatedAward(cafe, customerCardId, new Date(today.start.getTime() - 1_000));
      // One second after it started: today's.
      await backdatedAward(cafe, customerCardId, new Date(today.start.getTime() + 1_000));

      const counted = await prisma.$transaction((tx) => countAwardsInBusinessDay(tx, customerCardId, "Asia/Damascus", now));
      expect(counted.count).toBe(1);
      expect(counted.localDate).toBe(today.localDate);

      // And the limit agrees: one slot is left, and the one after it is refused.
      await awardManualStamps(cafe.ctx, { customerCardId, quantity: 1, idempotencyKey: key(), source: OperationSource.SCANNER });
      await expect(
        awardManualStamps(cafe.ctx, { customerCardId, quantity: 1, idempotencyKey: key(), source: OperationSource.SCANNER }),
      ).rejects.toBeInstanceOf(ConflictError);
      await expectReconciled(cafe.businessId);
    });

    it("counts the same instant into different days for businesses in different zones", async () => {
      // 12:00 UTC is already the 12th in Kiritimati (UTC+14) and still the 11th in Niue (UTC-11).
      const east = await createStampCafe({ mechanics: { stampsRequiredPerReward: 50 }, timezone: "Pacific/Kiritimati" });
      const west = await createStampCafe({ mechanics: { stampsRequiredPerReward: 50 }, timezone: "Pacific/Niue" });
      const eastCard = (await enrolCustomer(east)).customerCardId;
      const westCard = (await enrolCustomer(west)).customerCardId;

      /*
       * A FIXED hour of the day, not `new Date()`.
       *
       * This test used to take the current instant and a row 20 hours old, on the reasoning that
       * "the two zones are 25 hours apart, so a 20-hour-old row cannot be inside both". That is
       * false. Each local day is 24 hours long, and these two are offset by exactly ONE hour
       * modulo 24 — Kiritimati is UTC+14, Niue UTC-11 — so whenever both businesses are more than
       * 20 hours into their local day, the same row sits inside both. That is true for two hours
       * out of every 24, and the test failed in the gate at 08:00 UTC having passed all morning.
       *
       * Pinning the hour removes the coin flip AND makes the test stronger: the old version only
       * exercised the interesting case some of the time. At 12:00 UTC, Kiritimati is 2 hours into
       * its day and Niue 1 hour into its, so a row placed between the two local midnights is
       * inside exactly one of them, every run.
       */
      const today = new Date();
      const now = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate(), 12, 0, 0));

      const eastDay = businessDayRange(now, "Pacific/Kiritimati");
      const westDay = businessDayRange(now, "Pacific/Niue");
      expect(eastDay.localDate).not.toBe(westDay.localDate);
      // The east's day began first, so there is an hour that belongs to it alone.
      expect(eastDay.start.getTime()).toBeLessThan(westDay.start.getTime());

      const betweenMidnights = new Date((eastDay.start.getTime() + westDay.start.getTime()) / 2);
      await backdatedAward(east, eastCard, betweenMidnights);
      await backdatedAward(west, westCard, betweenMidnights);

      const eastCount = await prisma.$transaction((tx) => countAwardsInBusinessDay(tx, eastCard, "Pacific/Kiritimati", now));
      const westCount = await prisma.$transaction((tx) => countAwardsInBusinessDay(tx, westCard, "Pacific/Niue", now));

      // The same instant, counted by the business whose local day contains it and by no other.
      const insideEast = betweenMidnights >= eastDay.start;
      const insideWest = betweenMidnights >= westDay.start;
      expect(insideEast).toBe(true);
      expect(insideWest).toBe(false);
      expect(eastCount.count).toBe(1);
      expect(westCount.count).toBe(0);
      await expectReconciled(east.businessId);
      await expectReconciled(west.businessId);
    });

    it("counts an award made 'late last night' into the right trading day", async () => {
      // A café closing at 01:00 local: the award belongs to the day that is still open.
      const cafe = await createStampCafe({ mechanics: { stampsRequiredPerReward: 50 }, timezone: "Asia/Damascus" });
      const { customerCardId } = await enrolCustomer(cafe);

      const now = new Date();
      const today = businessDayRange(now, "Asia/Damascus");
      // 30 minutes into the local day, whenever that was in UTC.
      await backdatedAward(cafe, customerCardId, new Date(today.start.getTime() + 30 * 60_000));

      const counted = await prisma.$transaction((tx) => countAwardsInBusinessDay(tx, customerCardId, "Asia/Damascus", now));
      expect(counted.count).toBe(1);
      expect(counted.localDate).toBe(today.localDate);

      // The window really does move with the day rather than counting all history: asked about
      // tomorrow, the same row is outside it. (Two zones are NOT used here — Damascus and Niue
      // share a calendar date for part of each day, so that comparison would be flaky.)
      const tomorrow = await prisma.$transaction((tx) =>
        countAwardsInBusinessDay(tx, customerCardId, "Asia/Damascus", new Date(now.getTime() + 24 * 3_600_000)),
      );
      expect(tomorrow.count).toBe(0);
      expect(tomorrow.localDate).not.toBe(counted.localDate);

      // And yesterday's window does not contain it either: it sits in exactly one day.
      const yesterday = await prisma.$transaction((tx) =>
        countAwardsInBusinessDay(tx, customerCardId, "Asia/Damascus", new Date(now.getTime() - 24 * 3_600_000)),
      );
      expect(yesterday.count).toBe(0);
    });
  });
});
