import { CardStatus, CardType, MembershipRole, OperationSource, Permission } from "@prisma/client";
import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/server/db";
import { applyDiscount, earnCashback, redeemCashback, reverseMonetaryOperation } from "@/server/monetary/engine";
import { createMonetaryProgram } from "@/server/monetary/rules";
import { findCardByQrToken } from "@/server/customers/lookup";
import { getProgramDetail, getScannerScope } from "@/server/program/program-detail";
import { createDraftVersion } from "@/server/program/versions";
import type { TenantContext } from "@/server/tenant/context";
import {
  createLocation,
  createMonetaryShop,
  createStaff,
  enrolMonetaryCustomer,
  resetDatabase,
  type MonetaryShopFixture,
} from "../setup/fixtures";

/**
 * The cashback and discount engines, through the real services against a real database.
 *
 * Every assertion here is about MONEY, so each one states the arithmetic it expects rather than
 * checking that a call returned something. Where a number is rounded, the test says what the exact
 * value was and which way it went.
 */

let key = 0;
const nextKey = () => `idem-${Date.now()}-${(key += 1)}-padding`;

beforeEach(resetDatabase);

async function cardFor(fx: MonetaryShopFixture) {
  const e = await enrolMonetaryCustomer(fx);
  return e.customerCardId;
}

async function rowsFor(customerCardId: string) {
  return prisma.monetaryOperation.findMany({ where: { customerCardId }, orderBy: { cardSequence: "asc" } });
}

// ─── Earning ──────────────────────────────────────────────────────────────────

describe("earning cashback on an invoice", () => {
  it("credits the rate applied to the invoice, and changes nothing about what is collected today", async () => {
    const fx = await createMonetaryShop(); // 5%
    const cardId = await cardFor(fx);

    // 5% of 100,000 minor units = 5,000.
    const r = await earnCashback(fx.ctx, {
      customerCardId: cardId,
      grossAmountMinor: 100_000n,
      idempotencyKey: nextKey(),
      source: OperationSource.SCANNER,
    });

    expect(r.kind).toBe("CASHBACK_EARNED");
    expect(r.cashEffectMinor).toBe("5000");
    expect(r.cashBalanceAfterMinor).toBe("5000");
    // The customer still pays the whole bill. Earning is not a discount.
    expect(r.netCounterAmountMinor).toBe("100000");
    expect(r.grossAmountMinor).toBe("100000");
    expect(r.rateBasisPoints).toBe(500);
    expect(r.monetaryTierId).toBe(fx.baseTierId);
    expect(r.discountMinor).toBeNull();
    expect(r.requestedRedemptionMinor).toBeNull();
    expect(r.currency).toBe("SYP");
    expect(r.currencyExponent).toBe(2);
    expect(r.display).toEqual({ gross: "1000.00", net: "1000.00", cashEffect: "50.00", balanceAfter: "50.00", discount: null });
  });

  it("rounds an exact half UP, as a person doing it on paper would", async () => {
    const fx = await createMonetaryShop({ tiers: [{ minCumulativeSpendMinor: 0, rateBasisPoints: 500 }] });
    const cardId = await cardFor(fx);

    // 5% of 10 minor units is exactly 0.5. Half-up gives 1; truncation would give 0.
    const r = await earnCashback(fx.ctx, {
      customerCardId: cardId,
      grossAmountMinor: 10n,
      idempotencyKey: nextKey(),
      source: OperationSource.SCANNER,
    });
    expect(r.cashEffectMinor).toBe("1");
  });

  it("chains each row's balance and sequence onto the one before it", async () => {
    const fx = await createMonetaryShop();
    const cardId = await cardFor(fx);

    for (const gross of [100_000n, 50_000n, 1n]) {
      await earnCashback(fx.ctx, { customerCardId: cardId, grossAmountMinor: gross, idempotencyKey: nextKey(), source: OperationSource.SCANNER });
    }

    const rows = await rowsFor(cardId);
    // 5,000 + 2,500 + 0 (5% of 1 is 0.05, which rounds down to nothing).
    expect(rows.map((r) => r.cashEffectMinor)).toEqual([5_000n, 2_500n, 0n]);
    expect(rows.map((r) => r.cashBalanceAfterMinor)).toEqual([5_000n, 7_500n, 7_500n]);
    expect(rows.map((r) => r.cardSequence)).toEqual([1n, 2n, 3n]);
  });

  it("carries the version the card is PINNED to, not the template's live one", async () => {
    const fx = await createMonetaryShop();
    const cardId = await cardFor(fx);
    const r = await earnCashback(fx.ctx, { customerCardId: cardId, grossAmountMinor: 1_000n, idempotencyKey: nextKey(), source: OperationSource.SCANNER });

    const row = await prisma.monetaryOperation.findUniqueOrThrow({ where: { id: r.operationId } });
    const card = await prisma.customerCard.findUniqueOrThrow({ where: { id: cardId } });
    expect(row.programVersionId).toBe(card.programVersionId);
    expect(row.monetaryRuleId).toBe(fx.program.monetaryRuleId);
  });

  it("leaves the int4 cashBalanceMinor projection alone — the chain is the balance", async () => {
    const fx = await createMonetaryShop();
    const cardId = await cardFor(fx);
    await earnCashback(fx.ctx, { customerCardId: cardId, grossAmountMinor: 100_000n, idempotencyKey: nextKey(), source: OperationSource.SCANNER });

    // D33: the legacy column is an int4 and is deliberately not used. If this ever starts failing,
    // something began writing a second copy of the balance that can drift from the history.
    const card = await prisma.customerCard.findUniqueOrThrow({ where: { id: cardId } });
    expect(card.cashBalanceMinor).toBe(0);
  });
});

// ─── Tier boundaries ──────────────────────────────────────────────────────────

