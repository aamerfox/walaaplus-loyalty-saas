import { describe, expect, it } from "vitest";
import { LedgerInvariantError, ValidationError } from "@/server/errors";
import {
  isPointsMechanics,
  parsePointsMechanics,
  pointsForPurchase,
  pointsForVisit,
  POINTS_MECHANICS_CONTRACT_VERSION,
  readPointsMechanics,
} from "@/server/program/points-mechanics";
import { isStampMechanics, parseStampMechanics } from "@/server/program/mechanics";

/**
 * The points contract, at the boundary.
 *
 * `ProgramVersion.mechanics` is a JSON column, so the only thing standing between a typo and a
 * silently absent rule is this schema being strict. These tests are mostly refusals, and that is
 * the point: a mechanic this phase does not implement must be rejected at the boundary rather than
 * stored and half-honoured by a later reader.
 */

const VALID = {
  kind: "POINTS",
  contractVersion: POINTS_MECHANICS_CONTRACT_VERSION,
  earnMode: "SPEND_BLOCK",
  spendAmountPerBlockMinor: 1_000,
  pointsPerBlock: 1,
} as const;

describe("the points mechanics contract", () => {
  it("accepts a real configuration and applies its defaults", () => {
    const m = parsePointsMechanics(VALID);
    expect(m.kind).toBe("POINTS");
    expect(m.requirePurchaseAmount).toBe(false);
    expect(m.countRewardRedemptionAsVisit).toBe(false);
    expect(m.welcomePoints).toBeUndefined();
  });

  it("refuses an unknown key rather than ignoring it", () => {
    // Every deferred mechanic - cashback, birthday points, expiry modes - lands here.
    for (const extra of [
      { cashbackPercent: 5 },
      { birthdayPoints: 50 },
      { cardExpiryMode: "FIXED" },
      { pointsExpireAfterDays: 365 },
      { referralPoints: 10 },
      { stampsRequiredPerReward: 10 },
    ]) {
      expect(() => parsePointsMechanics({ ...VALID, ...extra }), JSON.stringify(extra)).toThrow(ValidationError);
    }
  });

  it("requires the fields its earn mode needs, and refuses the ones it does not", () => {
    expect(() => parsePointsMechanics({ kind: "POINTS", contractVersion: 1, earnMode: "SPEND_BLOCK" })).toThrow(ValidationError);
    expect(() => parsePointsMechanics({ kind: "POINTS", contractVersion: 1, earnMode: "PER_VISIT" })).toThrow(ValidationError);

    // PER_VISIT with spend fields, and SPEND_BLOCK with a visit field, are both configuration
    // mistakes that would otherwise sit in the column looking like they did something.
    expect(() => parsePointsMechanics({ ...VALID, pointsPerVisit: 5 })).toThrow(ValidationError);
    expect(() =>
      parsePointsMechanics({ kind: "POINTS", contractVersion: 1, earnMode: "PER_VISIT", pointsPerVisit: 5, pointsPerBlock: 2 }),
    ).toThrow(ValidationError);

    const manual = parsePointsMechanics({ kind: "POINTS", contractVersion: 1, earnMode: "MANUAL" });
    expect(manual.earnMode).toBe("MANUAL");
  });

  it("refuses fractional, zero and negative quantities everywhere", () => {
    for (const bad of [
      { pointsPerBlock: 1.5 },
      { pointsPerBlock: 0 },
      { pointsPerBlock: -1 },
      { spendAmountPerBlockMinor: 999.99 },
      { welcomePoints: 2.5 },
      { dailyAwardLimit: 0 },
      { maxPointsPerManualAward: -5 },
    ]) {
      expect(() => parsePointsMechanics({ ...VALID, ...bad }), JSON.stringify(bad)).toThrow(ValidationError);
    }
  });

  it("refuses a location list that repeats or is empty", () => {
    expect(() => parsePointsMechanics({ ...VALID, availableLocations: [] })).toThrow(ValidationError);
    expect(() => parsePointsMechanics({ ...VALID, availableLocations: ["a", "a"] })).toThrow(ValidationError);
    expect(parsePointsMechanics({ ...VALID, availableLocations: ["a", "b"] }).availableLocations).toEqual(["a", "b"]);
  });

  it("treats a stored row that is not points as an invariant violation, not bad input", () => {
    // A stamp version handed to the points reader is a corrupt or mis-routed row: 422, not 400,
    // and never a default that would hand out the wrong number of points.
    expect(() => readPointsMechanics({ kind: "STAMP", contractVersion: 1 })).toThrow(LedgerInvariantError);
    expect(() => readPointsMechanics({})).toThrow(LedgerInvariantError);
    expect(readPointsMechanics(VALID).earnMode).toBe("SPEND_BLOCK");
  });

  it("keeps the two contracts mutually exclusive", () => {
    const stamp = {
      kind: "STAMP",
      contractVersion: 1,
      stampsRequiredPerReward: 10,
      rewardName: "Free coffee",
      earnMode: "MANUAL",
    };
    expect(isStampMechanics(stamp)).toBe(true);
    expect(isPointsMechanics(stamp)).toBe(false);
    expect(isPointsMechanics(VALID)).toBe(true);
    expect(isStampMechanics(VALID)).toBe(false);
    expect(() => parseStampMechanics(VALID)).toThrow(ValidationError);
  });
});

describe("points arithmetic is integer arithmetic", () => {
  it("earns whole blocks and discards the remainder", () => {
    const m = parsePointsMechanics({ ...VALID, spendAmountPerBlockMinor: 10_000, pointsPerBlock: 3 });
    expect(pointsForPurchase(m, 0)).toBe(0);
    expect(pointsForPurchase(m, 9_999)).toBe(0);
    expect(pointsForPurchase(m, 10_000)).toBe(3);
    expect(pointsForPurchase(m, 25_000)).toBe(6); // 2 blocks; the 5,000 remainder is gone
    expect(pointsForPurchase(m, 29_999)).toBe(6);
  });

  it("never returns a fraction, for any amount", () => {
    const m = parsePointsMechanics({ ...VALID, spendAmountPerBlockMinor: 3_333, pointsPerBlock: 7 });
    for (const amount of [1, 3_332, 3_333, 6_665, 999_999, 2_147_483_647]) {
      const points = pointsForPurchase(m, amount);
      expect(Number.isInteger(points), `${amount} -> ${points}`).toBe(true);
      expect(points).toBe(Math.floor(amount / 3_333) * 7);
    }
  });

  it("refuses a non-integer or negative purchase amount", () => {
    const m = parsePointsMechanics(VALID);
    expect(() => pointsForPurchase(m, 1.5)).toThrow(ValidationError);
    expect(() => pointsForPurchase(m, -1)).toThrow(ValidationError);
  });

  it("refuses to earn by the wrong mode", () => {
    const spend = parsePointsMechanics(VALID);
    const visit = parsePointsMechanics({ kind: "POINTS", contractVersion: 1, earnMode: "PER_VISIT", pointsPerVisit: 4 });
    expect(() => pointsForVisit(spend)).toThrow(ValidationError);
    expect(() => pointsForPurchase(visit, 10_000)).toThrow(ValidationError);
    expect(pointsForVisit(visit)).toBe(4);
  });
});
