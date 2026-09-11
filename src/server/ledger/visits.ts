import { OperationKind, OperationSource } from "@prisma/client";
import { ValidationError } from "../errors";

/**
 * `countsAsVisit` policy (docs/PRODUCT-SPEC.md §5.4, remediation item 5).
 *
 * Evaluated ONCE when a row is written and stored immutably, so historical rows keep the definition
 * that applied at the time. The decision considers four inputs:
 *
 *   kind      what happened
 *   source    who wrote it (scanner, dashboard, enrollment, system, automation, import, API)
 *   rules     the card's pinned ProgramVersion setting for redemptions
 *   explicit  the caller's stated intent — REQUIRED for API/automation awards and for every
 *             integration action, FORBIDDEN everywhere the policy decides
 *
 * Nothing becomes a visit implicitly through an integration path.
 */

/** Staff-initiated awards for a real customer interaction. */
export const AWARD_KINDS: ReadonlySet<OperationKind> = new Set<OperationKind>([
  OperationKind.MANUAL_AWARD,
  OperationKind.VISIT_AWARD,
  OperationKind.PURCHASE_AWARD,
]);

/** External-system actions. Never a visit by default; the integration must say so. */
export const INTEGRATION_KINDS: ReadonlySet<OperationKind> = new Set<OperationKind>([OperationKind.INTEGRATION_AWARD]);

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

/** Sources whose awards count as visits by policy, with no explicit flag allowed. */
const POLICY_VISIT_SOURCES: ReadonlySet<OperationSource> = new Set([OperationSource.SCANNER, OperationSource.DASHBOARD]);

/** Sources that must state intent explicitly on award kinds. */
const EXPLICIT_INTENT_SOURCES: ReadonlySet<OperationSource> = new Set([OperationSource.API, OperationSource.AUTOMATION]);

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

export interface VisitDecisionInput {
  kind: OperationKind;
  source: OperationSource;
  rules: VisitRules;
  explicit?: boolean;
}

export function resolveCountsAsVisit({ kind, source, rules, explicit }: VisitDecisionInput): boolean {
  if (NEVER_VISIT_KINDS.has(kind)) {
    if (explicit !== undefined) throw new ValidationError(`${kind} never counts as a visit; countsAsVisit must not be set`);
    return false;
  }

  if (REDEMPTION_KINDS.has(kind)) {
    if (explicit !== undefined) {
      throw new ValidationError(`${kind} visit policy is fixed by the ProgramVersion; countsAsVisit must not be set`);
    }
    return rules.countRewardRedemptionAsVisit;
  }

  if (INTEGRATION_KINDS.has(kind)) {
    // Integrations never become visits implicitly, whatever the source.
    if (typeof explicit !== "boolean") throw new ValidationError(`${kind} must state countsAsVisit explicitly`);
    return explicit;
  }

  if (AWARD_KINDS.has(kind)) {
    if (EXPLICIT_INTENT_SOURCES.has(source)) {
      if (typeof explicit !== "boolean") throw new ValidationError(`${kind} from ${source} must state countsAsVisit explicitly`);
      return explicit;
    }
    if (explicit !== undefined) throw new ValidationError(`${kind} from ${source} follows policy; countsAsVisit must not be set`);
    // Staff-initiated: a visit. Platform-initiated (ENROLLMENT, SYSTEM, IMPORT): not a visit.
    return POLICY_VISIT_SOURCES.has(source);
  }

  throw new ValidationError(`Unclassified operation kind ${kind}`);
}
