import { ValidationError } from "../errors";

/**
 * The arithmetic every Phase 4 money value goes through, and the only place it is defined.
 *
 * ## Why this file exists at all
 *
 * A cashback rate is a percentage, and a percentage of an integer is usually not an integer. That
 * one fact is where money bugs come from: somebody writes `gross * 0.05`, gets `1234.9999999999998`
 * back, and a customer's balance is a fraction of a piastre out — or, worse, `Math.round` is
 * applied in one place and `Math.floor` in another and the two disagree by one unit on exactly the
 * inputs a merchant will notice.
 *
 * So: **no JavaScript floating point touches money anywhere in this product.** Every value here is
 * a `bigint` of MINOR UNITS, every rate is an integer of basis points, and the rounding rule is
 * written once, below, in the same form the database trigger recomputes it in.
 *
 * ## Why `bigint` and not `number`
 *
 * `number` is a float. It happens to represent integers exactly up to 2^53-1, which is enough for
 * most currencies most of the time — and "most of the time" is not a property to build a ledger on.
 * The Syrian pound is the concrete case: at the time of writing a modest invoice runs to hundreds of
 * thousands of pounds, which is tens of millions of minor units, and a business's cumulative
 * qualified spend passes 2^31 quickly. The existing `LoyaltyOperation.purchaseAmountMinor` is an
 * `int4` and would overflow (registered as **D33**); every Phase 4 column is `BIGINT` instead.
 *
 * Using `bigint` in the domain means the overflow cannot be reintroduced by an intermediate
 * calculation either: `gross * rateBasisPoints` is the product that would exceed `int4` long before
 * the result does.
 *
 * ## Why the exponent is data and not the constant 2
 *
 * "Minor units" means nothing without saying how many of them make a major unit, and that number is
 * NOT two for every currency. JOD, KWD and BHD use three; JPY uses none. A product that hard-codes
 * `/ 100` shows a Kuwaiti merchant a bill ten times too large. The exponent therefore lives in the
 * `SupportedCurrency` table, is COPIED onto every rule and every operation at write time, and is
 * frozen there — so a row can always be read back in the unit it was written in, whatever anybody
 * later changes.
 *
 * Nothing in this file converts between currencies. There is no conversion layer in this product
 * and no rate source; a business's programme is denominated in that business's own currency and
 * that is the end of it.
 */

/**
 * The largest amount any Phase 4 column will hold: 10^15 minor units.
 *
 * Mirrors the `CHECK` constraints in migration 21 exactly. It is not a currency limit, it is a
 * sanity limit: an invoice of a quadrillion minor units is a typo or an attack, and refusing it in
 * the domain gives a sentence a person can read instead of a constraint-violation error. Keeping
 * the two in step matters — the database is the backstop, and a domain bound that were LARGER would
 * turn a user mistake into a 500.
 */
export const MAX_MINOR_AMOUNT = 1_000_000_000_000_000n;

/** Basis points: 10,000 of them make 100%. A rate is dimensionless, so no currency is involved. */
export const BASIS_POINTS_SCALE = 10_000;

/** The widest exponent `SupportedCurrency` accepts, matching its `CHECK`. */
export const MAX_CURRENCY_EXPONENT = 4;

/**
 * A percentage of an amount, rounded HALF-UP to the smallest valid unit of the currency.
 *
 * ```
 *   (gross × rateBasisPoints + 5000) / 10000     integer division, truncating
 * ```
 *
 * **Why half-up and not banker's rounding.** Half-up is what a person doing this on paper does, and
 * a cashier standing in front of a customer has to be able to check the number by hand. Banker's
 * rounding is better for large aggregates and worse for exactly this: it would round 2.5 to 2 and
 * 3.5 to 4, which is indefensible at a counter even though it is correct in a spreadsheet.
 *
 * **Why the `+ 5000` form rather than a comparison.** It is the same expression the database trigger
 * `walaaplus_validate_monetary_operation` recomputes before it will accept the row. Written the same
 * way in both places, the two cannot drift: if this function is ever changed and the trigger is not,
 * every write fails loudly rather than a mismatch being discovered in a balance months later.
 *
 * Truncating division equals flooring here because both operands are non-negative, which is
 * guaranteed by the callers below — `assertMinorAmount` refuses a negative gross and
 * `assertRateBasisPoints` refuses a negative rate. There is no path into this function with a
 * negative value, so there is no "round half away from zero versus half up" ambiguity to resolve.
 *
 * @param grossMinor  a non-negative amount in minor units
 * @param rateBasisPoints 0..10000
 */
export function percentageOfHalfUp(grossMinor: bigint, rateBasisPoints: number): bigint {
  assertMinorAmount(grossMinor, "grossAmountMinor");
  assertRateBasisPoints(rateBasisPoints);
  return (grossMinor * BigInt(rateBasisPoints) + 5_000n) / 10_000n;
}

/** A rate must be a whole number of basis points between 0% and 100%. */
export function assertRateBasisPoints(rate: unknown): asserts rate is number {
  if (typeof rate !== "number" || !Number.isInteger(rate) || rate < 0 || rate > BASIS_POINTS_SCALE) {
    throw new ValidationError(`A rate must be a whole number of basis points between 0 and ${BASIS_POINTS_SCALE}`);
  }
}

