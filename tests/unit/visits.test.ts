import { OperationKind } from "@prisma/client";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_VISIT_RULES,
  NEVER_VISIT_KINDS,
  readVisitRules,
  REDEMPTION_KINDS,
  resolveCountsAsVisit,
  VISIT_KINDS,
} from "@/server/ledger/visits";

describe("countsAsVisit policy", () => {
  it("award kinds always count as visits", () => {
    for (const k of VISIT_KINDS) expect(resolveCountsAsVisit(k, DEFAULT_VISIT_RULES)).toBe(true);
    expect(resolveCountsAsVisit(OperationKind.MANUAL_AWARD, DEFAULT_VISIT_RULES)).toBe(true);
    expect(resolveCountsAsVisit(OperationKind.PURCHASE_AWARD, DEFAULT_VISIT_RULES)).toBe(true);
  });

  it("bonuses, conversions, corrections, imports and expiry never count", () => {
    for (const k of NEVER_VISIT_KINDS) {
      expect(resolveCountsAsVisit(k, { countRewardRedemptionAsVisit: true })).toBe(false);
    }
    expect(resolveCountsAsVisit(OperationKind.WELCOME_BONUS, DEFAULT_VISIT_RULES)).toBe(false);
    expect(resolveCountsAsVisit(OperationKind.REVERSAL, DEFAULT_VISIT_RULES)).toBe(false);
    expect(resolveCountsAsVisit(OperationKind.STAMP_CONVERTED, DEFAULT_VISIT_RULES)).toBe(false);
  });

  it("redemptions follow the program-version setting, default false", () => {
    for (const k of REDEMPTION_KINDS) {
      expect(resolveCountsAsVisit(k, DEFAULT_VISIT_RULES)).toBe(false);
      expect(resolveCountsAsVisit(k, { countRewardRedemptionAsVisit: true })).toBe(true);
    }
  });

  it("every OperationKind is classified exactly once", () => {
    const all = Object.values(OperationKind);
    for (const k of all) {
      const hits = [VISIT_KINDS.has(k), REDEMPTION_KINDS.has(k), NEVER_VISIT_KINDS.has(k)].filter(Boolean).length;
      expect(hits, `kind ${k}`).toBe(1);
    }
  });

  it("readVisitRules tolerates malformed mechanics", () => {
    expect(readVisitRules(null)).toEqual(DEFAULT_VISIT_RULES);
    expect(readVisitRules([])).toEqual(DEFAULT_VISIT_RULES);
    expect(readVisitRules({ countRewardRedemptionAsVisit: "yes" })).toEqual(DEFAULT_VISIT_RULES);
    expect(readVisitRules({ countRewardRedemptionAsVisit: true })).toEqual({ countRewardRedemptionAsVisit: true });
  });
});