describe("which tier applies", () => {
  const TIERS = [
    { minCumulativeSpendMinor: 0, rateBasisPoints: 100 }, // 1%
    { minCumulativeSpendMinor: 100_000, rateBasisPoints: 500 }, // 5% from 100,000
    { minCumulativeSpendMinor: 500_000, rateBasisPoints: 1_000 }, // 10% from 500,000
  ];

  it("starts a card with no history on the first tier", async () => {
    const fx = await createMonetaryShop({ tiers: TIERS });
    const cardId = await cardFor(fx);
    const r = await earnCashback(fx.ctx, { customerCardId: cardId, grossAmountMinor: 10_000n, idempotencyKey: nextKey(), source: OperationSource.SCANNER });
    expect(r.rateBasisPoints).toBe(100);
    expect(r.cashEffectMinor).toBe("100");
  });

  it("moves up EXACTLY AT the threshold, not one unit later", async () => {
    const fx = await createMonetaryShop({ tiers: TIERS });
    const cardId = await cardFor(fx);

    // One unit short of the threshold: still 1%.
    await earnCashback(fx.ctx, { customerCardId: cardId, grossAmountMinor: 99_999n, idempotencyKey: nextKey(), source: OperationSource.SCANNER });
    const below = await earnCashback(fx.ctx, { customerCardId: cardId, grossAmountMinor: 1_000n, idempotencyKey: nextKey(), source: OperationSource.SCANNER });
    expect(below.rateBasisPoints).toBe(100);

    // Cumulative spend is now 100,999 — at or above 100,000, so the next earns at 5%.
    const at = await earnCashback(fx.ctx, { customerCardId: cardId, grossAmountMinor: 1_000n, idempotencyKey: nextKey(), source: OperationSource.SCANNER });
    expect(at.rateBasisPoints).toBe(500);
  });

  it("selects the tier from spend BEFORE this invoice, not including it (D35)", async () => {
    const fx = await createMonetaryShop({ tiers: TIERS });
    const cardId = await cardFor(fx);

    // A single 500,000 invoice on a brand-new card earns at 1%, not 10%: the customer's history is
    // empty at the moment the rate is chosen. This is the documented reading and it is asserted
    // here so that changing it cannot happen silently.
    const r = await earnCashback(fx.ctx, { customerCardId: cardId, grossAmountMinor: 500_000n, idempotencyKey: nextKey(), source: OperationSource.SCANNER });
    expect(r.rateBasisPoints).toBe(100);
    expect(r.cashEffectMinor).toBe("5000");

    const next = await earnCashback(fx.ctx, { customerCardId: cardId, grossAmountMinor: 1_000n, idempotencyKey: nextKey(), source: OperationSource.SCANNER });
    expect(next.rateBasisPoints).toBe(1_000);
  });

  it("stops counting a sale that has been reversed", async () => {
    const fx = await createMonetaryShop({ tiers: TIERS });
    const cardId = await cardFor(fx);

    const big = await earnCashback(fx.ctx, { customerCardId: cardId, grossAmountMinor: 500_000n, idempotencyKey: nextKey(), source: OperationSource.SCANNER });
    // Spend now qualifies for 10%...
    const before = await earnCashback(fx.ctx, { customerCardId: cardId, grossAmountMinor: 1_000n, idempotencyKey: nextKey(), source: OperationSource.SCANNER });
    expect(before.rateBasisPoints).toBe(1_000);

    // ...until the sale is withdrawn, at which point it must stop counting towards the tier.
    await reverseMonetaryOperation(fx.ctx, { monetaryOperationId: big.operationId, reason: "voided at the till", idempotencyKey: nextKey(), source: OperationSource.SCANNER });

    const after = await earnCashback(fx.ctx, { customerCardId: cardId, grossAmountMinor: 1_000n, idempotencyKey: nextKey(), source: OperationSource.SCANNER });
    expect(after.rateBasisPoints).toBe(100);
  });
});

// ─── Currencies that are not two decimal places ───────────────────────────────

describe("currency precision is read, never assumed", () => {
  it("records a three-decimal currency in its own unit (JOD)", async () => {
    const fx = await createMonetaryShop({ currency: "JOD" });
    const cardId = await cardFor(fx);

    // 25.000 JOD = 25,000 minor units at exponent 3. 5% = 1,250 = 1.250 JOD.
    const r = await earnCashback(fx.ctx, { customerCardId: cardId, grossAmountMinor: 25_000n, idempotencyKey: nextKey(), source: OperationSource.SCANNER });
    expect(r.currency).toBe("JOD");
    expect(r.currencyExponent).toBe(3);
    expect(r.cashEffectMinor).toBe("1250");
    expect(r.display.cashEffect).toBe("1.250");
    expect(r.display.gross).toBe("25.000");
  });

  it("records a zero-decimal currency with no decimal point at all (JPY)", async () => {
    const fx = await createMonetaryShop({ currency: "JPY" });
    const cardId = await cardFor(fx);

    // 2,500 yen; there are no sub-units. 5% = 125.
    const r = await earnCashback(fx.ctx, { customerCardId: cardId, grossAmountMinor: 2_500n, idempotencyKey: nextKey(), source: OperationSource.SCANNER });
    expect(r.currencyExponent).toBe(0);
    expect(r.cashEffectMinor).toBe("125");
    expect(r.display.gross).toBe("2500");
    expect(r.display.cashEffect).toBe("125");
  });

  it("refuses to configure a program in a currency whose exponent this product does not record", async () => {
    const base = await createMonetaryShop();
    await prisma.business.update({ where: { id: base.businessId }, data: { currency: "XYZ" } });
    await expect(
      createMonetaryProgram(base.ctx, {
        name: "Another",
        kind: "CASHBACK",
        mechanics: { kind: "CASHBACK", contractVersion: 1 },
        tiers: [{ minCumulativeSpendMinor: 0, rateBasisPoints: 500 }],
        allowAdditionalProgram: true,
      }),
    ).rejects.toThrow(/does not record how many decimal places XYZ/);
  });

  it("freezes the currency on the row, so changing the business's currency cannot reinterpret history", async () => {
    const fx = await createMonetaryShop();
    const cardId = await cardFor(fx);
    const r = await earnCashback(fx.ctx, { customerCardId: cardId, grossAmountMinor: 25_000n, idempotencyKey: nextKey(), source: OperationSource.SCANNER });

    await prisma.business.update({ where: { id: fx.businessId }, data: { currency: "JOD" } });

    const row = await prisma.monetaryOperation.findUniqueOrThrow({ where: { id: r.operationId } });
    expect(row.currency).toBe("SYP");
    expect(row.currencyExponent).toBe(2);
  });
});

