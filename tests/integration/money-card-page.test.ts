import { randomUUID } from "node:crypto";
import { OperationSource } from "@prisma/client";
import { beforeEach, describe, expect, it } from "vitest";
import { getPublicCardKind, getPublicCardView, getPublicMoneyCardView } from "@/server/customers/card-view";
import { earnCashback } from "@/server/monetary/engine";
import { migratorPrisma, createMonetaryShop, createStampCafe, enrolMonetaryCustomer, resetDatabase, type MonetaryShopFixture } from "../setup/fixtures";

/**
 * The customer's own card page, for a cashback or discount programme.
 *
 * Public: opened by whoever holds the link, with no session. Two things are therefore worth proving
 * beyond the numbers — that the page cannot be used to learn anything about a card it will not show,
 * and that a money card reaching the STAMP reader is refused as not-found rather than as corruption.
 */

let fx: MonetaryShopFixture;
let shareToken: string;

beforeEach(async () => {
  await resetDatabase();
  fx = await createMonetaryShop({
    tiers: [
      { minCumulativeSpendMinor: 0, rateBasisPoints: 500 },
      { minCumulativeSpendMinor: 100_000, rateBasisPoints: 1000 },
    ],
  });
  const enrolled = await enrolMonetaryCustomer(fx);
  shareToken = (
    await migratorPrisma().customerCard.findUniqueOrThrow({
      where: { id: enrolled.customerCardId },
      select: { shareToken: true },
    })
  ).shareToken;
});

describe("what the holder sees", () => {
  it("shows a zero balance and the first tier's rate on a new card", async () => {
    const view = await getPublicMoneyCardView(shareToken);

    expect(view.cashBalanceMinor).toBe("0");
    expect(view.displayBalance).toBe("0.00");
    expect(view.currency).toBe("SYP");
    expect(view.nextRateBasisPoints).toBe(500);
    expect(view.cardType).toBe("CASHBACK");
    expect(view.active).toBe(true);
  });

  it("shows the balance the engine wrote, formatted with the currency's own exponent", async () => {
    const card = await migratorPrisma().customerCard.findFirstOrThrow({
      where: { shareToken },
      select: { id: true },
    });
    await earnCashback(fx.ctx, {
      customerCardId: card.id,
      grossAmountMinor: "123456",
      idempotencyKey: randomUUID(),
      source: OperationSource.SCANNER,
    });

    const view = await getPublicMoneyCardView(shareToken);
    // 5% of 123,456 is 6,172.8 → 6,173 half up. Shown as 61.73, never 61.728 or 61.72.
    expect(view.cashBalanceMinor).toBe("6173");
    expect(view.displayBalance).toBe("61.73");
  });

  it("shows no internal identifier: no card id, no customer id, no version id", async () => {
    const view = await getPublicMoneyCardView(shareToken);
    const serialised = JSON.stringify(view);

    const card = await migratorPrisma().customerCard.findFirstOrThrow({
      where: { shareToken },
      select: { id: true, customerBusinessProfileId: true, programVersionId: true, businessId: true },
    });
    for (const id of [card.id, card.customerBusinessProfileId, card.programVersionId, card.businessId]) {
      expect(serialised).not.toContain(id);
    }
  });

  it("offers no action — the view is data only", async () => {
    const view = await getPublicMoneyCardView(shareToken);
    // Nothing on it names an operation the holder could perform.
    for (const key of Object.keys(view)) {
      expect(key).not.toMatch(/earn|redeem|reverse|discountApply|submit/i);
    }
  });
});

describe("what it refuses to answer", () => {
  it("gives the same not-found for an unknown, a short and a stamp card's token", async () => {
    const cafe = await createStampCafe({ name: "Stamps" });
    const stampCard = await migratorPrisma().customerCard.findFirst({
      where: { businessId: cafe.businessId },
      select: { shareToken: true },
    });

    await expect(getPublicMoneyCardView("does-not-exist-at-all-x")).rejects.toThrow(/Card not found/);
    await expect(getPublicMoneyCardView("short")).rejects.toThrow(/Card not found/);
    if (stampCard) {
      // A real card, for a real business — and still exactly the same answer, because this reader
      // does not confirm the existence of what it will not render.
      await expect(getPublicMoneyCardView(stampCard.shareToken)).rejects.toThrow(/Card not found/);
    }
  });

  it("is keyed on the PAGE token, not the scanner token", async () => {
    const card = await migratorPrisma().customerCard.findFirstOrThrow({
      where: { shareToken },
      select: { qrToken: true },
    });
    // A cashier who scanned the QR still cannot open the customer's page from it.
    await expect(getPublicMoneyCardView(card.qrToken)).rejects.toThrow(/Card not found/);
  });
});

describe("the page picks its reader by card type", () => {
  it("reports the kind, so the page never hands a money card to the stamp reader", async () => {
    expect(await getPublicCardKind(shareToken)).toBe("CASHBACK");
  });

  it("proves why that matters: the stamp reader refuses a money card as CORRUPTION, not as absence", async () => {
    /*
     * This is the enum-expansion hazard Prompt 1 found in twelve places, caught here in a
     * thirteenth. `getPublicCardView` parses STAMP mechanics on every path, so a cashback card
     * produces a message about invalid stamp mechanics — which reads as a broken row and would send
     * somebody looking for data corruption that does not exist. The page therefore asks the kind
     * first rather than trying one reader and falling back.
     */
    await expect(getPublicCardView(shareToken)).rejects.toThrow();
    await expect(getPublicCardView(shareToken)).rejects.not.toThrow(/Card not found/);
  });
});
