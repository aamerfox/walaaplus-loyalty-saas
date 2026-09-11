import { OperationKind } from "@prisma/client";

/**
 * `countsAsVisit` policy (docs/PRODUCT-SPEC.md §5.4). Evaluated ONCE when a row is written and
 * stored immutably, so historical rows keep the definition that applied at the time.
 */

/** Always a visit: staff or system awarded value for a real customer interaction. */
export const VISIT_KINDS: ReadonlySet<OperationKind> = new Set<OperationKind>([
  OperationKind.MANUAL_AWARD,
  OperationKind.VISIT_AWARD,
  OperationKind.PURCHASE_AWARD,
  OperationKind.INTEGRATION_AWARD,
]);

/** A visit only when the program version says so (`countRewardRedemptionAsVisit`). */
export const REDEMPTION_KINDS: ReadonlySet<OperationKind> = new Set<OperationKind>([
  OperationKind.REWARD_REDEEMED,
  OperationKind.BALANCE_REDEEMED,
  OperationKind.PROMOTION_REDEEMED,
]);

/** Never a visit: bonuses, conversions, corrections, expiry, imports, system events. */
export const NEVER_VISIT_KINDS: ReadonlySet<OperationKind> = new Set<OperationKind>([
  OperationKind.CARD_ISSUED,
  OperationKind.WELCOME_BONUS,
  OperationKind.BIRTHDAY_BONUS,
  OperationKind.REFERRAL_BONUS,
  OperationKind.STAMP_CONVERTED,
  OperationKind.REWARD_EARNED,
  OperationKind.BALANCE_EXPIRED,
  OperationKind.IMPORT_ADJUSTMENT,
  OperationKind.REVERSAL,
  OperationKind.INTEGRATION_REVERSAL,
]);

export interface VisitRules {
  countRewardRedemptionAsVisit: boolean;
}

export const DEFAULT_VISIT_RULES: VisitRules = { countRewardRedemptionAsVisit: false };

/** Extract the visit-related settings from a ProgramVersion.mechanics JSON blob, tolerating absence. */
export function readVisitRules(mechanics: unknown): VisitRules {
  if (mechanics && typeof mechanics === "object" && !Array.isArray(mechanics)) {
    const v = (mechanics as Record<string, unknown>).countRewardRedemptionAsVisit;
    if (typeof v === "boolean") return { countRewardRedemptionAsVisit: v };
  }
  return DEFAULT_VISIT_RULES;
}

export function resolveCountsAsVisit(kind: OperationKind, rules: VisitRules): boolean {
  if (VISIT_KINDS.has(kind)) return true;
  if (REDEMPTION_KINDS.has(kind)) return rules.countRewardRedemptionAsVisit;
  return false; // NEVER_VISIT_KINDS and anything unknown
}