// ─── Redemption ───────────────────────────────────────────────────────────────

describe("spending cashback", () => {
  async function shopWithBalance(balanceGross = 200_000n) {
    const fx = await createMonetaryShop();
    const cardId = await cardFor(fx);
    await earnCashback(fx.ctx, { customerCardId: cardId, grossAmountMinor: balanceGross, idempotencyKey: nextKey(), source: OperationSource.SCANNER });
    return { fx, cardId };
  }

  it("takes the requested amount off the bill and off the balance", async () => {
    const { fx, cardId } = await shopWithBalance(); // 10,000 on the card
    const r = await redeemCashback(fx.ctx, {
      customerCardId: cardId,
      grossAmountMinor: 50_000n,
      requestedRedemptionMinor: 4_000n,
      idempotencyKey: nextKey(),
      source: OperationSource.SCANNER,
    });

    expect(r.kind).toBe("CASHBACK_REDEEMED");
    expect(r.requestedRedemptionMinor).toBe("4000");
    expect(r.cashEffectMinor).toBe("-4000");
    expect(r.netCounterAmountMinor).toBe("46000"); // 50,000 − 4,000
    expect(r.cashBalanceAfterMinor).toBe("6000");
    // A redemption is not rate-driven, so it claims no tier and no rate.
    expect(r.rateBasisPoints).toBeNull();
    expect(r.monetaryTierId).toBeNull();
  });

  it("caps at the balance, and records what was asked for alongside what was applied", async () => {
    const { fx, cardId } = await shopWithBalance(); // 10,000 on the card
    const r = await redeemCashback(fx.ctx, {
      customerCardId: cardId,
      grossAmountMinor: 90_000n,
      requestedRedemptionMinor: 25_000n,
      idempotencyKey: nextKey(),
      source: OperationSource.SCANNER,
    });

    expect(r.requestedRedemptionMinor).toBe("25000"); // what the cashier typed
    expect(r.cashEffectMinor).toBe("-10000"); // what could actually come off
    expect(r.netCounterAmountMinor).toBe("80000");
    expect(r.cashBalanceAfterMinor).toBe("0");
  });

  it("caps at the INVOICE, which is what keeps this from being a cash withdrawal", async () => {
    const { fx, cardId } = await shopWithBalance(); // 10,000 on the card
    const r = await redeemCashback(fx.ctx, {
      customerCardId: cardId,
      grossAmountMinor: 3_000n, // a small bill
      requestedRedemptionMinor: 10_000n,
      idempotencyKey: nextKey(),
      source: OperationSource.SCANNER,
    });

    // 3,000 comes off; the remaining 7,000 stays on the card rather than being handed over as cash.
    expect(r.cashEffectMinor).toBe("-3000");
    expect(r.netCounterAmountMinor).toBe("0");
    expect(r.cashBalanceAfterMinor).toBe("7000");
  });

  it("never drives the balance below zero", async () => {
    const { fx, cardId } = await shopWithBalance();
    await redeemCashback(fx.ctx, { customerCardId: cardId, grossAmountMinor: 500_000n, requestedRedemptionMinor: 10_000n, idempotencyKey: nextKey(), source: OperationSource.SCANNER });

    await expect(
      redeemCashback(fx.ctx, { customerCardId: cardId, grossAmountMinor: 500_000n, requestedRedemptionMinor: 1n, idempotencyKey: nextKey(), source: OperationSource.SCANNER }),
    ).rejects.toThrow(/no cashback to spend/);

    const rows = await rowsFor(cardId);
    expect(rows.at(-1)?.cashBalanceAfterMinor).toBe(0n);
  });

  it("refuses a card that has never earned anything", async () => {
    const fx = await createMonetaryShop();
    const cardId = await cardFor(fx);
    await expect(
      redeemCashback(fx.ctx, { customerCardId: cardId, grossAmountMinor: 10_000n, requestedRedemptionMinor: 100n, idempotencyKey: nextKey(), source: OperationSource.SCANNER }),
    ).rejects.toThrow(/no cashback to spend/);
  });

  it("refuses a redemption of nothing", async () => {
    const { fx, cardId } = await shopWithBalance();
    await expect(
      redeemCashback(fx.ctx, { customerCardId: cardId, grossAmountMinor: 10_000n, requestedRedemptionMinor: 0n, idempotencyKey: nextKey(), source: OperationSource.SCANNER }),
    ).rejects.toThrow(/more than zero/);
  });
});

// ─── Discount ─────────────────────────────────────────────────────────────────

