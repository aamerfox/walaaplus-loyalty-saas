import { MembershipRole, OperationSource, Permission } from "@prisma/client";
import { beforeAll, describe, expect, it } from "vitest";
import { getBusinessMetrics } from "@/server/analytics/metrics";
import { prisma } from "@/server/db";
import { ForbiddenError, ValidationError } from "@/server/errors";
import { awardManualPoints, redeemRewardTier } from "@/server/points/engine";
import { awardManualStamps, awardVisitStamp, redeemReward, reverseStampOperation } from "@/server/stamp/engine";
import { requireBusinessMembership } from "@/server/tenant/context";
import { setMembershipPermissions } from "@/server/tenant/memberships";
import {
  createLocation,
  createPointsShop,
  createStaff,
  createStampCafe,
  enrolCustomer,
  enrolPointsCustomer,
  resetDatabase,
  type PointsShopFixture,
  type StampCafeFixture,
} from "../setup/fixtures";

/**
 * The dashboard read models, checked against ledger rows this test wrote itself.
 *
 * Every assertion here is a number a merchant would recognise, computed twice: once by the service
 * and once by the test counting what it did. A metric that agrees with a hand count is the only
 * kind worth putting on a screen — and the reason this file exists is that the alternative, a
 * stored counter incremented on write, drifts silently and is then defended by the screen showing
 * it.
 */

const key = () => `k-${Math.random().toString(36).slice(2)}-${Date.now()}`;
const WIDE = { from: new Date(Date.now() - 86_400_000), to: new Date(Date.now() + 86_400_000) };

