import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { earnCashback, redeemCashback, reverseMonetaryOperation } from "@/server/monetary/engine";
import { readMoneyCard } from "@/server/monetary/counter";
import {
  createMonetaryShop,
  createStaff,
  migratorPrisma,
  enrolMonetaryCustomer,
  resetDatabase,
  type MonetaryShopFixture,
} from "../setup/fixtures";
import { MembershipRole, OperationSource } from "@prisma/client";

/**
 * What the counter shows before anybody types a bill.
 *
 * The balance and the rate on this screen are the two numbers a cashier says out loud, so the thing
 * worth proving is that they are the SAME numbers the engine will use when it writes — not a second
 * calculation that happens to agree today.
 */

let fx: MonetaryShopFixture;
let cardId: string;

beforeEach(async () => {
  await resetDatabase();
  fx = await createMonetaryShop({
    tiers: [
      { minCumulativeSpendMinor: 0, rateBasisPoints: 500 },
      { minCumulativeSpendMinor: 100_000, rateBasisPoints: 1000 },
    ],
  });
  cardId = (await enrolMonetaryCustomer(fx)).customerCardId;
});

const earn = (gross: string) =>
  earnCashback(fx.ctx, {
    customerCardId: cardId,
    grossAmountMinor: gross,
    idempotencyKey: randomUUID(),
    source: OperationSource.SCANNER,
  });

describe("a card with no history", () => {
  it("shows a zero balance and the first tier's rate", async () => {
    const view = await readMoneyCard(fx.ctx, cardId);

    expect(view.cashBalanceMinor).toBe("0");
    expect(view.qualifiedSpendMinor).toBe("0");
    expect(view.nextRateBasisPoints).toBe(500);
    expect(view.currency).toBe("SYP");
    expect(view.currencyExponent).toBe(2);
    expect(view.recent).toEqual([]);
  });

  it("names the version the CARD is pinned to, not the template's live one", async () => {
    const view = await readMoneyCard(fx.ctx, cardId);
    expect(view.versionNumber).toBe(1);
  });
});

describe("the rate it promises is the rate the engine gives", () => {
  it("moves to the higher tier once prior spend reaches the threshold", async () => {
    await earn("100000"); // qualified spend is now 100,000 — exactly the threshold

    const view = await readMoneyCard(fx.ctx, cardId);
    expect(view.qualifiedSpendMinor).toBe("100000");
    expect(view.nextRateBasisPoints).toBe(1000);

    // And the engine agrees on the very next invoice: 10% of 1,000, not 5%.
    const next = await earn("1000");
    expect(next.rateBasisPoints).toBe(1000);
    expect(next.cashEffectMinor).toBe("100");
  });

  it("selects the tier from spend BEFORE this invoice, which is what the screen showed (D35)", async () => {
    // 90,000 is below the threshold. A 20,000 invoice takes the total past it, but this invoice
    // still earns at the lower rate — and the screen said 5% beforehand.
    await earn("90000");
    const before = await readMoneyCard(fx.ctx, cardId);
    expect(before.nextRateBasisPoints).toBe(500);

    const result = await earn("20000");
    expect(result.rateBasisPoints).toBe(500);

    const after = await readMoneyCard(fx.ctx, cardId);
    expect(after.nextRateBasisPoints).toBe(1000);
  });
});

describe("what a reversal does to the numbers on screen", () => {
  it("stops a withdrawn sale counting towards the tier", async () => {
    const big = await earn("150000");
    expect((await readMoneyCard(fx.ctx, cardId)).nextRateBasisPoints).toBe(1000);

    await reverseMonetaryOperation(fx.ctx, {
      monetaryOperationId: big.operationId,
      reason: "Rung up twice",
      idempotencyKey: randomUUID(),
      source: OperationSource.SCANNER,
    });

    const view = await readMoneyCard(fx.ctx, cardId);
    // The spend no longer stands, so the customer is back on the first tier and the balance is zero.
    expect(view.qualifiedSpendMinor).toBe("0");
    expect(view.nextRateBasisPoints).toBe(500);
    expect(view.cashBalanceMinor).toBe("0");
  });

  it("marks the reversed row so the screen stops offering to reverse it again", async () => {
    const first = await earn("10000");
    await reverseMonetaryOperation(fx.ctx, {
      monetaryOperationId: first.operationId,
      reason: "Mistake",
      idempotencyKey: randomUUID(),
      source: OperationSource.SCANNER,
    });

    const view = await readMoneyCard(fx.ctx, cardId);
    const original = view.recent.find((r) => r.id === first.operationId);
    expect(original?.reversed).toBe(true);

    // And the reversal row itself carries what it undid, so the screen can label it.
    const reversal = view.recent.find((r) => r.reversalOfId === first.operationId);
    expect(reversal).toBeDefined();
    expect(reversal?.reversed).toBe(false);
  });
});