describe("applying a discount", () => {
  it("calculates the discount and the net, and leaves the cashback balance alone", async () => {
    const fx = await createMonetaryShop({ kind: "DISCOUNT", tiers: [{ minCumulativeSpendMinor: 0, rateBasisPoints: 1_500 }] });
    const cardId = await cardFor(fx);

    // 15% of 33,333 is 4,999.95 → 5,000 half-up. Net is 28,333.
    const r = await applyDiscount(fx.ctx, { customerCardId: cardId, grossAmountMinor: 33_333n, idempotencyKey: nextKey(), source: OperationSource.SCANNER });

    expect(r.kind).toBe("DISCOUNT_APPLIED");
    expect(r.discountMinor).toBe("5000");
    expect(r.netCounterAmountMinor).toBe("28333");
    expect(r.cashEffectMinor).toBe("0");
    expect(r.cashBalanceAfterMinor).toBe("0");
    expect(r.rateBasisPoints).toBe(1_500);
  });

  it("can never discount more than the invoice, even at 100%", async () => {
    const fx = await createMonetaryShop({ kind: "DISCOUNT", tiers: [{ minCumulativeSpendMinor: 0, rateBasisPoints: 10_000 }] });
    const cardId = await cardFor(fx);
    const r = await applyDiscount(fx.ctx, { customerCardId: cardId, grossAmountMinor: 12_345n, idempotencyKey: nextKey(), source: OperationSource.SCANNER });
    expect(r.discountMinor).toBe("12345");
    expect(r.netCounterAmountMinor).toBe("0");
  });

  it("refuses a cashback card, and a cashback program refuses a discount card", async () => {
    const cashback = await createMonetaryShop();
    const cashbackCard = await cardFor(cashback);
    await expect(
      applyDiscount(cashback.ctx, { customerCardId: cashbackCard, grossAmountMinor: 1_000n, idempotencyKey: nextKey(), source: OperationSource.SCANNER }),
    ).rejects.toThrow(/is a CASHBACK program, not DISCOUNT/);

    const discount = await createMonetaryShop({ kind: "DISCOUNT", existing: cashback, name: "Discount card" });
    const discountCard = await cardFor(discount);
    await expect(
      earnCashback(discount.ctx, { customerCardId: discountCard, grossAmountMinor: 1_000n, idempotencyKey: nextKey(), source: OperationSource.SCANNER }),
    ).rejects.toThrow(/is a DISCOUNT program, not CASHBACK/);
  });
});

// ─── Idempotency and concurrency ──────────────────────────────────────────────

describe("a repeated submission is not a second operation", () => {
  it("replays the original response and writes nothing new", async () => {
    const fx = await createMonetaryShop();
    const cardId = await cardFor(fx);
    const k = nextKey();
    const args = { customerCardId: cardId, grossAmountMinor: 100_000n, idempotencyKey: k, source: OperationSource.SCANNER } as const;

    const first = await earnCashback(fx.ctx, args);
    const second = await earnCashback(fx.ctx, args);

    expect(second).toEqual(first);
    expect(await prisma.monetaryOperation.count({ where: { customerCardId: cardId } })).toBe(1);
  });

  it("refuses the same key with a different invoice", async () => {
    const fx = await createMonetaryShop();
    const cardId = await cardFor(fx);
    const k = nextKey();
    await earnCashback(fx.ctx, { customerCardId: cardId, grossAmountMinor: 100_000n, idempotencyKey: k, source: OperationSource.SCANNER });

    await expect(
      earnCashback(fx.ctx, { customerCardId: cardId, grossAmountMinor: 200_000n, idempotencyKey: k, source: OperationSource.SCANNER }),
    ).rejects.toThrow(/Idempotenc/i);
    expect(await prisma.monetaryOperation.count({ where: { customerCardId: cardId } })).toBe(1);
  });

  it("serialises two simultaneous redemptions of one balance, on independent connections", async () => {
    const fx = await createMonetaryShop();
    const cardId = await cardFor(fx);
    // 10,000 on the card.
    await earnCashback(fx.ctx, { customerCardId: cardId, grossAmountMinor: 200_000n, idempotencyKey: nextKey(), source: OperationSource.SCANNER });

    /*
     * DIFFERENT idempotency keys, so nothing is deduplicated: these are two genuinely distinct
     * operations racing for one balance, which is the case the card lock exists for. Both ask for
     * the whole 10,000; between them they must remove exactly 10,000 and no more.
     */
    const attempt = (k: string) =>
      redeemCashback(fx.ctx, {
        customerCardId: cardId,
        grossAmountMinor: 500_000n,
        requestedRedemptionMinor: 10_000n,
        idempotencyKey: k,
        source: OperationSource.SCANNER,
      }).then(
        (r) => ({ ok: true as const, r }),
        (e: Error) => ({ ok: false as const, e }),
      );

    const [a, b] = await Promise.all([attempt(nextKey()), attempt(nextKey())]);
    const succeeded = [a, b].filter((x) => x.ok);

    // Exactly one takes the money; the other finds nothing left rather than overdrawing.
    expect(succeeded).toHaveLength(1);
    const rows = await rowsFor(cardId);
    expect(rows.at(-1)?.cashBalanceAfterMinor).toBe(0n);
    expect(rows.filter((r) => r.kind === "CASHBACK_REDEEMED")).toHaveLength(1);
  });

  it("never lets two concurrent earnings share a sequence number", async () => {
    const fx = await createMonetaryShop();
    const cardId = await cardFor(fx);

    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        earnCashback(fx.ctx, { customerCardId: cardId, grossAmountMinor: 100_000n, idempotencyKey: nextKey(), source: OperationSource.SCANNER }).then(
          () => true,
          () => false,
        ),
      ),
    );

    const rows = await rowsFor(cardId);
    expect(rows).toHaveLength(results.filter(Boolean).length);
    // Contiguous from 1, and each balance follows its predecessor exactly.
    expect(rows.map((r) => r.cardSequence)).toEqual(rows.map((_, i) => BigInt(i + 1)));
    let running = 0n;
    for (const row of rows) {
      running += row.cashEffectMinor;
      expect(row.cashBalanceAfterMinor).toBe(running);
    }
  });
});

// ─── Reversal ─────────────────────────────────────────────────────────────────

