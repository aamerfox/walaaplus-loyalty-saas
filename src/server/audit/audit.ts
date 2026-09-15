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
  /**
   * A customer's marketing preference was changed by a member of staff.
   *
   * Carries the scope and the two states, and never the customer's name, phone or the free-text
   * reason: an audit row is read by more people and kept far longer than the screen that reason was
   * typed into. The entity id is the PROFILE, so the change is findable from the customer.
   */
  CONSENT_RECORDED: "consent.recorded",

  // ── Phase 2 Prompt 2: campaign drafts. Nothing here sends anything. ───────
  CAMPAIGN_CREATED: "campaign.created",
  /** A new revision was written. The content is NOT copied here; the revision row holds it. */
  CAMPAIGN_REVISED: "campaign.revised",
  CAMPAIGN_STATE_CHANGED: "campaign.state_changed",
  CAMPAIGN_AUDIENCE_SET: "campaign.audience_set",

  // ── Phase 2 Prompt 3: approval. Still nothing here sends anything. ────────
  /**
   * A person approved one exact revision for one declared channel.
   *
   * Carries the revision number, the channel and the snapshot's COUNTS. It never carries a
   * recipient id, and the snapshot id it references leads to a table with no contact data in it.
   */
  CAMPAIGN_APPROVED: "campaign.approved",
  /** An approval was explicitly taken back. Both rows stay in the decision history. */
  CAMPAIGN_WITHDRAWN: "campaign.withdrawn",
  /** An edit invalidated a standing approval. Recorded because it happens as a side effect. */
  CAMPAIGN_APPROVAL_INVALIDATED: "campaign.approval_invalidated",

  // ── Phase 3A Prompt 1: wallet web links. ─────────────────────────────────
  /**
   * An invitation capability was minted for a card.
   *
   * Carries the row id and why it was issued. **Never the token, and never its digest** — a digest
   * in an audit log is still a way to confirm a guess, and this row is read by more people and kept
   * far longer than the capability it would be confirming.
   */
  SHARE_LINK_ISSUED: "share_link.issued",
  /** A card's invitation link was revoked. The link stops working; the row stays. */
  SHARE_LINK_REVOKED: "share_link.revoked",

  // ── Phase 3A Prompt 3: promotions. Still no money, anywhere. ─────────────
  /**
   * A promotion was created.
   *
   * Carries the name and the limits. **Never the code, its digest or its salt** — a digest of a
   * short human-chosen string is still a way to confirm a guess, and an audit row is read by more
   * people and kept far longer than the request that carried the code.
   */
  PROMOTION_CREATED: "promotion.created",
  /** Its settings changed. The code cannot be among them; the trigger refuses one. */
  PROMOTION_UPDATED: "promotion.updated",
  PROMOTION_STATE_CHANGED: "promotion.state_changed",
  /** A coupon was recorded for manual fulfilment. No balance moved, so none is recorded. */
  PROMOTION_REDEEMED: "promotion.redeemed",
  /** An owner or manager withdrew one. Both rows stay. */
  PROMOTION_REDEMPTION_VOIDED: "promotion.redemption_voided",

  // ── Phase 3B Prompt 2: webhook destinations. The only outbound capability. ─
  /**
   * The owner configured somewhere to send this business's events.
   *
   * Carries the name and the **hostname**. **Never the full URL, never the signing secret, and
   * never either ciphertext** \u2014 the URL may hold a path token the receiver treats as
   * authentication, and an audit row is read by more people and kept far longer than the request
   * that created it.
   */
  WEBHOOK_DESTINATION_CREATED: "webhook.destination_created",
  /** Enabled, disabled or revoked. The two states and nothing else. */
  WEBHOOK_DESTINATION_STATE_CHANGED: "webhook.destination_state_changed",
  /** A new signing secret was issued. The key version, never the secret. */
  WEBHOOK_SECRET_ROTATED: "webhook.secret_rotated",
  /** The owner asked for one fixed synthetic test envelope. Two row ids, no URL. */
  WEBHOOK_TEST_QUEUED: "webhook.test_queued",

  /*
   * API key lifecycle - Phase 3B.1.
   *
   * LIFECYCLE ONLY. There is deliberately no action for "a key was used": one audit row per read
   * request would let a key holder turn their own rate limit into unbounded writes to the audit
   * table, and the useful record of use is `ApiKey.lastUsedAt`, which is one monotonic column.
   *
   * None of these metadata payloads carries a key or a digest. The public prefix is enough for an
   * owner to recognise which key an entry is about.
   */
  API_KEY_CREATED: "api_key.created",
  API_KEY_ROTATED: "api_key.rotated",
  API_KEY_REVOKED: "api_key.revoked",

  // ── Phase 3A Prompt 2: referral attribution. Still no reward, anywhere. ───
  /**
   * A newly issued card was recorded as having arrived with an invitation.
   *
   * Carries the attribution id and the method. **Not the capability, not its digest, and not the
   * referring card or link** — the referring side is exactly what staff are not shown, and an audit
   * row is read by more people and kept far longer than the request that wrote it.
   */
  REFERRAL_ATTRIBUTED: "referral.attributed",
  /** An attribution was withdrawn by an owner or a manager. Both rows stay. */
  REFERRAL_VOIDED: "referral.voided",

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