describe("business metrics", () => {
  let cafe: StampCafeFixture;
  let shop: PointsShopFixture;

  beforeAll(async () => {
    await resetDatabase();
    cafe = await createStampCafe({ name: "Stamps", mechanics: { stampsRequiredPerReward: 2 } });
    shop = await createPointsShop({
      existing: { userId: cafe.userId, businessId: cafe.businessId, locationId: cafe.locationId },
      name: "Points",
    });
  });

  it("counts transactions as counter events, not ledger rows", async () => {
    const card = await enrolCustomer(cafe);

    // One award that crosses the threshold writes THREE rows in ONE group: the award, the stamps
    // it consumed, and the reward it completed. A merchant calls that one transaction.
    const award = await awardManualStamps(cafe.ctx, {
      customerCardId: card.customerCardId,
      quantity: 2,
      idempotencyKey: key(),
      source: OperationSource.SCANNER,
    });
    const rows = await prisma.loyaltyOperation.count({ where: { transactionGroupId: award.transactionGroupId } });
    expect(rows).toBe(3);

    const metrics = await getBusinessMetrics(cafe.ctx, WIDE);
    expect(metrics.transactions).toBe(1);
    expect(metrics.unitsAwarded.stamps).toBe(2);
    expect(metrics.unitsAwarded.points).toBe(0);
  });

  it("counts a reward given, and stops counting one that was taken back", async () => {
    const card = await enrolCustomer(cafe);
    await awardManualStamps(cafe.ctx, {
      customerCardId: card.customerCardId,
      quantity: 2,
      idempotencyKey: key(),
      source: OperationSource.SCANNER,
    });
    const before = await getBusinessMetrics(cafe.ctx, WIDE);

    const redeem = await redeemReward(cafe.ctx, {
      customerCardId: card.customerCardId,
      idempotencyKey: key(),
      source: OperationSource.SCANNER,
    });
    const after = await getBusinessMetrics(cafe.ctx, WIDE);
    expect(after.rewardsRedeemed).toBe(before.rewardsRedeemed + 1);

    await reverseStampOperation(cafe.ctx, {
      transactionGroupId: redeem.transactionGroupId,
      reason: "handed over the wrong thing",
      idempotencyKey: key(),
      source: OperationSource.SCANNER,
    });

    const undone = await getBusinessMetrics(cafe.ctx, WIDE);
    // The reward is no longer "given": the merchant took it back, and the figure says so.
    expect(undone.rewardsRedeemed).toBe(before.rewardsRedeemed);
    expect(undone.reversals).toBe(before.reversals + 1);
  });

  it("separates stamps from points, and reports the cost of the rewards it gave", async () => {
    const before = await getBusinessMetrics(shop.ctx, WIDE);
    const card = await enrolPointsCustomer(shop);
    await awardManualPoints(shop.ctx, {
      customerCardId: card.customerCardId,
      quantity: 30,
      idempotencyKey: key(),
      source: OperationSource.SCANNER,
    });

    await redeemRewardTier(shop.ctx, {
      customerCardId: card.customerCardId,
      rewardTierId: shop.cheapTierId,
      idempotencyKey: key(),
      source: OperationSource.SCANNER,
    });
    const after = await getBusinessMetrics(shop.ctx, WIDE);

    expect(after.unitsAwarded.points).toBe(before.unitsAwarded.points + 30);
    // Adding stamps to points would be meaningless, so they are never added.
    expect(after.unitsAwarded.stamps).toBe(before.unitsAwarded.stamps);
    // The cheap tier costs the merchant 5,000 minor units, recorded on the redemption row.
    expect(after.rewardValueMinorRedeemed).toBe(before.rewardValueMinorRedeemed + 5_000);
  });

  it("tells new customers from repeat ones by when they were first seen", async () => {
    const fresh = await createStampCafe({ name: "Fresh", mechanics: { stampsRequiredPerReward: 5 } });
    const newcomer = await enrolCustomer(fresh);
    const regular = await enrolCustomer(fresh);

    // Backdate one profile to before the window: same person, second visit.
    await prisma.customerBusinessProfile.update({
      where: { id: regular.customerBusinessProfileId },
      data: { firstSeenAt: new Date(Date.now() - 30 * 86_400_000) },
    });

    for (const id of [newcomer.customerCardId, regular.customerCardId]) {
      await awardManualStamps(fresh.ctx, { customerCardId: id, quantity: 1, idempotencyKey: key(), source: OperationSource.SCANNER });
    }

    const metrics = await getBusinessMetrics(fresh.ctx, WIDE);
    expect(metrics.newCustomers).toBe(1);
    expect(metrics.repeatCustomers).toBe(1);
    expect(metrics.cardsIssued).toBe(2);
  });

  it("counts visits from the flag frozen at write time", async () => {
    const visits = await createStampCafe({ name: "Visits", mechanics: { earnMode: "PER_VISIT" } });
    const card = await enrolCustomer(visits);

    await awardVisitStamp(visits.ctx, { customerCardId: card.customerCardId, idempotencyKey: key(), source: OperationSource.SCANNER });
    await awardVisitStamp(visits.ctx, { customerCardId: card.customerCardId, idempotencyKey: key(), source: OperationSource.SCANNER });

    const metrics = await getBusinessMetrics(visits.ctx, WIDE);
    const flagged = await prisma.loyaltyOperation.count({ where: { businessId: visits.businessId, countsAsVisit: true } });
    expect(metrics.visits).toBe(flagged);
    expect(metrics.visits).toBe(2);
    // The enrolment welcome bonus is not a visit: nobody came in for it.
    expect(metrics.transactions).toBeGreaterThanOrEqual(metrics.visits);
  });

  it("breaks the figures down by location and by program", async () => {
    const multiCafe = await createStampCafe({ name: "Multi", mechanics: { stampsRequiredPerReward: 5 } });
    const branch = await createLocation(multiCafe, "Branch");
    const multiPoints = await createPointsShop({
      existing: { userId: multiCafe.userId, businessId: multiCafe.businessId, locationId: multiCafe.locationId },
      name: "Multi points",
      mechanics: { availableLocations: [multiCafe.locationId, branch] },
    });

    const stampCard = await enrolCustomer(multiCafe);
    const pointsCard = await enrolPointsCustomer(multiPoints);

    await awardManualStamps(multiCafe.ctx, {
      customerCardId: stampCard.customerCardId,
      quantity: 1,
      idempotencyKey: key(),
      source: OperationSource.SCANNER,
    });
    await awardManualPoints(multiPoints.ctx, {
      customerCardId: pointsCard.customerCardId,
      quantity: 5,
      idempotencyKey: key(),
      source: OperationSource.SCANNER,
      locationId: branch,
    });
    await awardManualPoints(multiPoints.ctx, {
      customerCardId: pointsCard.customerCardId,
      quantity: 5,
      idempotencyKey: key(),
      source: OperationSource.SCANNER,
      locationId: branch,
    });

    const metrics = await getBusinessMetrics(multiCafe.ctx, WIDE);
    const branchRow = metrics.byLocation.find((l) => l.locationId === branch);
    const mainRow = metrics.byLocation.find((l) => l.locationId === multiCafe.locationId);
    expect(branchRow?.transactions).toBe(2);
    expect(branchRow?.name).toBe("Branch");
    // Main carries the stamp award and the enrolment bonuses; the branch carries only its own.
    expect(mainRow?.transactions).toBeGreaterThanOrEqual(1);

    const stampProgram = metrics.byTemplate.find((t) => t.templateId === multiCafe.program.templateId);
    const pointsProgram = metrics.byTemplate.find((t) => t.templateId === multiPoints.program.templateId);
    expect(stampProgram?.cardsIssued).toBe(1);
    expect(pointsProgram?.cardsIssued).toBe(1);
    expect(pointsProgram?.transactions).toBe(2);

    // And the same query narrowed to one program returns that program's slice.
    const narrowed = await getBusinessMetrics(multiCafe.ctx, { ...WIDE, templateId: multiPoints.program.templateId });
    expect(narrowed.byTemplate).toHaveLength(1);
    expect(narrowed.transactions).toBe(2);
    expect(narrowed.unitsAwarded.stamps).toBe(0);
  });
});