describe("undoing a money operation", () => {
  it("writes a linked row that cancels the effect, and leaves both visible", async () => {
    const fx = await createMonetaryShop();
    const cardId = await cardFor(fx);
    const earned = await earnCashback(fx.ctx, { customerCardId: cardId, grossAmountMinor: 100_000n, idempotencyKey: nextKey(), source: OperationSource.SCANNER });

    const rev = await reverseMonetaryOperation(fx.ctx, {
      monetaryOperationId: earned.operationId,
      reason: "rang up the wrong customer",
      idempotencyKey: nextKey(),
      source: OperationSource.SCANNER,
    });

    expect(rev.kind).toBe("REVERSAL");
    expect(rev.cashEffectMinor).toBe("-5000");
    expect(rev.cashBalanceAfterMinor).toBe("0");
    // A reversal asserts no invoice of its own, so it cannot inflate spend.
    expect(rev.grossAmountMinor).toBe("0");
    expect(rev.netCounterAmountMinor).toBe("0");
    expect(rev.reversalOfId).toBe(earned.operationId);

    const rows = await rowsFor(cardId);
    expect(rows).toHaveLength(2);
    expect(rows[0].id).toBe(earned.operationId);
  });

  it("gives spent cashback back when a redemption is undone", async () => {
    const fx = await createMonetaryShop();
    const cardId = await cardFor(fx);
    await earnCashback(fx.ctx, { customerCardId: cardId, grossAmountMinor: 200_000n, idempotencyKey: nextKey(), source: OperationSource.SCANNER });
    const spent = await redeemCashback(fx.ctx, { customerCardId: cardId, grossAmountMinor: 50_000n, requestedRedemptionMinor: 4_000n, idempotencyKey: nextKey(), source: OperationSource.SCANNER });
    expect(spent.cashBalanceAfterMinor).toBe("6000");

    const rev = await reverseMonetaryOperation(fx.ctx, { monetaryOperationId: spent.operationId, reason: "customer changed their mind", idempotencyKey: nextKey(), source: OperationSource.SCANNER });
    expect(rev.cashEffectMinor).toBe("4000");
    expect(rev.cashBalanceAfterMinor).toBe("10000");
  });

  it("moves no money when a discount is undone, because a discount moved none", async () => {
    const fx = await createMonetaryShop({ kind: "DISCOUNT", tiers: [{ minCumulativeSpendMinor: 0, rateBasisPoints: 1_000 }] });
    const cardId = await cardFor(fx);
    const d = await applyDiscount(fx.ctx, { customerCardId: cardId, grossAmountMinor: 10_000n, idempotencyKey: nextKey(), source: OperationSource.SCANNER });

    const rev = await reverseMonetaryOperation(fx.ctx, { monetaryOperationId: d.operationId, reason: "not eligible after all", idempotencyKey: nextKey(), source: OperationSource.SCANNER });
    expect(rev.cashEffectMinor).toBe("0");
    expect(rev.cashBalanceAfterMinor).toBe("0");
  });

  it("refuses to take back cashback the customer has already spent", async () => {
    const fx = await createMonetaryShop();
    const cardId = await cardFor(fx);
    const earned = await earnCashback(fx.ctx, { customerCardId: cardId, grossAmountMinor: 200_000n, idempotencyKey: nextKey(), source: OperationSource.SCANNER });
    await redeemCashback(fx.ctx, { customerCardId: cardId, grossAmountMinor: 50_000n, requestedRedemptionMinor: 10_000n, idempotencyKey: nextKey(), source: OperationSource.SCANNER });

    // The honest answer is "the value is gone", not a negative balance the customer has to pay off.
    await expect(
      reverseMonetaryOperation(fx.ctx, { monetaryOperationId: earned.operationId, reason: "too late", idempotencyKey: nextKey(), source: OperationSource.SCANNER }),
    ).rejects.toThrow(/already been spent/);
  });

  it("can happen exactly once, and cannot itself be reversed", async () => {
    const fx = await createMonetaryShop();
    const cardId = await cardFor(fx);
    const earned = await earnCashback(fx.ctx, { customerCardId: cardId, grossAmountMinor: 100_000n, idempotencyKey: nextKey(), source: OperationSource.SCANNER });
    const rev = await reverseMonetaryOperation(fx.ctx, { monetaryOperationId: earned.operationId, reason: "mistake", idempotencyKey: nextKey(), source: OperationSource.SCANNER });

    await expect(
      reverseMonetaryOperation(fx.ctx, { monetaryOperationId: earned.operationId, reason: "again", idempotencyKey: nextKey(), source: OperationSource.SCANNER }),
    ).rejects.toThrow(/already been reversed/);

    await expect(
      reverseMonetaryOperation(fx.ctx, { monetaryOperationId: rev.operationId, reason: "undo the undo", idempotencyKey: nextKey(), source: OperationSource.SCANNER }),
    ).rejects.toThrow(/cannot itself be reversed/);
  });

  it("insists on a reason, and refuses a location", async () => {
    const fx = await createMonetaryShop();
    const cardId = await cardFor(fx);
    const earned = await earnCashback(fx.ctx, { customerCardId: cardId, grossAmountMinor: 100_000n, idempotencyKey: nextKey(), source: OperationSource.SCANNER });

    await expect(
      reverseMonetaryOperation(fx.ctx, { monetaryOperationId: earned.operationId, reason: "   ", idempotencyKey: nextKey(), source: OperationSource.SCANNER }),
    ).rejects.toThrow(/must record why/);

    await expect(
      reverseMonetaryOperation(fx.ctx, {
        monetaryOperationId: earned.operationId,
        reason: "fine",
        idempotencyKey: nextKey(),
        source: OperationSource.SCANNER,
        locationId: "somewhere",
      } as never),
    ).rejects.toThrow(/locationId cannot be supplied/);
  });

  it("is attributed to the original's counter, not the reverser's", async () => {
    const branchId = await (async () => {
      const fx0 = await createMonetaryShop();
      return { fx: fx0, id: await createLocation(fx0, "فرع") };
    })();
    const fx = await createMonetaryShop({
      existing: { userId: branchId.fx.userId, businessId: branchId.fx.businessId, locationId: branchId.fx.locationId },
      name: "Branch cashback",
      mechanics: { availableLocations: [branchId.id] },
    });
    const cardId = await cardFor(fx);

    const earned = await earnCashback(fx.ctx, { customerCardId: cardId, grossAmountMinor: 100_000n, idempotencyKey: nextKey(), source: OperationSource.SCANNER });
    expect(earned.locationId).toBe(branchId.id);

    const rev = await reverseMonetaryOperation(fx.ctx, { monetaryOperationId: earned.operationId, reason: "mistake", idempotencyKey: nextKey(), source: OperationSource.SCANNER });
    expect(rev.locationId).toBe(branchId.id);
  });

  it("still works on a card that has since been paused, because a correction must be possible", async () => {
    const fx = await createMonetaryShop();
    const cardId = await cardFor(fx);
    const earned = await earnCashback(fx.ctx, { customerCardId: cardId, grossAmountMinor: 100_000n, idempotencyKey: nextKey(), source: OperationSource.SCANNER });
    await prisma.customerCard.update({ where: { id: cardId }, data: { status: CardStatus.PAUSED } });

    const rev = await reverseMonetaryOperation(fx.ctx, { monetaryOperationId: earned.operationId, reason: "mistake", idempotencyKey: nextKey(), source: OperationSource.SCANNER });
    expect(rev.cashBalanceAfterMinor).toBe("0");
  });
});

