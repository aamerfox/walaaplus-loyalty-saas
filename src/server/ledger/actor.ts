import { OperationKind, OperationSource, Permission } from "@prisma/client";
import { ForbiddenError, ValidationError } from "../errors";
import type { TenantContext } from "../tenant/context";

/**
 * WHO is writing to the ledger. The ledger never accepts a raw businessId or performedByUserId
 * from callers: both are derived from the actor, so a caller cannot spoof another business or
 * another staff member.
 *
 *  member  — a signed-in staff member acting through the scanner or dashboard. Permissions and
 *            location scope come from the verified TenantContext and are enforced here.
 *  system  — the platform itself (enrollment, automation, import, API integration, jobs).
 *            Explicit, narrow and auditable: it must name the business, the source and a reason.
 */
export type MemberSource = typeof OperationSource.SCANNER | typeof OperationSource.DASHBOARD;
export type SystemSource =
  | typeof OperationSource.ENROLLMENT
  | typeof OperationSource.SYSTEM
  | typeof OperationSource.AUTOMATION
  | typeof OperationSource.IMPORT
  | typeof OperationSource.API;

export interface MemberActor {
  kind: "member";
  ctx: TenantContext;
  source: MemberSource;
}

export interface SystemActor {
  kind: "system";
  businessId: string;
  source: SystemSource;
  /** Why the platform is writing — job name, integration id, enrollment flow. Stored nowhere yet but required for traceability. */
  reason: string;
  /** Optional user the system acts for (e.g. an import triggered from the dashboard). */
  onBehalfOfUserId?: string | null;
}

export type LedgerActor = MemberActor | SystemActor;

export const MEMBER_SOURCES: ReadonlySet<OperationSource> = new Set([OperationSource.SCANNER, OperationSource.DASHBOARD]);
export const SYSTEM_SOURCES: ReadonlySet<OperationSource> = new Set([
  OperationSource.ENROLLMENT,
  OperationSource.SYSTEM,
  OperationSource.AUTOMATION,
  OperationSource.IMPORT,
  OperationSource.API,
]);

/** Kinds a staff member may write, and the permission each requires. Anything absent is system-only. */
const MEMBER_KIND_PERMISSION: Readonly<Partial<Record<OperationKind, readonly Permission[]>>> = {
  MANUAL_AWARD: [Permission.MAKE_ACCRUALS],
  VISIT_AWARD: [Permission.MAKE_ACCRUALS],
  PURCHASE_AWARD: [Permission.MAKE_ACCRUALS],
  STAMP_CONVERTED: [Permission.MAKE_ACCRUALS], // consequence of an accrual
  REWARD_EARNED: [Permission.MAKE_ACCRUALS], // consequence of an accrual
  REWARD_REDEEMED: [Permission.MAKE_REDEMPTIONS],
  BALANCE_REDEEMED: [Permission.MAKE_REDEMPTIONS],
  PROMOTION_REDEEMED: [Permission.MAKE_REDEMPTIONS],
  // A reversal both removes and restores value; it needs both sides.
  REVERSAL: [Permission.MAKE_ACCRUALS, Permission.MAKE_REDEMPTIONS],
};

export function validateActor(actor: LedgerActor): void {
  if (actor.kind === "member") {
    if (!MEMBER_SOURCES.has(actor.source)) throw new ValidationError(`Source ${actor.source} is not a member source`);
    return;
  }
  if (!SYSTEM_SOURCES.has(actor.source)) throw new ValidationError(`Source ${actor.source} is not a system source`);
  if (!actor.businessId) throw new ValidationError("System actor requires businessId");
  if (!actor.reason?.trim()) throw new ValidationError("System actor requires a reason");
}

export function actorBusinessId(actor: LedgerActor): string {
  return actor.kind === "member" ? actor.ctx.businessId : actor.businessId;
}

export function actorUserId(actor: LedgerActor): string | null {
  return actor.kind === "member" ? actor.ctx.userId : (actor.onBehalfOfUserId ?? null);
}

/** Throws ForbiddenError unless the member may write this kind. System actors are not restricted by kind here. */
export function assertMemberMayWrite(actor: LedgerActor, kind: OperationKind): void {
  if (actor.kind !== "member") return;
  const required = MEMBER_KIND_PERMISSION[kind];
  if (!required) throw new ForbiddenError(`Operation ${kind} can only be written by the system`);
  for (const p of required) {
    if (!actor.ctx.permissions.has(p)) throw new ForbiddenError(`Missing permission ${p} for ${kind}`);
  }
}