describe("balances after a redemption", () => {
  it("reports the balance the engine wrote, not a recomputation of it", async () => {
    await earn("200000"); // 5% of 200,000 = 10,000
    const redeemed = await redeemCashback(fx.ctx, {
      customerCardId: cardId,
      grossAmountMinor: "50000",
      requestedRedemptionMinor: "4000",
      idempotencyKey: randomUUID(),
      source: OperationSource.SCANNER,
    });

    const view = await readMoneyCard(fx.ctx, cardId);
    expect(view.cashBalanceMinor).toBe(redeemed.cashBalanceAfterMinor);
    expect(view.cashBalanceMinor).toBe("6000");
    // A redemption is not spend: it must not push the customer up a tier.
    expect(view.qualifiedSpendMinor).toBe("250000");
  });
});

describe("amounts leave as strings", () => {
  it("never hands a bigint or a float to a screen", async () => {
    await earn("10000");
    const view = await readMoneyCard(fx.ctx, cardId);

    expect(typeof view.cashBalanceMinor).toBe("string");
    expect(typeof view.qualifiedSpendMinor).toBe("string");
    expect(typeof view.recent[0].grossAmountMinor).toBe("string");
    // And the display form uses the currency's own exponent.
    expect(view.display.balance).toBe("5.00");
  });
});

describe("who and what it refuses", () => {
  it("answers 'not found' for another business's card, revealing nothing", async () => {
    const other = await createMonetaryShop();
    const theirs = await enrolMonetaryCustomer(other);
    await expect(readMoneyCard(fx.ctx, theirs.customerCardId)).rejects.toThrow(/Card not found/);
  });

  it("answers 'not found' for a STAMP card of the SAME business, rather than half-rendering one", async () => {
    /*
     * The stamp card is built inside `fx`'s own business on purpose. A stamp card belonging to a
     * DIFFERENT business would be refused by the tenant check first, and the test would pass with the
     * card-type check deleted - proving only that tenants are isolated, which another test covers.
     */
    const owner = migratorPrisma();
    const template = await owner.programTemplate.create({
      data: { businessId: fx.businessId, name: "Stamps", cardType: "STAMP" },
      select: { id: true },
    });
    const version = await owner.programVersion.create({
      data: {
        templateId: template.id,
        versionNumber: 1,
        status: "ACTIVE",
        activatedAt: new Date(),
        mechanics: { kind: "STAMP", contractVersion: 1, stampsRequiredPerReward: 5, rewardName: "Coffee", earnMode: "MANUAL" },
      },
      select: { id: true },
    });
    const existing = await owner.customerCard.findFirstOrThrow({
      where: { id: cardId },
      select: { customerBusinessProfileId: true },
    });
    const stampCard = await owner.customerCard.create({
      data: {
        businessId: fx.businessId,
        templateId: template.id,
        programVersionId: version.id,
        customerBusinessProfileId: existing.customerBusinessProfileId,
        serialNumber: `S-${randomUUID().slice(0, 8)}`,
        qrToken: randomUUID(),
        shareToken: randomUUID(),
      },
      select: { id: true },
    });

    await expect(readMoneyCard(fx.ctx, stampCard.id)).rejects.toThrow(/Card not found/);
  });

  it("is reachable by every staff role that can work a counter, and that is stated rather than tested as a refusal", async () => {
    /*
     * There is no permission-based refusal to demonstrate here, and pretending otherwise would be a
     * test that passes for the wrong reason.
     *
     * `effectivePermissions` ADDS to a role's defaults; it never restricts (D36). An earlier version
     * of this test built a CASHIER context with `effectivePermissions: []` and expected a rejection -
     * it resolved, because the CASHIER role holds VIEW_CUSTOMERS by default and the empty column took
     * nothing away. What is true is recorded instead: a cashier CAN read a money card, which is the
     * point of a counter.
     */
    const cashier = await createStaff(fx, MembershipRole.CASHIER, [fx.locationId]);
    const view = await readMoneyCard(cashier.ctx, cardId);
    expect(view.customerCardId).toBe(cardId);
  });
});
