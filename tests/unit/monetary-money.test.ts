import { describe, expect, it } from "vitest";
import {
  assertCurrencyExponent,
  assertMinorAmount,
  assertRateBasisPoints,
  cappedRedemption,
  formatMinorUnits,
  MAX_MINOR_AMOUNT,
  parseMinorAmount,
  percentageOfHalfUp,
} from "@/server/monetary/money";

/**
 * The money arithmetic, tested against the values a person would check by hand.
 *
 * These are deliberately not "does the function run" tests. Every case here is a number somebody
 * could get wrong in a plausible way — the exact half, the currency with three decimal places, the
 * amount that stops being representable as a JavaScript `number` — and the assertion is the answer
 * a cashier would expect to be able to verify with a calculator.
 */

describe("percentage, rounded half-up", () => {
  it("rounds an exact half UP, which is what a person doing this on paper does", () => {
    // 5% of 10 is 0.5 minor units. Half-up gives 1; truncation and banker's rounding both give 0.
    expect(percentageOfHalfUp(10n, 500)).toBe(1n);
    // 50% of 1 is 0.5 → 1.
    expect(percentageOfHalfUp(1n, 5_000)).toBe(1n);
    // 50% of 3 is 1.5 → 2. Banker's rounding would give 2 here but 2 for 2.5 as well; this is 3.
    expect(percentageOfHalfUp(3n, 5_000)).toBe(2n);
    expect(percentageOfHalfUp(5n, 5_000)).toBe(3n); // 2.5 → 3, where banker's rounding gives 2
  });

  it("rounds below a half DOWN", () => {
    expect(percentageOfHalfUp(10n, 499)).toBe(0n); // 0.499
    expect(percentageOfHalfUp(1_000n, 4)).toBe(0n); // 0.4
    expect(percentageOfHalfUp(1_000n, 5)).toBe(1n); // exactly 0.5 → 1
  });

  it("is exact at the ends of the rate range", () => {
    expect(percentageOfHalfUp(123_456n, 0)).toBe(0n);
    expect(percentageOfHalfUp(123_456n, 10_000)).toBe(123_456n);
  });

  it("stays exact past 2^53, which is the whole reason these are bigints", () => {
    /*
     * The INTERMEDIATE product is what overflows first. 10^15 × 10000 is 10^19, far beyond
     * Number.MAX_SAFE_INTEGER (about 9.007 × 10^15) — so a `number` implementation would be wrong
     * here even though the RESULT is representable.
     */
    expect(percentageOfHalfUp(MAX_MINOR_AMOUNT, 10_000)).toBe(MAX_MINOR_AMOUNT);
    expect(percentageOfHalfUp(999_999_999_999_999n, 250)).toBe(25_000_000_000_000n);
  });

  it("gives a different answer from the float version, on an input where the float version is wrong", () => {
    /*
     * 3.26% of 9,000,000,029,062.73 — a large but entirely ordinary SYP figure once minor units are
     * counted. The exact answer is 29,340,000,094,744 (the product is 293,400,000,947,445,398, whose
     * last digits a double cannot hold, so the division lands a whole minor unit high).
     *
     * This is the concrete failure this module exists to prevent, and it is asserted rather than
     * described: NOT every large input diverges, so a test that picked one arbitrarily would pass
     * for the wrong reason and go on passing if the implementation were changed back to floats.
     */
    const gross = 900_000_002_906_273n;
    const rate = 326;
    expect(percentageOfHalfUp(gross, rate)).toBe(29_340_000_094_744n);
    expect(Math.round((900_000_002_906_273 * 326) / 10_000)).toBe(29_340_000_094_745);
  });

  it("refuses a rate that is not a whole number of basis points in range", () => {
    expect(() => percentageOfHalfUp(100n, -1)).toThrow(/basis points/);
    expect(() => percentageOfHalfUp(100n, 10_001)).toThrow(/basis points/);
    expect(() => percentageOfHalfUp(100n, 2.5)).toThrow(/basis points/);
  });

  it("refuses an amount beyond what the columns will hold, rather than letting the database do it", () => {
    expect(() => percentageOfHalfUp(MAX_MINOR_AMOUNT + 1n, 500)).toThrow(/larger than this product will record/);
    expect(() => percentageOfHalfUp(-1n, 500)).toThrow(/cannot be negative/);
  });
});

describe("currency exponents are data, not the constant 2", () => {
  it("writes an amount out in the currency's own number of decimal places", () => {
    expect(formatMinorUnits(1_234n, 2)).toBe("12.34"); // SYP, USD, EUR, TRY
    expect(formatMinorUnits(1_234n, 3)).toBe("1.234"); // JOD, KWD, BHD
    expect(formatMinorUnits(1_234n, 0)).toBe("1234"); // JPY
  });

  it("pads a value smaller than one major unit", () => {
    expect(formatMinorUnits(5n, 3)).toBe("0.005");
    expect(formatMinorUnits(5n, 2)).toBe("0.05");
    expect(formatMinorUnits(0n, 2)).toBe("0.00");
    expect(formatMinorUnits(0n, 0)).toBe("0");
  });

  it("keeps the sign, because a reversal's effect is negative", () => {
    expect(formatMinorUnits(-1_234n, 2)).toBe("-12.34");
    expect(formatMinorUnits(-5n, 3)).toBe("-0.005");
  });

  it("is exact for an amount no double could represent", () => {
    expect(formatMinorUnits(999_999_999_999_999n, 2)).toBe("9999999999999.99");
  });

  it("refuses an exponent this product does not record", () => {
    expect(() => formatMinorUnits(1n, 5)).toThrow(/exponent/);
    expect(() => assertCurrencyExponent(-1)).toThrow(/exponent/);
    expect(() => assertCurrencyExponent(2.5)).toThrow(/exponent/);
    assertCurrencyExponent(0);
    assertCurrencyExponent(4);
  });
});