describe("metrics are tenant-scoped and permission-gated", () => {
  beforeAll(async () => {
    await resetDatabase();
  });

  it("never counts another business's activity", async () => {
    const mine = await createStampCafe({ name: "Mine", mechanics: { stampsRequiredPerReward: 5 } });
    const theirs = await createStampCafe({ name: "Theirs", mechanics: { stampsRequiredPerReward: 5 } });

    const theirCard = await enrolCustomer(theirs);
    await awardManualStamps(theirs.ctx, {
      customerCardId: theirCard.customerCardId,
      quantity: 4,
      idempotencyKey: key(),
      source: OperationSource.SCANNER,
    });

    const metrics = await getBusinessMetrics(mine.ctx, WIDE);
    expect(metrics.transactions).toBe(0);
    expect(metrics.unitsAwarded.stamps).toBe(0);
    expect(metrics.cardsIssued).toBe(0);

    // And a template id from the other business is refused rather than reported on.
    await expect(getBusinessMetrics(mine.ctx, { ...WIDE, templateId: theirs.program.templateId })).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  it("refuses a cashier, who has no dashboard", async () => {
    const cafe = await createStampCafe();
    const cashier = await createStaff(cafe, MembershipRole.CASHIER, [cafe.locationId]);
    await expect(getBusinessMetrics(cashier.ctx, WIDE)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("shows a location-restricted member only their own counters", async () => {
    const cafe = await createStampCafe({ name: "Restricted", mechanics: { stampsRequiredPerReward: 5 } });
    const branch = await createLocation(cafe, "Branch");
    const points = await createPointsShop({
      existing: { userId: cafe.userId, businessId: cafe.businessId, locationId: cafe.locationId },
      name: "Restricted points",
      mechanics: { availableLocations: [cafe.locationId, branch] },
    });
    const card = await enrolPointsCustomer(points);

    await awardManualPoints(points.ctx, {
      customerCardId: card.customerCardId,
      quantity: 5,
      idempotencyKey: key(),
      source: OperationSource.SCANNER,
      locationId: branch,
    });

    // A cashier assigned to Main, granted the dashboard by hand: exactly the membership Phase 1b's
    // permission editor makes possible, and the one a business-wide figure would over-share with.
    const cashier = await createStaff(cafe, MembershipRole.CASHIER, [cafe.locationId]);
    await setMembershipPermissions(cafe.ctx, cashier.membershipId, [Permission.VIEW_DASHBOARD]);
    const restricted = await requireBusinessMembership(prisma, cashier.userId, cafe.businessId);

    const theirs = await getBusinessMetrics(restricted, WIDE);
    expect(theirs.byLocation.map((l) => l.locationId)).not.toContain(branch);

    const owner = await getBusinessMetrics(cafe.ctx, WIDE);
    expect(owner.byLocation.map((l) => l.locationId)).toContain(branch);
    expect(owner.transactions).toBeGreaterThan(theirs.transactions);
  });

  it("refuses a range that is backwards or absurdly long", async () => {
    const cafe = await createStampCafe();
    await expect(getBusinessMetrics(cafe.ctx, { from: WIDE.to, to: WIDE.from })).rejects.toBeInstanceOf(ValidationError);
    await expect(
      getBusinessMetrics(cafe.ctx, { from: new Date(Date.now() - 500 * 86_400_000), to: new Date() }),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});
