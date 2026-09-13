import { MembershipRole, OperationSource } from "@prisma/client";
import { beforeEach, describe, expect, it } from "vitest";

import { getCustomerProfile, listProfileActivity } from "@/server/customers/customer-360";
import { prisma } from "@/server/db";
import { ForbiddenError, NotFoundError } from "@/server/errors";
import { redeemReward, awardManualStamps, reverseStampOperation } from "@/server/stamp/engine";
import { awardManualPoints } from "@/server/points/engine";
import { createDraftVersion, publishDraftVersion, updateDraftVersion } from "@/server/program/versions";
import {
  createLocation,
  createPointsShop,
  createStaff,
  createStampCafe,
  enrolCustomer,
  enrolPointsCustomer,
  expectReconciled,
  resetDatabase,
  uniqueSyrianPhone,
  type StampCafeFixture,
} from "../setup/fixtures";

/**
 * The customer record, against the ledger that produced it.
 *
 * Every number on this screen is a projection the ledger wrote, and every row is a ledger row. So
 * these tests do the operations for real — earn, redeem, reverse, retry an idempotent key — and then
 * assert the record says what happened. A CRM that agrees with the ledger only on the happy path is
 * a CRM a merchant will eventually stop believing.
 *
 * Two of them exist because of a defect this prompt found: the previous card-scoped page read every
 * card through the STAMP contract, so a points customer could not be opened at all.
 */

const key = () => `k-${Math.random().toString(36).slice(2)}-${Date.now()}`;