// ─── Card state, limits and windows ───────────────────────────────────────────

describe("when a card may not transact", () => {
  it("refuses a paused, expired or deleted card", async () => {
    const fx = await createMonetaryShop();
    for (const status of [CardStatus.PAUSED, CardStatus.EXPIRED, CardStatus.DELETED]) {
      const cardId = await cardFor(fx);
      await prisma.customerCard.update({ where: { id: cardId }, data: { status } });
      await expect(
        earnCashback(fx.ctx, { customerCardId: cardId, grossAmountMinor: 1_000n, idempotencyKey: nextKey(), source: OperationSource.SCANNER }),
      ).rejects.toThrow(/cannot transact/);
    }
  });

  it("refuses a card whose expiry date has passed", async () => {
    const fx = await createMonetaryShop();
    const cardId = await cardFor(fx);
    await prisma.customerCard.update({ where: { id: cardId }, data: { expiresAt: new Date(Date.now() - 1_000) } });
    await expect(
      earnCashback(fx.ctx, { customerCardId: cardId, grossAmountMinor: 1_000n, idempotencyKey: nextKey(), source: OperationSource.SCANNER }),
    ).rejects.toThrow(/expired/);
  });

  it("enforces the daily operation limit, and still allows a correction", async () => {
    const fx = await createMonetaryShop({ mechanics: { dailyOperationLimit: 2 } });
    const cardId = await cardFor(fx);

    const a = await earnCashback(fx.ctx, { customerCardId: cardId, grossAmountMinor: 1_000n, idempotencyKey: nextKey(), source: OperationSource.SCANNER });
    await earnCashback(fx.ctx, { customerCardId: cardId, grossAmountMinor: 1_000n, idempotencyKey: nextKey(), source: OperationSource.SCANNER });

    await expect(
      earnCashback(fx.ctx, { customerCardId: cardId, grossAmountMinor: 1_000n, idempotencyKey: nextKey(), source: OperationSource.SCANNER }),
    ).rejects.toThrow(/daily limit/);

    // A reversal is a correction, not a third sale, so the limit does not block it.
    await expect(
      reverseMonetaryOperation(fx.ctx, { monetaryOperationId: a.operationId, reason: "mistake", idempotencyKey: nextKey(), source: OperationSource.SCANNER }),
    ).resolves.toBeDefined();
  });

  it("refuses an invoice larger than this product will record", async () => {
    const fx = await createMonetaryShop();
    const cardId = await cardFor(fx);
    await expect(
      earnCashback(fx.ctx, { customerCardId: cardId, grossAmountMinor: 1_000_000_000_000_001n, idempotencyKey: nextKey(), source: OperationSource.SCANNER }),
    ).rejects.toThrow(/larger than this product will record/);
  });
});

// ─── Tenancy and permissions ──────────────────────────────────────────────────

