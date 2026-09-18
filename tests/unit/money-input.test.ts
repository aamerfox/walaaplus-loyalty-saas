import { describe, expect, it } from "vitest";
import { basisPointsToPercent, inputToMinor, minorToInput, percentToBasisPoints } from "@/lib/money-input";

/**
 * The conversions between what a merchant types and what the product stores.
 *
 * These are small functions and they are the ones worth testing hardest: a threshold that lands a
 * fraction of a unit away from where the merchant put it is a bug nothing downstream can detect,
 * because the stored value is perfectly self-consistent. Every case below would pass a float
 * implementation on ordinary inputs and fail it on the awkward ones.
 */

describe("minor units to a readable decimal", () => {
  it("inserts the point rather than dividing", () => {
    expect(minorToInput("12550", 2)).toBe("125.50");
    expect(minorToInput("5", 2)).toBe("0.05");
    expect(minorToInput("0", 2)).toBe("0.00");
  });

  it("uses the currency's own exponent, not the constant 2", () => {
    // JOD has three minor digits, JPY has none. A product that assumed 2 would be wrong in both.
    expect(minorToInput("12550", 3)).toBe("12.550");
    expect(minorToInput("12550", 0)).toBe("12550");
  });

  it("survives an amount far past the range of a double", () => {
    const huge = "123456789012345678901234567890";
    expect(minorToInput(huge, 2)).toBe("1234567890123456789012345678.90");
  });
});

describe("a typed decimal to minor units", () => {
  it("reads ordinary amounts exactly", () => {
    expect(inputToMinor("125.50", 2)).toBe("12550");
    expect(inputToMinor("0.05", 2)).toBe("5");
    expect(inputToMinor("1000", 2)).toBe("100000");
    expect(inputToMinor("0", 2)).toBe("0");
  });

  it("reads the amounts a float gets wrong", () => {
    /*
     * `Math.round(8.20 * 100)` is 820 and `Math.round(1.005 * 100)` is 100, not 101, because 1.005
     * is really 1.00499999999999989. String work has no such cases.
     */
    expect(inputToMinor("8.20", 2)).toBe("820");
    expect(inputToMinor("1.005", 3)).toBe("1005");
    expect(inputToMinor("0.1", 2)).toBe("10");
    expect(inputToMinor("0.2", 2)).toBe("20");
    expect(inputToMinor("70.07", 2)).toBe("7007");
  });

  it("REFUSES more decimal places than the currency has, rather than rounding", () => {
    // The merchant typed three places in a two-place currency. Either reading discards their intent,
    // so neither is chosen for them.
    expect(inputToMinor("12.999", 2)).toBeNull();
    expect(inputToMinor("1.5", 0)).toBeNull();
  });

  it("refuses anything that is not a plain non-negative decimal", () => {
    for (const bad of ["", " ", "-1", "-0.5", "1e3", "1,5", "12.", ".5", "abc", "١٢٣", "Infinity", "NaN", "0x10"]) {
      expect(inputToMinor(bad, 2), `"${bad}" must be refused`).toBeNull();
    }
  });

  it("round-trips with minorToInput", () => {
    for (const [minor, exponent] of [
      ["0", 2],
      ["5", 2],
      ["12550", 2],
      ["999999999999999", 2],
      ["12550", 3],
      ["12550", 0],
    ] as const) {
      expect(inputToMinor(minorToInput(minor, exponent), exponent)).toBe(minor);
    }
  });
});

describe("basis points and percentages", () => {
  it("shows a rate the way a merchant writes one", () => {
    expect(basisPointsToPercent(500)).toBe("5");
    expect(basisPointsToPercent(750)).toBe("7.5");
    expect(basisPointsToPercent(1)).toBe("0.01");
    expect(basisPointsToPercent(0)).toBe("0");
    expect(basisPointsToPercent(10_000)).toBe("100");
  });

  it("reads one back exactly", () => {
    expect(percentToBasisPoints("5")).toBe(500);
    expect(percentToBasisPoints("7.5")).toBe(750);
    expect(percentToBasisPoints("0.01")).toBe(1);
    expect(percentToBasisPoints("3.26")).toBe(326);
    expect(percentToBasisPoints("100")).toBe(10_000);
  });

  it("refuses a rate finer than a basis point, instead of rounding it away", () => {
    expect(percentToBasisPoints("7.555")).toBeNull();
  });

  it("refuses more than 100%", () => {
    // Giving back more than the customer spent is not a promotion this product will record.
    expect(percentToBasisPoints("100.01")).toBeNull();
    expect(percentToBasisPoints("1000")).toBeNull();
  });

  it("refuses anything that is not a plain percentage", () => {
    for (const bad of ["", "-5", "5%", "5.", ".5", "1e2", "٥", "NaN"]) {
      expect(percentToBasisPoints(bad), `"${bad}" must be refused`).toBeNull();
    }
  });

  it("round-trips every basis point a rate table can hold", () => {
    for (let bp = 0; bp <= 10_000; bp++) {
      expect(percentToBasisPoints(basisPointsToPercent(bp)), `bp ${bp}`).toBe(bp);
    }
  });
});