describe("a customer record matches the ledger", () => {
  let cafe: StampCafeFixture;

  beforeEach(async () => {
    await resetDatabase();
    cafe = await createStampCafe({ mechanics: { stampsRequiredPerReward: 5 } });
  });

  it("shows the balance the ledger left, after an award, a redemption and a reversal", async () => {
    const card = await enrolCustomer(cafe, { phone: uniqueSyrianPhone(), firstName: "ليلى" });
    const profileId = card.customerBusinessProfileId;

    await awardManualStamps(cafe.ctx, {
      customerCardId: card.customerCardId,
      quantity: 5,
      idempotencyKey: key(),
      source: OperationSource.SCANNER,
    });
    let profile = await getCustomerProfile(cafe.ctx, profileId);
    expect(profile.cards[0].stampBalance).toBe(0); // converted
    expect(profile.cards[0].rewardBalance).toBe(1);

    await redeemReward(cafe.ctx, {
      customerCardId: card.customerCardId,
      idempotencyKey: key(),
      source: OperationSource.SCANNER,
    });
    profile = await getCustomerProfile(cafe.ctx, profileId);
    expect(profile.cards[0].rewardBalance).toBe(0);

    // A second award, then undo it. The record shows the correction as its own row.
    const second = await awardManualStamps(cafe.ctx, {
      customerCardId: card.customerCardId,
      quantity: 3,
      idempotencyKey: key(),
      source: OperationSource.SCANNER,
    });
    await reverseStampOperation(cafe.ctx, {
      transactionGroupId: second.transactionGroupId,
      reason: "mistake at the till",
      idempotencyKey: key(),
      source: OperationSource.SCANNER,
    });

    profile = await getCustomerProfile(cafe.ctx, profileId);
    expect(profile.cards[0].stampBalance).toBe(0);

    const activity = await listProfileActivity(cafe.ctx, profileId);
    const corrections = activity.items.filter((row) => row.reversalOfOperationId !== null);
    // The reversal is a ROW, not an edit of the row it corrects: both are present.
    expect(corrections.length).toBeGreaterThan(0);
    expect(activity.items.some((row) => row.kind === "MANUAL_AWARD" && row.quantity === 3)).toBe(true);

    await expectReconciled(cafe.businessId);
  });

  it("is unchanged by an idempotent retry", async () => {
    const card = await enrolCustomer(cafe, { phone: uniqueSyrianPhone() });
    const sameKey = key();
    const body = {
      customerCardId: card.customerCardId,
      quantity: 2,
      idempotencyKey: sameKey,
      source: OperationSource.SCANNER,
    } as const;

    await awardManualStamps(cafe.ctx, body);
    const after = await getCustomerProfile(cafe.ctx, card.customerBusinessProfileId);
    const activityAfter = await listProfileActivity(cafe.ctx, card.customerBusinessProfileId);

    await awardManualStamps(cafe.ctx, body); // the same key, the same intent: a replay
    const again = await getCustomerProfile(cafe.ctx, card.customerBusinessProfileId);
    const activityAgain = await listProfileActivity(cafe.ctx, card.customerBusinessProfileId);

    expect(again.cards[0].stampBalance).toBe(after.cards[0].stampBalance);
    expect(activityAgain.items).toHaveLength(activityAfter.items.length);
    await expectReconciled(cafe.businessId);
  });

  it("reads a points card through the POINTS contract, which the card page could not", async () => {
    const shop = await createPointsShop({ name: "Points side" });
    const card = await enrolPointsCustomer(shop, { phone: uniqueSyrianPhone() });
    await awardManualPoints(shop.ctx, {
      customerCardId: card.customerCardId,
      quantity: 30,
      idempotencyKey: key(),
      source: OperationSource.SCANNER,
    });

    // This is the regression: reading it through the stamp contract threw, and the page 404'd.
    const profile = await getCustomerProfile(shop.ctx, card.customerBusinessProfileId);
    expect(profile.cards).toHaveLength(1);
    expect(profile.cards[0].cardType).toBe("POINTS");
    expect(profile.cards[0].pointBalance).toBe(30);
    expect(profile.cards[0].stampsRequiredPerReward).toBeNull();
    // The tiers this card was SOLD, with what the balance can afford.
    expect(profile.cards[0].tiers.find((t) => t.requiredPoints === 10)?.affordable).toBe(true);
    expect(profile.cards[0].tiers.find((t) => t.requiredPoints === 50)?.affordable).toBe(false);
  });

  it("shows every card a customer holds, in one record", async () => {
    const phone = uniqueSyrianPhone();
    const stamp = await enrolCustomer(cafe, { phone });
    const shop = await createPointsShop({
      existing: { userId: cafe.userId, businessId: cafe.businessId, locationId: cafe.locationId },
      name: "Second programme",
    });
    await enrolPointsCustomer(shop, { phone });

    const profile = await getCustomerProfile(cafe.ctx, stamp.customerBusinessProfileId);
    expect(profile.cards).toHaveLength(2);
    expect(profile.cards.map((c) => c.cardType).sort()).toEqual(["POINTS", "STAMP"]);
  });

  it("keeps a card on the version it was issued under after a new one is published", async () => {
    const before = await enrolCustomer(cafe, { phone: uniqueSyrianPhone() });

    await createDraftVersion(cafe.ctx, cafe.program.templateId);
    await updateDraftVersion(cafe.ctx, cafe.program.templateId, {
      mechanics: {
        kind: "STAMP",
        contractVersion: 1,
        stampsRequiredPerReward: 20,
        rewardName: "قهوة مجانية",
        earnMode: "MANUAL",
        countRewardRedemptionAsVisit: false,
      },
    });
    await publishDraftVersion(cafe.ctx, cafe.program.templateId, 2);

    const old = await getCustomerProfile(cafe.ctx, before.customerBusinessProfileId);
    expect(old.cards[0].versionNumber).toBe(1);
    // The threshold the customer was sold, not the one the program moved to.
    expect(old.cards[0].stampsRequiredPerReward).toBe(5);

    const after = await enrolCustomer(cafe, { phone: uniqueSyrianPhone() });
    const fresh = await getCustomerProfile(cafe.ctx, after.customerBusinessProfileId);
    expect(fresh.cards[0].versionNumber).toBe(2);
    expect(fresh.cards[0].stampsRequiredPerReward).toBe(20);
  });
});

