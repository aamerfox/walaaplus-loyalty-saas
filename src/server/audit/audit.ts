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
  /** A location was renamed, or its staff note changed. Carries the new label, never an address. */
  LOCATION_UPDATED: "location.updated",
  /** A counter was closed to new value. Nothing already written at it moves or changes. */
  LOCATION_DEACTIVATED: "location.deactivated",
  /** A closed counter was opened again, keeping its id and therefore its whole history. */
  LOCATION_REACTIVATED: "location.reactivated",
  /** A ledger group written by the platform rather than by a signed-in staff member. */
  LEDGER_SYSTEM_GROUP_APPENDED: "ledger.system_group_appended",
  /** An authentication window was exhausted. Recorded once per window; never carries credentials. */
  AUTH_RATE_LIMITED: "auth.rate_limited",

  // ── Phase 1a: programs, enrollment, staff ──────────────────────────────────
  /** A program template and its first immutable version were created and activated. */
  PROGRAM_CREATED: "program.created",
  /** The `direct` enrollment source was created for a template. */
  ENROLLMENT_SOURCE_CREATED: "program.enrollment_source_created",
  /**
   * A card was issued to a customer. This is the ONLY record of issuance: the ledger refuses
   * zero-quantity rows, so there is no CARD_ISSUED operation to write. See the note in
   * src/server/customers/enrollment.ts.
   */
  CARD_ISSUED: "card.issued",
  /** An owner created a cashier account. */
  CASHIER_CREATED: "staff.cashier_created",

  // ── Phase 1a, after owner decision B7: enrolment happens at the counter ────
  /**
   * A member of staff enrolled a customer at the till, or confirmed one already enrolled.
   * Carries no phone, no name and no card token — who, which card, and whether it was new.
   */
  CARD_ISSUED_AT_COUNTER: "card.issued_at_counter",
  /**
   * Staff showed a customer their own card link again — the only restore path Phase 1a has.
   * The `shareToken` OPENS the card, so it is never written here: an audit row is read by more
   * people and kept far longer than the screen that legitimately shows a capability.
   */
  CARD_LINK_REVEALED: "card.link_revealed",

  // ── Phase 1b: staff, locations and named sources ──────────────────────────
  /** A membership's location assignments were replaced. Carries location ids, never names or staff details. */
  MEMBERSHIP_LOCATIONS_CHANGED: "membership.locations_changed",
  /** A named enrolment source was created. The token is a capability and is never written here. */
  SOURCE_LINK_CREATED: "program.source_link_created",
  /** A named enrolment source was activated or deactivated. */
  SOURCE_LINK_ACTIVATION_CHANGED: "program.source_link_activation_changed",

  // ── Phase 1b Prompt 3: the program-version lifecycle ──────────────────────
  /** A draft version was created from the live one. Carries the version numbers, not the mechanics. */
  PROGRAM_DRAFT_CREATED: "program.draft_created",
  /** A draft's mechanics or reward tiers were edited. Drafts are mutable; this says when. */
  PROGRAM_DRAFT_UPDATED: "program.draft_updated",
  /** A draft was discarded. Only DRAFT rows can be deleted, enforced by trigger. */
  PROGRAM_DRAFT_DISCARDED: "program.draft_discarded",
  /**
   * A draft became the live version, and the previous one was retired in the same transaction.
   * Carries both version ids and the full published mechanics, because "what were the rules on the
   * day this card was sold" is the question an audit of a loyalty program has to answer.
   */
  PROGRAM_VERSION_PUBLISHED: "program.version_published",
  /** A program was paused (no new enrolment) or resumed. Existing cards are untouched either way. */
  PROGRAM_STATUS_CHANGED: "program.status_changed",
  /** A named source was renamed or its attribution fields changed. Never carries the token. */
  SOURCE_LINK_UPDATED: "program.source_link_updated",
  /** A staff member exhausted their per-actor counter window. Carries no customer data. */
  STAFF_RATE_LIMITED: "staff.rate_limited",

  // ── Phase 2 Prompt 1: saved customer segments ─────────────────────────────
  /**
   * A saved segment was created, changed, archived or restored.
   *
   * The metadata carries the DEFINITION — which is the merchant's own selection rule — and never
   * the customers it matches. An audit row is read by more people and kept far longer than the
   * screen that legitimately shows a count.
   */
  SEGMENT_CREATED: "segment.created",
  SEGMENT_UPDATED: "segment.updated",
  SEGMENT_ARCHIVED: "segment.archived",
  SEGMENT_RESTORED: "segment.restored",
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
