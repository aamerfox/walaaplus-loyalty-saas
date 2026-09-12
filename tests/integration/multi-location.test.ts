import { MembershipRole, OperationSource } from "@prisma/client";
import { beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/db";
import { ForbiddenError, NotFoundError, ValidationError } from "@/server/errors";
import { awardManualPoints, reversePointsOperation } from "@/server/points/engine";
import { awardManualStamps, reverseStampOperation } from "@/server/stamp/engine";
import {
  createLocation,
  createPointsShop,
  createStaff,
  createStampCafe,
  enrolCustomer,
  enrolPointsCustomer,
  expectReconciled,
  resetDatabase,
} from "../setup/fixtures";

/**
 * Multi-location, and the Phase 1a behaviour it must not disturb.
 *
 * Phase 1a refused a caller-supplied location outright: one café, one counter, and `locationId` was
 * not an input. Phase 1b gives that decision to the card's PINNED program version, which means two
 * things have to be true at once — a version that never asked for locations still behaves exactly
 * as it did, and a version that did gets a real check rather than a label.
 */

const key = () => `k-${Math.random().toString(36).slice(2)}-${Date.now()}`;

describe("a Phase 1a program is still Main-only", () => {
  beforeAll(async () => {
    await resetDatabase();
  });

  it("refuses a supplied location and writes at Main", async () => {
    const cafe = await createStampCafe();
    const branch = await createLocation(cafe, "Branch");
    const card = await enrolCustomer(cafe);

    // The version has no `availableLocations`, so naming a location is refused - even one that
    // genuinely belongs to this business, and even to the owner.
    await expect(
      awardManualStamps(cafe.ctx, {
        customerCardId: card.customerCardId,
        quantity: 1,
        idempotencyKey: key(),
        source: OperationSource.SCANNER,
        locationId: branch,
      }),
    ).rejects.toBeInstanceOf(ValidationError);

    const ok = await awardManualStamps(cafe.ctx, {
      customerCardId: card.customerCardId,
      quantity: 1,
      idempotencyKey: key(),
      source: OperationSource.SCANNER,
    });
    const row = await prisma.loyaltyOperation.findFirstOrThrow({
      where: { transactionGroupId: ok.transactionGroupId },
      select: { locationId: true },
    });
    expect(row.locationId).toBe(cafe.locationId);
    expect(row.locationId).not.toBe(branch);
  });
});

describe("a program that lists its locations", () => {
  it("accepts one of them, and refuses anything else", async () => {
    await resetDatabase();
    const cafe = await createStampCafe();
    const branch = await createLocation(cafe, "Branch");
    const rival = await createStampCafe({ name: "Rival" });

    // A new program on the same business, published with two counters.
    const multi = await createPointsShop({
      existing: { userId: cafe.userId, businessId: cafe.businessId, locationId: cafe.locationId },
      name: "Two counters",
      mechanics: { availableLocations: [cafe.locationId, branch] },
    });
    const card = await enrolPointsCustomer(multi);

    const atBranch = await awardManualPoints(multi.ctx, {
      customerCardId: card.customerCardId,
      quantity: 10,
      idempotencyKey: key(),
      source: OperationSource.SCANNER,
      locationId: branch,
    });
    expect(atBranch.locationId).toBe(branch);

    const written = await prisma.loyaltyOperation.findFirstOrThrow({
      where: { transactionGroupId: atBranch.transactionGroupId },
      select: { locationId: true },
    });
    expect(written.locationId).toBe(branch);

    // A location of this business that the PROGRAM does not offer.
    const unlisted = await createLocation(cafe, "Kiosk");
    await expect(
      awardManualPoints(multi.ctx, {
        customerCardId: card.customerCardId,
        quantity: 1,
        idempotencyKey: key(),
        source: OperationSource.SCANNER,
        locationId: unlisted,
      }),
    ).rejects.toBeInstanceOf(NotFoundError);

    // Another business's location, which must be indistinguishable from one that does not exist.
    await expect(
      awardManualPoints(multi.ctx, {
        customerCardId: card.customerCardId,
        quantity: 1,
        idempotencyKey: key(),
        source: OperationSource.SCANNER,
        locationId: rival.locationId,
      }),
    ).rejects.toBeInstanceOf(NotFoundError);

    // And with several on offer, silence is refused rather than guessed at.
    await expect(
      awardManualPoints(multi.ctx, {
        customerCardId: card.customerCardId,
        quantity: 1,
        idempotencyKey: key(),
        source: OperationSource.SCANNER,
      }),
    ).rejects.toBeInstanceOf(ValidationError);

    await expectReconciled(cafe.businessId);
  });

  it("refuses to be published at a location that is not the business's own", async () => {
    await resetDatabase();
    const cafe = await createStampCafe();
    const rival = await createStampCafe({ name: "Rival" });

    await expect(
      createPointsShop({
        existing: { userId: cafe.userId, businessId: cafe.businessId, locationId: cafe.locationId },
        name: "Sneaky",
        mechanics: { availableLocations: [rival.locationId] },
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("keeps a cashier to the counters they are assigned to", async () => {
    await resetDatabase();
    const cafe = await createStampCafe();
    const branch = await createLocation(cafe, "Branch");
    const multi = await createPointsShop({
      existing: { userId: cafe.userId, businessId: cafe.businessId, locationId: cafe.locationId },
      name: "Two counters",
      mechanics: { availableLocations: [cafe.locationId, branch] },
    });
    const card = await enrolPointsCustomer(multi);

    const mainCashier = await createStaff(cafe, MembershipRole.CASHIER, [cafe.locationId]);
    const branchCashier = await createStaff(cafe, MembershipRole.CASHIER, [branch]);

    // Each one may work their own counter...
    const atMain = await awardManualPoints(mainCashier.ctx, {
      customerCardId: card.customerCardId,
      quantity: 5,
      idempotencyKey: key(),
      source: OperationSource.SCANNER,
      locationId: cafe.locationId,
    });
    expect(atMain.locationId).toBe(cafe.locationId);

    // ...and not the other, even though the PROGRAM offers it.
    await expect(
      awardManualPoints(mainCashier.ctx, {
        customerCardId: card.customerCardId,
        quantity: 5,
        idempotencyKey: key(),
        source: OperationSource.SCANNER,
        locationId: branch,
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);

    const atBranch = await awardManualPoints(branchCashier.ctx, {
      customerCardId: card.customerCardId,
      quantity: 5,
      idempotencyKey: key(),
      source: OperationSource.SCANNER,
      locationId: branch,
    });
    expect(atBranch.locationId).toBe(branch);

    // A cashier with no assignment at all is refused everywhere: [] is a denial, never "any".
    const unassigned = await createStaff(cafe, MembershipRole.CASHIER, []);
    await expect(
      awardManualPoints(unassigned.ctx, {
        customerCardId: card.customerCardId,
        quantity: 1,
        idempotencyKey: key(),
        source: OperationSource.SCANNER,
        locationId: cafe.locationId,
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);

    await expectReconciled(cafe.businessId);
  });
});

describe("a reversal corrects the place the mistake was made", () => {
  beforeAll(async () => {
    await resetDatabase();
  });

  it("attributes compensating rows to the original location, not the reverser's", async () => {
    const cafe = await createStampCafe();
    const branch = await createLocation(cafe, "Branch");
    const multi = await createPointsShop({
      existing: { userId: cafe.userId, businessId: cafe.businessId, locationId: cafe.locationId },
      name: "Two counters",
      mechanics: { availableLocations: [cafe.locationId, branch] },
    });
    const card = await enrolPointsCustomer(multi);

    const award = await awardManualPoints(multi.ctx, {
      customerCardId: card.customerCardId,
      quantity: 20,
      idempotencyKey: key(),
      source: OperationSource.SCANNER,
      locationId: branch,
    });

    // The owner, who works everywhere, undoes it. The correction belongs to the branch.
    const reversal = await reversePointsOperation(multi.ctx, {
      transactionGroupId: award.transactionGroupId,
      reason: "wrong customer",
      idempotencyKey: key(),
      source: OperationSource.DASHBOARD,
    });

    const rows = await prisma.loyaltyOperation.findMany({
      where: { transactionGroupId: reversal.transactionGroupId },
      select: { locationId: true, quantity: true, performedByUserId: true },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].locationId).toBe(branch);
    expect(rows[0].quantity).toBe(-20);
    // Who fixed it is recorded on the row, which is where that question belongs.
    expect(rows[0].performedByUserId).toBe(multi.userId);

    // The branch's own figures net to zero; Main was never touched by either row.
    const branchTotal = await prisma.loyaltyOperation.aggregate({
      where: { customerCardId: card.customerCardId, locationId: branch },
      _sum: { quantity: true },
    });
    const mainRows = await prisma.loyaltyOperation.count({
      where: { customerCardId: card.customerCardId, locationId: cafe.locationId },
    });
    expect(branchTotal._sum.quantity).toBe(0);
    expect(mainRows).toBe(0);
    await expectReconciled(cafe.businessId);
  });

  it("refuses a cashier who cannot work the location the mistake was made at", async () => {
    const cafe = await createStampCafe();
    const branch = await createLocation(cafe, "Branch");
    const multi = await createPointsShop({
      existing: { userId: cafe.userId, businessId: cafe.businessId, locationId: cafe.locationId },
      name: "Two counters",
      mechanics: { availableLocations: [cafe.locationId, branch] },
    });
    const card = await enrolPointsCustomer(multi);
    const branchCashier = await createStaff(cafe, MembershipRole.CASHIER, [branch]);
    const mainCashier = await createStaff(cafe, MembershipRole.CASHIER, [cafe.locationId]);

    const award = await awardManualPoints(branchCashier.ctx, {
      customerCardId: card.customerCardId,
      quantity: 10,
      idempotencyKey: key(),
      source: OperationSource.SCANNER,
      locationId: branch,
    });

    // The compensating rows would land at the branch, and this cashier may not write there. So the
    // reversal is refused rather than quietly re-attributed to the counter they do work at.
    await expect(
      reversePointsOperation(mainCashier.ctx, {
        transactionGroupId: award.transactionGroupId,
        reason: "not mine to fix",
        idempotencyKey: key(),
        source: OperationSource.SCANNER,
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);

    const card2 = await prisma.customerCard.findUniqueOrThrow({ where: { id: card.customerCardId } });
    expect(card2.pointBalance).toBe(10);
  });

  it("keeps a Phase 1a reversal at Main, exactly as before", async () => {
    const cafe = await createStampCafe();
    await createLocation(cafe, "Branch");
    const card = await enrolCustomer(cafe);

    const award = await awardManualStamps(cafe.ctx, {
      customerCardId: card.customerCardId,
      quantity: 2,
      idempotencyKey: key(),
      source: OperationSource.SCANNER,
    });
    const reversal = await reverseStampOperation(cafe.ctx, {
      transactionGroupId: award.transactionGroupId,
      reason: "mistake",
      idempotencyKey: key(),
      source: OperationSource.SCANNER,
    });

    const rows = await prisma.loyaltyOperation.findMany({
      where: { transactionGroupId: reversal.transactionGroupId },
      select: { locationId: true },
    });
    expect(rows.every((r) => r.locationId === cafe.locationId)).toBe(true);
    await expectReconciled(cafe.businessId);
  });
});