describe("a customer record leaks no capability", () => {
  it("returns no card token, no share token and no source token", async () => {
    await resetDatabase();
    const cafe = await createStampCafe();
    const card = await enrolCustomer(cafe, { phone: uniqueSyrianPhone() });
    await awardManualStamps(cafe.ctx, {
      customerCardId: card.customerCardId,
      quantity: 1,
      idempotencyKey: key(),
      source: OperationSource.SCANNER,
    });

    const [profile, activity] = await Promise.all([
      getCustomerProfile(cafe.ctx, card.customerBusinessProfileId),
      listProfileActivity(cafe.ctx, card.customerBusinessProfileId),
    ]);
    const rendered = JSON.stringify([profile, activity]);

    const row = await prisma.customerCard.findUniqueOrThrow({
      where: { id: card.customerCardId },
      select: { qrToken: true, shareToken: true, utmSourceLink: { select: { publicToken: true, name: true } } },
    });
    expect(rendered).not.toContain(row.qrToken);
    expect(rendered).not.toContain(row.shareToken);
    expect(rendered).not.toContain(row.utmSourceLink!.publicToken);
    // A source has a display NAME here, and nothing else. That is the whole of what B7 allows.
    expect(profile.cards[0].sourceName).toBe(row.utmSourceLink!.name);
    // No URL of any kind, and nothing resembling the withdrawn public path.
    expect(rendered).not.toMatch(/https?:\/\//);
    expect(rendered).not.toContain("/join/");
    expect(rendered).not.toContain("/card/");
  });
});

describe("a customer record is tenant- and role-scoped", () => {
  it("refuses another business's customer as if they did not exist", async () => {
    await resetDatabase();
    const mine = await createStampCafe({ name: "Mine" });
    const theirs = await createStampCafe({ name: "Theirs" });
    const theirCustomer = await enrolCustomer(theirs, { phone: uniqueSyrianPhone() });

    await expect(getCustomerProfile(mine.ctx, theirCustomer.customerBusinessProfileId)).rejects.toBeInstanceOf(NotFoundError);
    await expect(listProfileActivity(mine.ctx, theirCustomer.customerBusinessProfileId)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("refuses a cashier the record, who may still serve the person in front of them", async () => {
    await resetDatabase();
    const cafe = await createStampCafe();
    const card = await enrolCustomer(cafe, { phone: uniqueSyrianPhone() });
    const cashier = await createStaff(cafe, MembershipRole.CASHIER, [cafe.locationId]);

    await expect(getCustomerProfile(cashier.ctx, card.customerBusinessProfileId)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("narrows activity to the branches a member is assigned to", async () => {
    await resetDatabase();
    const cafe = await createStampCafe();
    const branch = await createLocation(cafe, "Branch");

    // A version running at both branches, so operations can legitimately be written at either.
    await createDraftVersion(cafe.ctx, cafe.program.templateId);
    await updateDraftVersion(cafe.ctx, cafe.program.templateId, {
      mechanics: {
        kind: "STAMP",
        contractVersion: 1,
        stampsRequiredPerReward: 10,
        rewardName: "قهوة مجانية",
        earnMode: "MANUAL",
        countRewardRedemptionAsVisit: false,
        availableLocations: [cafe.locationId, branch],
      },
    });
    await publishDraftVersion(cafe.ctx, cafe.program.templateId, 2);

    const card = await enrolCustomer(cafe, { phone: uniqueSyrianPhone() });
    await awardManualStamps(cafe.ctx, {
      customerCardId: card.customerCardId,
      quantity: 1,
      locationId: cafe.locationId,
      idempotencyKey: key(),
      source: OperationSource.SCANNER,
    });
    await awardManualStamps(cafe.ctx, {
      customerCardId: card.customerCardId,
      quantity: 1,
      locationId: branch,
      idempotencyKey: key(),
      source: OperationSource.SCANNER,
    });

    // A MANAGER assigned to the branch only. They hold VIEW_OPERATIONS, so the read runs — and
    // returns what happened at their own branch, not what a colleague did at the main one.
    const manager = await createStaff(cafe, MembershipRole.MANAGER, [branch]);
    const scoped = await prisma.businessMembership.findFirstOrThrow({ where: { id: manager.membershipId } });
    expect(scoped.role).toBe(MembershipRole.MANAGER);

    const narrowed = await listProfileActivity(
      { ...manager.ctx, locationIds: [branch] },
      card.customerBusinessProfileId,
    );
    expect(narrowed.items.length).toBeGreaterThan(0);
    expect(narrowed.items.every((row) => row.locationName === "Branch")).toBe(true);

    const everything = await listProfileActivity(cafe.ctx, card.customerBusinessProfileId);
    expect(everything.items.length).toBeGreaterThan(narrowed.items.length);
  });
});