/** Every amount is a non-negative bigint of minor units within the column's bound. */
export function assertMinorAmount(value: unknown, field: string): asserts value is bigint {
  if (typeof value !== "bigint") {
    throw new ValidationError(`${field} must be an integer number of minor units`);
  }
  if (value < 0n) throw new ValidationError(`${field} cannot be negative`);
  if (value > MAX_MINOR_AMOUNT) {
    throw new ValidationError(`${field} is larger than this product will record (${MAX_MINOR_AMOUNT} minor units)`);
  }
}

/**
 * Turn whatever a caller supplied into a checked `bigint` of minor units.
 *
 * The boundary primitive, and deliberately strict about what it will read:
 *
 * | Input | Result | Why |
 * |---|---|---|
 * | `bigint` | itself | already exact |
 * | safe integer `number` | converted | JSON has no bigint; a small invoice arrives this way |
 * | unsafe integer `number` | **refused** | past 2^53 a `number` is already an approximation — accepting it would silently record a different invoice from the one typed |
 * | non-integer `number` | **refused** | `1250.5` minor units does not exist; the caller means a different exponent |
 * | digit `string` | converted | how a large amount crosses JSON without losing precision |
 * | `"12.50"`, `" 12"`, `"1e3"`, `""` | **refused** | a major-unit decimal is not a minor-unit amount, and guessing which the caller meant is exactly the mistake this file exists to prevent |
 *
 * There is no "parse a decimal price" function here on purpose. Converting `"12.50"` to minor units
 * requires the currency's exponent, and the exponent belongs to a rule that is loaded inside the
 * transaction — so that conversion happens where the rule is known, never at an anonymous boundary.
 */
export function parseMinorAmount(input: unknown, field: string): bigint {
  let value: bigint;
  if (typeof input === "bigint") {
    value = input;
  } else if (typeof input === "number") {
    if (!Number.isInteger(input)) throw new ValidationError(`${field} must be a whole number of minor units`);
    if (!Number.isSafeInteger(input)) {
      throw new ValidationError(`${field} is too large to send as a number; send it as a string of digits`);
    }
    value = BigInt(input);
  } else if (typeof input === "string") {
    if (!/^(0|[1-9][0-9]*)$/.test(input)) {
      throw new ValidationError(`${field} must be a whole number of minor units, written as digits only`);
    }
    value = BigInt(input);
  } else {
    throw new ValidationError(`${field} is required, as a whole number of minor units`);
  }
  assertMinorAmount(value, field);
  return value;
}

/** The exponent must be one `SupportedCurrency` could hold. */
export function assertCurrencyExponent(exponent: unknown): asserts exponent is number {
  if (typeof exponent !== "number" || !Number.isInteger(exponent) || exponent < 0 || exponent > MAX_CURRENCY_EXPONENT) {
    throw new ValidationError(`A currency exponent must be a whole number between 0 and ${MAX_CURRENCY_EXPONENT}`);
  }
}

/**
 * An amount written out in major units, for a human to read.
 *
 * Plain digits and an ASCII full stop, with exactly `exponent` decimal places — never a thousands
 * separator, never a currency symbol, never an Arabic-Indic digit. This is the FORM of the number,
 * not its presentation: a Damascus merchant reading Arabic must see `١٢٥٠٠٫٠٠ ل.س`, and producing
 * that needs the viewer's locale, which a server module has no business assuming. The screen does
 * that with `Intl.NumberFormat` in Prompt 2; this function guarantees only that the value handed to
 * it has not lost a digit on the way.
 *
 * Exact for every value the columns can hold, because it never leaves integer arithmetic: the
 * decimal point is inserted into the digit string rather than computed by division.
 */
export function formatMinorUnits(amountMinor: bigint, exponent: number): string {
  assertCurrencyExponent(exponent);
  const negative = amountMinor < 0n;
  const digits = (negative ? -amountMinor : amountMinor).toString().padStart(exponent + 1, "0");
  const whole = digits.slice(0, digits.length - exponent);
  const fraction = exponent === 0 ? "" : `.${digits.slice(digits.length - exponent)}`;
  return `${negative ? "-" : ""}${whole}${fraction}`;
}

/**
 * The redemption a card can actually afford against this invoice.
 *
 * `min(requested, balance, invoice)` — three caps, and each one is a different promise:
 *
 *  - **requested**: staff asked for this much and must never be surprised by more coming off;
 *  - **balance**: cashback is money already held, and a balance cannot go below zero;
 *  - **invoice**: this is the rule that makes cashback not a cash machine. Redeeming more than the
 *    bill would hand the customer the difference in cash, which is a payout this product does not
 *    do and is not licensed to do. Capping at the invoice is what keeps a redemption a DISCOUNT ON
 *    A PURCHASE rather than a withdrawal.
 *
 * Returning the capped figure rather than refusing an over-large request is deliberate: "you have
 * 4,000 left, take it off this 3,000 bill" is an ordinary thing for a cashier to say, and the row
 * records both what was asked and what was applied, so the difference is visible afterwards.
 */
export function cappedRedemption(args: { requestedMinor: bigint; balanceMinor: bigint; grossMinor: bigint }): bigint {
  const { requestedMinor, balanceMinor, grossMinor } = args;
  assertMinorAmount(requestedMinor, "requestedRedemptionMinor");
  assertMinorAmount(balanceMinor, "cashBalanceMinor");
  assertMinorAmount(grossMinor, "grossAmountMinor");
  let applied = requestedMinor;
  if (balanceMinor < applied) applied = balanceMinor;
  if (grossMinor < applied) applied = grossMinor;
  return applied;
}