describe("who may do what, and to whose cards", () => {
  it("cannot touch another business's card, and says 'not found' rather than confirming it exists", async () => {
    const mine = await createMonetaryShop();
    const theirs = await createMonetaryShop();
    const theirCard = await cardFor(theirs);

    await expect(
      earnCashback(mine.ctx, { customerCardId: theirCard, grossAmountMinor: 1_000n, idempotencyKey: nextKey(), source: OperationSource.SCANNER }),
    ).rejects.toThrow(/Card not found/);

    const theirOp = await earnCashback(theirs.ctx, { customerCardId: theirCard, grossAmountMinor: 100_000n, idempotencyKey: nextKey(), source: OperationSource.SCANNER });
    await expect(
      reverseMonetaryOperation(mine.ctx, { monetaryOperationId: theirOp.operationId, reason: "nope", idempotencyKey: nextKey(), source: OperationSource.SCANNER }),
    ).rejects.toThrow(/Operation not found/);
  });

  /*
   * A NOTE ON HOW THESE TWO ARE BUILT, because it is not the obvious way.
   *
   * `effectivePermissions` is `role defaults ∪ explicit grants` - the membership's `permissions`
   * column ADDS, it does not restrict. Every CASHIER therefore holds MAKE_ACCRUALS and
   * MAKE_REDEMPTIONS, and no role this product currently defines grants one without the other. So a
   * test that tried to produce the split by writing the column would silently prove nothing: the
   * context would come back holding both and the call would succeed for the wrong reason.
   *
   * These tests instead take a REAL membership context and narrow its permission set, which is
   * exactly what the guard reads. What they establish is that the guard enforces the split; what
   * they do NOT establish - and no test can, today - is that a real role can be in that state.
   * Recorded as such rather than dressed up: if a future role separates the two, these become the
   * tests that stop the money engines from drifting apart on it.
   */
  const withPermissions = (ctx: TenantContext, permissions: Permission[]): TenantContext => ({
    ...ctx,
    permissions: new Set(permissions),
  });

  it("refuses redemption, discount and reversal to a context holding only MAKE_ACCRUALS", async () => {
    const fx = await createMonetaryShop();
    const cardId = await cardFor(fx);
    const earned = await earnCashback(fx.ctx, { customerCardId: cardId, grossAmountMinor: 200_000n, idempotencyKey: nextKey(), source: OperationSource.SCANNER });

    const staff = await createStaff(fx, MembershipRole.CASHIER, [fx.locationId]);
    const ctx = withPermissions(staff.ctx, [Permission.MAKE_ACCRUALS, Permission.VIEW_CUSTOMERS]);

    await expect(
      earnCashback(ctx, { customerCardId: cardId, grossAmountMinor: 1_000n, idempotencyKey: nextKey(), source: OperationSource.SCANNER }),
    ).resolves.toBeDefined();

    await expect(
      redeemCashback(ctx, { customerCardId: cardId, grossAmountMinor: 10_000n, requestedRedemptionMinor: 100n, idempotencyKey: nextKey(), source: OperationSource.SCANNER }),
    ).rejects.toThrow(/MAKE_REDEMPTIONS/);

    await expect(
      reverseMonetaryOperation(ctx, { monetaryOperationId: earned.operationId, reason: "x", idempotencyKey: nextKey(), source: OperationSource.SCANNER }),
    ).rejects.toThrow(/MAKE_REDEMPTIONS/);
  });

  it("refuses a reversal to a context holding only MAKE_REDEMPTIONS", async () => {
    const fx = await createMonetaryShop();
    const cardId = await cardFor(fx);
    const earned = await earnCashback(fx.ctx, { customerCardId: cardId, grossAmountMinor: 200_000n, idempotencyKey: nextKey(), source: OperationSource.SCANNER });

    const staff = await createStaff(fx, MembershipRole.CASHIER, [fx.locationId]);
    const ctx = withPermissions(staff.ctx, [Permission.MAKE_REDEMPTIONS, Permission.VIEW_CUSTOMERS]);

    // A reversal both removes and restores value, so it needs both halves.
    await expect(
      reverseMonetaryOperation(ctx, { monetaryOperationId: earned.operationId, reason: "x", idempotencyKey: nextKey(), source: OperationSource.SCANNER }),
    ).rejects.toThrow(/MAKE_ACCRUALS/);

    // ...and the discount engine agrees with the cashback engine about which half it needs.
    const discountShop = await createMonetaryShop({ kind: "DISCOUNT", existing: fx, name: "Discount too" });
    const discountCard = await cardFor(discountShop);
    await expect(
      applyDiscount(withPermissions(staff.ctx, [Permission.MAKE_ACCRUALS]), {
        customerCardId: discountCard,
        grossAmountMinor: 1_000n,
        idempotencyKey: nextKey(),
        source: OperationSource.SCANNER,
      }),
    ).rejects.toThrow(/MAKE_REDEMPTIONS/);
  });

  it("refuses a cashier without EDIT_TEMPLATES the right to set a rate", async () => {
    const fx = await createMonetaryShop();
    const staff = await createStaff(fx, MembershipRole.CASHIER, [fx.locationId]);
    await expect(
      createMonetaryProgram(staff.ctx, {
        name: "Mine now",
        kind: "CASHBACK",
        mechanics: { kind: "CASHBACK", contractVersion: 1 },
        tiers: [{ minCumulativeSpendMinor: 0, rateBasisPoints: 10_000 }],
        allowAdditionalProgram: true,
      }),
    ).rejects.toThrow(/EDIT_TEMPLATES/);
  });

  it("refuses a source that is not a counter", async () => {
    const fx = await createMonetaryShop();
    const cardId = await cardFor(fx);
    await expect(
      earnCashback(fx.ctx, { customerCardId: cardId, grossAmountMinor: 1_000n, idempotencyKey: nextKey(), source: OperationSource.API as never }),
    ).rejects.toThrow(/not a counter source/);
  });
});

// ─── The surfaces a money program is visible on ───────────────────────────────