describe("reading an amount from a caller", () => {
  it("accepts a bigint, a safe integer, and a string of digits", () => {
    expect(parseMinorAmount(1_234n, "x")).toBe(1_234n);
    expect(parseMinorAmount(1_234, "x")).toBe(1_234n);
    expect(parseMinorAmount("1234", "x")).toBe(1_234n);
    expect(parseMinorAmount("0", "x")).toBe(0n);
    expect(parseMinorAmount("999999999999999", "x")).toBe(999_999_999_999_999n);
  });

  it("refuses a number that is already an approximation", () => {
    // Number.MAX_SAFE_INTEGER + 2 is not representable; JavaScript silently gives back a different
    // integer. Accepting it would record an invoice nobody typed.
    expect(() => parseMinorAmount(Number.MAX_SAFE_INTEGER + 2, "x")).toThrow(/send it as a string of digits/);
  });

  it("refuses a fraction of a minor unit", () => {
    expect(() => parseMinorAmount(12.5, "x")).toThrow(/whole number of minor units/);
  });

  it("refuses a major-unit decimal, rather than guessing which unit was meant", () => {
    expect(() => parseMinorAmount("12.50", "x")).toThrow(/digits only/);
    expect(() => parseMinorAmount("12,50", "x")).toThrow(/digits only/);
    expect(() => parseMinorAmount("1e3", "x")).toThrow(/digits only/);
  });

  it("refuses padding, emptiness, signs and absence", () => {
    expect(() => parseMinorAmount(" 12", "x")).toThrow(/digits only/);
    expect(() => parseMinorAmount("012", "x")).toThrow(/digits only/);
    expect(() => parseMinorAmount("", "x")).toThrow(/digits only/);
    expect(() => parseMinorAmount("-1", "x")).toThrow(/digits only/);
    expect(() => parseMinorAmount(undefined, "x")).toThrow(/required/);
    expect(() => parseMinorAmount(null, "x")).toThrow(/required/);
    expect(() => parseMinorAmount({}, "x")).toThrow(/required/);
  });

  it("names the field it refused, so a form can point at it", () => {
    expect(() => parseMinorAmount(-1, "requestedRedemptionMinor")).toThrow(/requestedRedemptionMinor/);
  });

  it("applies the same ceiling the database CHECK does", () => {
    expect(parseMinorAmount(MAX_MINOR_AMOUNT, "x")).toBe(MAX_MINOR_AMOUNT);
    expect(() => parseMinorAmount(MAX_MINOR_AMOUNT + 1n, "x")).toThrow(/larger than this product will record/);
  });
});

describe("what a redemption is actually allowed to take off", () => {
  it("takes what was asked when the card and the bill can both cover it", () => {
    expect(cappedRedemption({ requestedMinor: 500n, balanceMinor: 1_000n, grossMinor: 2_000n })).toBe(500n);
  });

  it("caps at the balance, because money that is not there cannot be spent", () => {
    expect(cappedRedemption({ requestedMinor: 5_000n, balanceMinor: 1_000n, grossMinor: 2_000n })).toBe(1_000n);
  });

  it("caps at the invoice, which is what stops this being a cash withdrawal", () => {
    // 4,000 on the card, a 3,000 bill: 3,000 comes off and the other 1,000 stays on the card.
    // Paying it out would be handing over cash, which this product does not do.
    expect(cappedRedemption({ requestedMinor: 4_000n, balanceMinor: 4_000n, grossMinor: 3_000n })).toBe(3_000n);
  });

  it("applies whichever cap binds first", () => {
    expect(cappedRedemption({ requestedMinor: 9n, balanceMinor: 5n, grossMinor: 7n })).toBe(5n);
    expect(cappedRedemption({ requestedMinor: 9n, balanceMinor: 7n, grossMinor: 5n })).toBe(5n);
    expect(cappedRedemption({ requestedMinor: 4n, balanceMinor: 7n, grossMinor: 5n })).toBe(4n);
  });

  it("gives zero on a zero invoice, and never a negative", () => {
    expect(cappedRedemption({ requestedMinor: 100n, balanceMinor: 100n, grossMinor: 0n })).toBe(0n);
    expect(cappedRedemption({ requestedMinor: 0n, balanceMinor: 100n, grossMinor: 100n })).toBe(0n);
  });

  it("refuses a negative anywhere rather than quietly producing one", () => {
    expect(() => cappedRedemption({ requestedMinor: -1n, balanceMinor: 100n, grossMinor: 100n })).toThrow(/negative/);
    expect(() => cappedRedemption({ requestedMinor: 1n, balanceMinor: -1n, grossMinor: 100n })).toThrow(/negative/);
    expect(() => cappedRedemption({ requestedMinor: 1n, balanceMinor: 100n, grossMinor: -1n })).toThrow(/negative/);
  });
});

describe("the guards the rest of the module leans on", () => {
  it("insists an amount is a bigint, not a number that happens to be whole", () => {
    expect(() => assertMinorAmount(100, "x")).toThrow(/integer number of minor units/);
    expect(() => assertMinorAmount("100", "x")).toThrow(/integer number of minor units/);
    assertMinorAmount(100n, "x");
  });

  it("accepts every rate in range and nothing outside it", () => {
    assertRateBasisPoints(0);
    assertRateBasisPoints(10_000);
    expect(() => assertRateBasisPoints("500")).toThrow();
    expect(() => assertRateBasisPoints(Number.NaN)).toThrow();
  });
});
