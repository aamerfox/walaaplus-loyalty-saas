import { describe, expect, it } from "vitest";
import { ValidationError, LedgerInvariantError } from "@/server/errors";
import {
  STAMP_MECHANICS_CONTRACT_VERSION,
  StampEarnMode,
  isStampMechanics,
  parseStampMechanics,
  planStampConversion,
  readStampMechanics,
  stampsForPurchase,
  type StampMechanicsInput,
} from "@/server/program/mechanics";

/**
 * ValidationError carries a stable message and the field issues in `.issues`; the detail a
 * merchant needs is in the issues, so that is what these tests read.
 */
function issuesOf(fn: () => unknown): string {
  try {
    fn();
    return "";
  } catch (e) {
    const issues = (e as ValidationError).issues as { path: (string | number)[]; message: string }[] | undefined;
    return (issues ?? []).map((i) => `${i.path.join(".")}: ${i.message}`).join(" | ");
  }
}

const base: StampMechanicsInput = {
  kind: "STAMP",
  contractVersion: STAMP_MECHANICS_CONTRACT_VERSION,
  stampsRequiredPerReward: 10,
  rewardName: "Free coffee",
  earnMode: StampEarnMode.MANUAL,
};

describe("stamp mechanics contract", () => {
  describe("what it accepts", () => {
    it("accepts the smallest useful café program and applies defaults", () => {
      const m = parseStampMechanics(base);
      expect(m.stampsRequiredPerReward).toBe(10);
      expect(m.rewardName).toBe("Free coffee");
      // Defaults exist so a program is never half-configured by omission.
      expect(m.requirePurchaseAmount).toBe(false);
      expect(m.countRewardRedemptionAsVisit).toBe(false);
      expect(m.dailyAwardLimit).toBeUndefined();
      expect(m.welcomeStamps).toBeUndefined();
    });

    it("accepts a full spend-block program", () => {
      const m = parseStampMechanics({
        ...base,
        earnMode: StampEarnMode.SPEND_BLOCK,
        spendAmountPerBlockMinor: 10_000,
        stampsPerBlock: 1,
        rewardDescription: "Any size, one per visit",
        rewardValueMinor: 15_000,
        requirePurchaseAmount: true,
        dailyAwardLimit: 3,
        welcomeStamps: 2,
        countRewardRedemptionAsVisit: true,
      });
      expect(m.spendAmountPerBlockMinor).toBe(10_000);
      expect(m.dailyAwardLimit).toBe(3);
      expect(m.countRewardRedemptionAsVisit).toBe(true);
    });

    it("trims the text a merchant types", () => {
      expect(parseStampMechanics({ ...base, rewardName: "  Free coffee  " }).rewardName).toBe("Free coffee");
    });
  });

  describe("what it refuses", () => {
    const cases: [string, unknown][] = [
      ["a threshold of zero", { ...base, stampsRequiredPerReward: 0 }],
      ["a negative threshold", { ...base, stampsRequiredPerReward: -5 }],
      ["a fractional threshold", { ...base, stampsRequiredPerReward: 2.5 }],
      ["an empty reward name", { ...base, rewardName: "   " }],
      ["a fractional reward value", { ...base, rewardValueMinor: 10.5 }],
      ["a negative reward value", { ...base, rewardValueMinor: -1 }],
      ["an unknown earn mode", { ...base, earnMode: "PER_ITEM" }],
      ["a zero daily limit", { ...base, dailyAwardLimit: 0 }],
      ["a missing kind", { ...base, kind: undefined }],
      ["a points program", { ...base, kind: "POINTS" }],
      ["an unknown contract version", { ...base, contractVersion: 99 }],
    ];
    it.each(cases)("refuses %s", (_label, input) => {
      expect(() => parseStampMechanics(input)).toThrow(ValidationError);
    });

    it("refuses spend-block fields without SPEND_BLOCK, and SPEND_BLOCK without them", () => {
      expect(issuesOf(() => parseStampMechanics({ ...base, spendAmountPerBlockMinor: 10_000 }))).toMatch(
        /spendAmountPerBlockMinor: .*only valid when earnMode is SPEND_BLOCK/,
      );
      expect(issuesOf(() => parseStampMechanics({ ...base, stampsPerBlock: 2 }))).toMatch(
        /stampsPerBlock: .*only valid when earnMode is SPEND_BLOCK/,
      );
      const missingBoth = issuesOf(() => parseStampMechanics({ ...base, earnMode: StampEarnMode.SPEND_BLOCK }));
      expect(missingBoth).toMatch(/spendAmountPerBlockMinor: .*required when earnMode is SPEND_BLOCK/);
      expect(missingBoth).toMatch(/stampsPerBlock: .*required when earnMode is SPEND_BLOCK/);
      expect(
        issuesOf(() => parseStampMechanics({ ...base, earnMode: StampEarnMode.SPEND_BLOCK, spendAmountPerBlockMinor: 10_000 })),
      ).toMatch(/stampsPerBlock: .*required/);
    });

    it("refuses a welcome bonus that would complete a card on its own", () => {
      expect(issuesOf(() => parseStampMechanics({ ...base, stampsRequiredPerReward: 5, welcomeStamps: 5 }))).toMatch(
        /welcomeStamps: .*may not complete a card/,
      );
      expect(issuesOf(() => parseStampMechanics({ ...base, stampsRequiredPerReward: 5, welcomeStamps: 6 }))).toMatch(
        /welcomeStamps: .*may not complete a card/,
      );
      expect(parseStampMechanics({ ...base, stampsRequiredPerReward: 5, welcomeStamps: 4 }).welcomeStamps).toBe(4);
    });

    /**
     * The point of the strict schema: a deferred mechanic must not be silently ignored, because
     * a merchant who typed it would believe it was in force.
     */
    const deferred: [string, Record<string, unknown>][] = [
      ["points", { pointsPerVisit: 2 }],
      ["cashback", { cashbackPercent: 5 }],
      ["expiry", { cardExpiryMode: "FIXED", cardExpiryDate: "2027-01-01" }],
      ["inactivity expiry", { inactivityExpiryDays: 90 }],
      ["birthday bonus", { birthdayStamps: 3 }],
      ["referrals", { referralBonusStamps: 1 }],
      ["promotions", { promotions: [] }],
      ["named campaigns", { utmCampaigns: ["eid"] }],
      ["multi-location", { availableLocations: ["loc-1"] }],
      ["a typo", { stampsRequiredPerRewards: 10 }],
    ];
    it.each(deferred)("refuses %s rather than ignoring it", (_label, extra) => {
      expect(() => parseStampMechanics({ ...base, ...extra })).toThrow(ValidationError);
    });
  });

  describe("reading mechanics already stored on a version", () => {
    it("round-trips through JSON", () => {
      const stored = JSON.parse(JSON.stringify(parseStampMechanics(base))) as unknown;
      expect(readStampMechanics(stored).stampsRequiredPerReward).toBe(10);
      expect(isStampMechanics(stored)).toBe(true);
    });

    it("refuses corrupt or foreign mechanics as an invariant violation, never a default", () => {
      // A Phase 0 fixture-shaped blob: recognisably not this contract.
      expect(() => readStampMechanics({ stampsRequiredPerReward: 10 })).toThrow(LedgerInvariantError);
      expect(() => readStampMechanics({})).toThrow(LedgerInvariantError);
      expect(() => readStampMechanics(null)).toThrow(LedgerInvariantError);
      expect(() => readStampMechanics("10")).toThrow(LedgerInvariantError);
      expect(isStampMechanics({ stampsRequiredPerReward: 10 })).toBe(false);
    });

    it("names the version and the offending fields, so a corrupt row can be found", () => {
      // Unlike ValidationError, the invariant error puts the detail in the message: it is read by
      // whoever is paged, not shown to a merchant filling in a form.
      expect(() => readStampMechanics({ kind: "STAMP" }, { programVersionId: "ver-123" })).toThrow(/ver-123/);
      expect(() => readStampMechanics({ ...base, stampsRequiredPerReward: 0 })).toThrow(/stampsRequiredPerReward/);
    });
  });

  describe("spend-block rounding", () => {
    const spend = parseStampMechanics({
      ...base,
      earnMode: StampEarnMode.SPEND_BLOCK,
      spendAmountPerBlockMinor: 10_000,
      stampsPerBlock: 1,
    });

    it("floors to whole blocks and discards the remainder (PRODUCT-SPEC §5.5)", () => {
      expect(stampsForPurchase(spend, 25_000)).toBe(2); // the 5,000 remainder is gone
      expect(stampsForPurchase(spend, 10_000)).toBe(1);
      expect(stampsForPurchase(spend, 19_999)).toBe(1);
      expect(stampsForPurchase(spend, 9_999)).toBe(0);
      expect(stampsForPurchase(spend, 0)).toBe(0);
    });

    it("does not carry the remainder between purchases", () => {
      // Two 5,000 purchases are not one 10,000 purchase. Each is floored on its own.
      expect(stampsForPurchase(spend, 5_000) + stampsForPurchase(spend, 5_000)).toBe(0);
    });

    it("multiplies by stampsPerBlock", () => {
      const triple = parseStampMechanics({
        ...base,
        earnMode: StampEarnMode.SPEND_BLOCK,
        spendAmountPerBlockMinor: 10_000,
        stampsPerBlock: 3,
      });
      expect(stampsForPurchase(triple, 25_000)).toBe(6);
    });

    it("refuses non-integer money and non-spend programs", () => {
      expect(() => stampsForPurchase(spend, 100.5)).toThrow(ValidationError);
      expect(() => stampsForPurchase(spend, -1)).toThrow(ValidationError);
      expect(() => stampsForPurchase(parseStampMechanics(base), 10_000)).toThrow(/requires a SPEND_BLOCK/);
    });
  });

  describe("conversion planning", () => {
    const m = parseStampMechanics(base); // threshold 10

    it("does not convert below the threshold", () => {
      expect(planStampConversion(m, 0, 3)).toEqual({ stampsConverted: 0, rewardsEarned: 0, remainingStamps: 3 });
      expect(planStampConversion(m, 8, 1)).toEqual({ stampsConverted: 0, rewardsEarned: 0, remainingStamps: 9 });
    });

    it("converts immediately on reaching it, leaving nothing behind", () => {
      expect(planStampConversion(m, 9, 1)).toEqual({ stampsConverted: 10, rewardsEarned: 1, remainingStamps: 0 });
    });

    it("carries the remainder forward (PRODUCT-SPEC §5.3)", () => {
      expect(planStampConversion(m, 0, 12)).toEqual({ stampsConverted: 10, rewardsEarned: 1, remainingStamps: 2 });
      expect(planStampConversion(m, 8, 5)).toEqual({ stampsConverted: 10, rewardsEarned: 1, remainingStamps: 3 });
    });

    it("completes several rewards from one large award", () => {
      expect(planStampConversion(m, 0, 25)).toEqual({ stampsConverted: 20, rewardsEarned: 2, remainingStamps: 5 });
      expect(planStampConversion(m, 5, 95)).toEqual({ stampsConverted: 100, rewardsEarned: 10, remainingStamps: 0 });
    });

    it("holds the invariant: converted stamps always equal rewards times the threshold", () => {
      for (let current = 0; current < 12; current++) {
        for (let award = 1; award < 30; award++) {
          const plan = planStampConversion(m, current, award);
          expect(plan.stampsConverted).toBe(plan.rewardsEarned * m.stampsRequiredPerReward);
          expect(plan.remainingStamps).toBe(current + award - plan.stampsConverted);
          expect(plan.remainingStamps).toBeGreaterThanOrEqual(0);
          expect(plan.remainingStamps).toBeLessThan(m.stampsRequiredPerReward);
        }
      }
    });
  });
});