describe("the screens a money program is reachable from", () => {
  /*
   * A money program appears in the owner's program list, so its detail page is one click away. Before
   * the enum audit that page read the version's mechanics through the STAMP contract and failed with
   * "does not hold valid stamp mechanics" - a 422 blaming the data, on a page an owner reaches by
   * clicking their own program.
   */
  it("loads the program detail page, with the stamp/points-only fields absent rather than zeroed", async () => {
    const fx = await createMonetaryShop({ kind: "CASHBACK" });
    const detail = await getProgramDetail(fx.ctx, fx.program.templateId);

    // What is true of a money program is present...
    expect(detail.cardType).toBe(CardType.CASHBACK);
    expect(detail.name).toBe("Cashback card");
    expect(detail.programVersionId).toBe(fx.program.programVersionId);

    // ...and what belongs to another kind of program is NULL, not a plausible zero. `earnRule:
    // { mode: "MANUAL" }` and `welcomeUnits: 0` would each be individually true and together
    // describe a stamp program.
    expect(detail.earnRule).toBeNull();
    expect(detail.stampReward).toBeNull();
    expect(detail.pointsLabel).toBeNull();
    expect(detail.dailyAwardLimit).toBeNull();
  });

  it("reports the counters a money program is pinned to, which the old ladder read as Main-only", async () => {
    const base = await createMonetaryShop();
    const branchId = await createLocation(base, "فرع الميدان");
    const fx = await createMonetaryShop({
      existing: { userId: base.userId, businessId: base.businessId, locationId: base.locationId },
      name: "Branch cashback",
      mechanics: { availableLocations: [branchId] },
    });

    const detail = await getProgramDetail(fx.ctx, fx.program.templateId);
    expect(detail.availableLocations?.map((l) => l.id)).toEqual([branchId]);
  });

  it("reports no rewards and no earn rule, so the screen has nothing stamp-shaped to render", async () => {
    /*
     * The detail page renders its rewards section only for the two kinds that have rewards, and its
     * "how it works" block only when there is an earn rule. Both are driven by these values, so this
     * asserts the DATA that makes the omission correct rather than asserting the markup.
     */
    const fx = await createMonetaryShop({ kind: "CASHBACK" });
    const detail = await getProgramDetail(fx.ctx, fx.program.templateId);
    expect(detail.tiers).toEqual([]);
    expect(detail.stampReward).toBeNull();
    expect(detail.earnRule).toBeNull();
    expect(detail.welcomeUnits).toBe(0);
  });

  it("keeps a money program out of the cashier's picker entirely", async () => {
    const fx = await createMonetaryShop();
    // Offering a program every write refuses is worse than not offering it: the cashier would have a
    // customer in front of them and no way to tell why nothing worked.
    const scope = await getScannerScope(fx.ctx);
    expect(scope.programs.map((p) => p.templateId)).not.toContain(fx.program.templateId);
  });

  it("resolves a money card through the normal scanner lookup", async () => {
    const fx = await createMonetaryShop();
    const cardId = await cardFor(fx);
    const card = await prisma.customerCard.findUniqueOrThrow({ where: { id: cardId }, select: { qrToken: true } });

    const resolved = await findCardByQrToken(fx.ctx, card.qrToken);
    expect(resolved.cardType).toBe("CASHBACK");
    if (resolved.cardType !== "CASHBACK" && resolved.cardType !== "DISCOUNT") throw new Error("expected money card");
    expect(resolved.money.cashBalanceMinor).toBe("0");
  });

  it("refuses to open a draft of a money program, because its rates are frozen to a version", async () => {
    const fx = await createMonetaryShop();
    await expect(createDraftVersion(fx.ctx, fx.program.templateId)).rejects.toThrow(/frozen to the version/);
  });
});

// ─── Configuration ────────────────────────────────────────────────────────────

describe("configuring a rate table", () => {
  it("refuses money hidden in the mechanics JSON, and says where it belongs", async () => {
    const fx = await createMonetaryShop();
    await expect(
      createMonetaryProgram(fx.ctx, {
        name: "Sneaky",
        kind: "CASHBACK",
        mechanics: { kind: "CASHBACK", contractVersion: 1, rateBasisPoints: 9_000 } as never,
        tiers: [{ minCumulativeSpendMinor: 0, rateBasisPoints: 100 }],
        allowAdditionalProgram: true,
      }),
    ).rejects.toThrow(/not part of its mechanics/);
  });

  it("insists the first tier starts at zero", async () => {
    const fx = await createMonetaryShop();
    await expect(
      createMonetaryProgram(fx.ctx, {
        name: "No base rate",
        kind: "CASHBACK",
        mechanics: { kind: "CASHBACK", contractVersion: 1 },
        tiers: [{ minCumulativeSpendMinor: 100_000, rateBasisPoints: 500 }],
        allowAdditionalProgram: true,
      }),
    ).rejects.toThrow(/first tier must start at zero/);
  });

  it("refuses two tiers at the same threshold", async () => {
    const fx = await createMonetaryShop();
    await expect(
      createMonetaryProgram(fx.ctx, {
        name: "Ambiguous",
        kind: "CASHBACK",
        mechanics: { kind: "CASHBACK", contractVersion: 1 },
        tiers: [
          { minCumulativeSpendMinor: 0, rateBasisPoints: 100 },
          { minCumulativeSpendMinor: 0, rateBasisPoints: 500 },
        ],
        allowAdditionalProgram: true,
      }),
    ).rejects.toThrow(/cannot share a threshold/);
  });

  it("stores tiers in threshold order however they were supplied", async () => {
    const fx = await createMonetaryShop({
      tiers: [
        { minCumulativeSpendMinor: 500_000, rateBasisPoints: 1_000 },
        { minCumulativeSpendMinor: 0, rateBasisPoints: 100 },
        { minCumulativeSpendMinor: 100_000, rateBasisPoints: 500 },
      ],
    });
    const tiers = await prisma.monetaryTier.findMany({
      where: { monetaryRuleId: fx.program.monetaryRuleId },
      orderBy: { tierIndex: "asc" },
    });
    expect(tiers.map((t) => [t.tierIndex, t.minCumulativeSpendMinor, t.rateBasisPoints])).toEqual([
      [0, 0n, 100],
      [1, 100_000n, 500],
      [2, 500_000n, 1_000],
    ]);
  });

  it("records who set the rates, with the rates, in the audit log", async () => {
    const fx = await createMonetaryShop();
    const entry = await prisma.auditLog.findFirstOrThrow({
      where: { businessId: fx.businessId, action: "monetary.rule_configured" },
    });
    expect(entry.actorUserId).toBe(fx.userId);
    expect(entry.entityId).toBe(fx.program.monetaryRuleId);
    const meta = entry.metadata as { currency: string; currencyExponent: number; tiers: { rateBasisPoints: number }[] };
    expect(meta.currency).toBe("SYP");
    expect(meta.currencyExponent).toBe(2);
    expect(meta.tiers[0].rateBasisPoints).toBe(500);
  });
});
