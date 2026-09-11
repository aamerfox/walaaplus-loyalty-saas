import { OperationKind, OperationSource } from "@prisma/client";
import { describe, expect, it } from "vitest";
import { ValidationError } from "@/server/errors";
import {
  AWARD_KINDS,
  DEFAULT_VISIT_RULES,
  INTEGRATION_KINDS,
  NEVER_VISIT_KINDS,
  readVisitRules,
  REDEMPTION_KINDS,
  resolveCountsAsVisit,
} from "@/server/ledger/visits";

const ON = { countRewardRedemptionAsVisit: true };
const OFF = DEFAULT_VISIT_RULES;
const decide = (kind: OperationKind, source: OperationSource, explicit?: boolean, rules = OFF) =>
  resolveCountsAsVisit({ kind, source, rules, explicit });

describe("countsAsVisit policy (kind × source × version setting × explicit intent)", () => {
  it("classifies every OperationKind exactly once", () => {
    for (const k of Object.values(OperationKind)) {
      const hits = [AWARD_KINDS, INTEGRATION_KINDS, REDEMPTION_KINDS, NEVER_VISIT_KINDS].filter((s) => s.has(k)).length;
      expect(hits, `kind ${k}`).toBe(1);
    }
  });

  describe("staff awards (scanner, dashboard)", () => {
    it("are visits by policy", () => {
      for (const k of AWARD_KINDS) {
        expect(decide(k, OperationSource.SCANNER)).toBe(true);
        expect(decide(k, OperationSource.DASHBOARD)).toBe(true);
      }
    });
    it("reject an explicit flag: policy decides", () => {
      expect(() => decide(OperationKind.MANUAL_AWARD, OperationSource.SCANNER, true)).toThrow(ValidationError);
      expect(() => decide(OperationKind.MANUAL_AWARD, OperationSource.DASHBOARD, false)).toThrow(ValidationError);
    });
  });

  describe("platform awards (enrollment, system, import)", () => {
    it("are never visits and reject an explicit flag", () => {
      for (const s of [OperationSource.ENROLLMENT, OperationSource.SYSTEM, OperationSource.IMPORT]) {
        expect(decide(OperationKind.MANUAL_AWARD, s)).toBe(false);
        expect(() => decide(OperationKind.MANUAL_AWARD, s, true)).toThrow(ValidationError);
      }
    });
  });

  describe("API and automation awards", () => {
    it("MUST state intent explicitly", () => {
      for (const s of [OperationSource.API, OperationSource.AUTOMATION]) {
        expect(() => decide(OperationKind.PURCHASE_AWARD, s)).toThrow(/explicitly/);
        expect(decide(OperationKind.PURCHASE_AWARD, s, true)).toBe(true);
        expect(decide(OperationKind.PURCHASE_AWARD, s, false)).toBe(false);
      }
    });
  });

  describe("integration actions", () => {
    it("never become visits implicitly, from any source", () => {
      for (const s of Object.values(OperationSource)) {
        expect(() => decide(OperationKind.INTEGRATION_AWARD, s)).toThrow(/explicitly/);
        expect(decide(OperationKind.INTEGRATION_AWARD, s, true)).toBe(true);
        expect(decide(OperationKind.INTEGRATION_AWARD, s, false)).toBe(false);
      }
    });
    it("integration reversals are never visits", () => {
      expect(decide(OperationKind.INTEGRATION_REVERSAL, OperationSource.API)).toBe(false);
    });
  });

  describe("redemptions", () => {
    it("follow the immutable ProgramVersion setting regardless of source", () => {
      for (const k of REDEMPTION_KINDS) {
        for (const s of Object.values(OperationSource)) {
          expect(decide(k, s, undefined, OFF)).toBe(false);
          expect(decide(k, s, undefined, ON)).toBe(true);
        }
      }
    });
    it("reject an explicit flag", () => {
      expect(() => decide(OperationKind.REWARD_REDEEMED, OperationSource.SCANNER, true)).toThrow(ValidationError);
    });
  });

  describe("bonuses, conversions, corrections, imports, reversals, system rows", () => {
    it("are never visits and reject an explicit flag", () => {
      for (const k of NEVER_VISIT_KINDS) {
        for (const s of Object.values(OperationSource)) {
          expect(decide(k, s, undefined, ON)).toBe(false);
        }
        expect(() => decide(k, OperationSource.SYSTEM, true)).toThrow(ValidationError);
      }
    });
  });

  it("readVisitRules tolerates malformed mechanics", () => {
    expect(readVisitRules(null)).toEqual(DEFAULT_VISIT_RULES);
    expect(readVisitRules([])).toEqual(DEFAULT_VISIT_RULES);
    expect(readVisitRules({ countRewardRedemptionAsVisit: "yes" })).toEqual(DEFAULT_VISIT_RULES);
    expect(readVisitRules({ countRewardRedemptionAsVisit: true })).toEqual(ON);
  });
});
