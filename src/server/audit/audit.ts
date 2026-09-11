import type { Prisma } from "@prisma/client";
import type { DbClient } from "../db";

/** Stable action names. Add here; never invent ad-hoc strings at call sites. */
export const AuditAction = {
  USER_REGISTERED: "user.registered",
  BUSINESS_CREATED: "business.created",
  BUSINESS_UPDATED: "business.updated",
  MEMBERSHIP_CREATED: "membership.created",
  MEMBERSHIP_ROLE_CHANGED: "membership.role_changed",
  MEMBERSHIP_PERMISSIONS_CHANGED: "membership.permissions_changed",
  MEMBERSHIP_DEACTIVATED: "membership.deactivated",
  MEMBERSHIP_REACTIVATED: "membership.reactivated",
  LOCATION_CREATED: "location.created",
  /** A ledger group written by the platform rather than by a signed-in staff member. */
  LEDGER_SYSTEM_GROUP_APPENDED: "ledger.system_group_appended",
  /** An authentication window was exhausted. Recorded once per window; never carries credentials. */
  AUTH_RATE_LIMITED: "auth.rate_limited",
} as const;
export type AuditActionName = (typeof AuditAction)[keyof typeof AuditAction];

export interface AuditEntry {
  action: AuditActionName;
  entityType: string;
  entityId?: string | null;
  businessId?: string | null;
  actorUserId?: string | null;
  metadata?: Prisma.InputJsonValue;
  ipAddress?: string | null;
}

/**
 * Write one AuditLog row. Pass the transaction client so the audit row commits or rolls back
 * together with the change it describes.
 */
export async function recordAudit(db: DbClient, entry: AuditEntry): Promise<void> {
  await db.auditLog.create({
    data: {
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId ?? null,
      businessId: entry.businessId ?? null,
      actorUserId: entry.actorUserId ?? null,
      metadata: entry.metadata,
      ipAddress: entry.ipAddress ?? null,
    },
  });
}
