import { CardStatus, MembershipRole, Permission, ReferralEntry, ReferralMethod } from "@prisma/client";
import { AuditAction, recordAudit } from "../audit/audit";
import { prisma, type DbClient } from "../db";
import { ForbiddenError, NotFoundError, ValidationError } from "../errors";
import { requirePermission, type TenantContext } from "../tenant/context";
import { shareTokenDigest } from "./share-links";

/**
 * Recording that a customer arrived with an invitation.
 *
 * ## What this is, and the one sentence it is not
 *
 * It records **attribution**: "this newly issued card was enrolled at a counter where a member of
 * staff saw a valid invitation from that link". It is not a reward, does not become one, and cannot
 * be turned into one by a later read of this table alone — there is no amount, no points, no
 * eligibility flag and no expiry, because no referral reward policy exists (D15). Who is credited
 * for an invitation, on what evidence, when, and within what limits is an owner decision, and a
 * column added here in anticipation of one would be that decision made by an implementation.
 *
 * Nothing in this module touches a balance, a ledger row, a campaign or money. The integration
 * suite asserts that after a successful attribution every balance is exactly where it was.
 *
 * ## The capability is seen once and discarded
 *
 * `recordCounterReferral` takes a raw token, hashes it, looks the digest up, and keeps **the row
 * id**. The raw value is never stored, never written to an audit row, never returned, and never
 * logged — not even its digest reaches an audit row, because a digest in a log is still a way to
 * confirm a guess.
 *
 * It reaches the server only in a POST body on the authenticated counter route. There is no public
 * claim form, no query parameter and no path segment: `/share` stays read-only and anonymous, and
 * B7 is untouched.
 *
 * ## One generic failure
 *
 * Invalid, revoked, malformed, another business's, the customer's own, or a card that already has an
 * attribution all answer `NOT_ACCEPTED`. Staff are told the invitation could not be used and nothing
 * else — the referring customer and their card are never named, shown or implied, and a staff member
 * who could tell "revoked" from "never existed" would be holding a probe.
 */

/** A void note is a sentence for colleagues, not a case file. */
const MAX_REASON = 280;

/** Cards whose invitation may still be presented. Mirrors the share-link rule. */
const SHAREABLE: ReadonlySet<CardStatus> = new Set<CardStatus>([CardStatus.ISSUED, CardStatus.ACTIVE]);

/**
 * What the counter is told.
 *
 * Two values on purpose. Everything that could go wrong collapses into `NOT_ACCEPTED`, so the
 * screen has nothing to say that it should not.
 */
export type ReferralOutcome = "RECORDED" | "NOT_ACCEPTED";

export interface CounterReferralInput {
  /** The value read from the invitation, fragment already stripped by the scanner. */
  rawToken: string;
  /** The card this enrolment just issued. */
  enrolledCustomerCardId: string;
  enrolledProfileId: string;
}

/**
 * Record an attribution for a card that was just issued.
 *
 * Called immediately after a successful counter enrolment, in its own transaction. Not inside the
 * enrolment transaction, and the reason is worth stating rather than leaving as an accident:
 * `enrollCustomer` owns its own transaction and threading one through it would mean changing the
 * enrolment contract, which this phase should not touch. The failure mode of the split is a card
 * issued with no attribution — which is the safe direction. The opposite ordering could record an
 * attribution for an enrolment that then rolled back.
 *
 * Every refusal returns `NOT_ACCEPTED`, and none of them throws: a customer standing at a till has
 * been enrolled successfully, and an unusable invitation must not turn that into an error.
 */
export async function recordCounterReferral(
  ctx: TenantContext,
  input: CounterReferralInput,
): Promise<ReferralOutcome> {
  requirePermission(ctx, Permission.EDIT_CUSTOMERS);

  if (typeof input.rawToken !== "string" || input.rawToken.length < 32 || input.rawToken.length > 256) {
    // Shape-checked before hashing, so a hostile value never reaches the database.
    return "NOT_ACCEPTED";
  }

  /*
   * The referring side, resolved by digest, **scoped to this business in the WHERE**. An invitation
   * from another tenant finds no row at all — not a row this code then rejects — so there is no
   * branch in which a cross-tenant link is momentarily in hand.
   */
  const link = await prisma.cardShareLink.findFirst({
    where: {
      tokenDigest: shareTokenDigest(input.rawToken),
      revokedAt: null,
      businessId: ctx.businessId,
    },
    select: {
      id: true,
      customerCardId: true,
      card: { select: { status: true, customerBusinessProfileId: true, profile: { select: { customerId: true } } } },
    },
  });
  if (!link || !SHAREABLE.has(link.card.status)) return "NOT_ACCEPTED";

  const enrolled = await prisma.customerCard.findFirst({
    where: { id: input.enrolledCustomerCardId, businessId: ctx.businessId },
    select: { id: true, customerBusinessProfileId: true, profile: { select: { customerId: true } } },
  });
  if (!enrolled || enrolled.customerBusinessProfileId !== input.enrolledProfileId) return "NOT_ACCEPTED";

  /*
   * Self-referral, refused where it is safely determinable from identity this system already holds:
   * the same profile in this business, or the same underlying customer. Nothing is guessed beyond
   * that — no household matching, no name similarity, no shared device, no address. Each of those
   * would be an invented rule that wrongly refuses two flatmates, and D19 (whether a card is a
   * person or a household) is not answered here.
   */
  if (
    link.card.customerBusinessProfileId === enrolled.customerBusinessProfileId ||
    link.card.profile.customerId === enrolled.profile.customerId
  ) {
    return "NOT_ACCEPTED";
  }

  try {
    await prisma.$transaction(async (tx) => {
      const attribution = await tx.referralAttribution.create({
        data: {
          businessId: ctx.businessId,
          entry: ReferralEntry.ATTRIBUTED,
          referringShareLinkId: link.id,
          referringCustomerCardId: link.customerCardId,
          enrolledCustomerCardId: enrolled.id,
          enrolledProfileId: enrolled.customerBusinessProfileId,
          method: ReferralMethod.COUNTER_PRESENTED_INVITATION,
          recordedAt: new Date(),
          recordedByUserId: ctx.userId,
        },
        select: { id: true },
      });

      await recordAudit(tx, {
        businessId: ctx.businessId,
        actorUserId: ctx.userId,
        action: AuditAction.REFERRAL_ATTRIBUTED,
        entityType: "CustomerCard",
        entityId: enrolled.id,
        /*
         * The attribution id and the method. **Not the token, not its digest, and not the referring
         * card or link id** — an audit row is read by more people and kept far longer than this
         * request, and the referring side is exactly what staff are not shown.
         */
        metadata: { attributionId: attribution.id, method: ReferralMethod.COUNTER_PRESENTED_INVITATION },
      });
    });
  } catch {
    /*
     * The partial unique index refused it: this card already carries an attribution. That is the
     * integrity rule working, not an error worth surfacing, and the answer is the same generic one
     * as every other refusal.
     */
    return "NOT_ACCEPTED";
  }

  return "RECORDED";
}

/** What a customer's own record may say about how they arrived. Never who invited them. */
export interface ReferralAttributionView {
  id: string;
  recordedAt: Date;
  method: ReferralMethod;
  /** True when a later entry withdrew it. */
  voided: boolean;
  voidedAt: Date | null;
  voidReason: string | null;
  /** A name, never an email and never a user id. */
  recordedByName: string | null;
}

/**
 * The attribution on one card, for the enrolled customer's own record.
 *
 * Deliberately returns **nothing about the referring side** — not a name, not a card, not a link id,
 * not a count. A merchant looking at a customer may know that this customer arrived with an
 * invitation; who sent it is somebody else's record, and this screen is not an introduction service.
 */
export async function getCardAttribution(
  ctx: TenantContext,
  customerCardId: string,
): Promise<ReferralAttributionView | null> {
  requirePermission(ctx, Permission.VIEW_CUSTOMERS);
  if (ctx.role === MembershipRole.CASHIER) {
    // The same bar as the consent history: serving a customer is not reading their record.
    throw new ForbiddenError("Cashiers may serve a customer at the counter, not read their record");
  }

  const attribution = await prisma.referralAttribution.findFirst({
    where: {
      enrolledCustomerCardId: customerCardId,
      businessId: ctx.businessId,
      entry: ReferralEntry.ATTRIBUTED,
    },
    select: {
      id: true,
      recordedAt: true,
      method: true,
      recordedBy: { select: { firstName: true, lastName: true } },
      voidedBy: {
        select: { recordedAt: true, reason: true },
        orderBy: { recordedAt: "desc" },
        take: 1,
      },
    },
  });
  if (!attribution) return null;

  const voided = attribution.voidedBy[0] ?? null;
  return {
    id: attribution.id,
    recordedAt: attribution.recordedAt,
    method: attribution.method,
    voided: voided !== null,
    voidedAt: voided?.recordedAt ?? null,
    voidReason: voided?.reason ?? null,
    recordedByName: [attribution.recordedBy?.firstName, attribution.recordedBy?.lastName].filter(Boolean).join(" ") || null,
  };
}

/**
 * Withdraw an attribution.
 *
 * Owner or manager only. Recording one happens at a till, in front of a customer, and is a cashier's
 * job; deciding that a record of what happened was wrong is not — it is a correction to the
 * business's own history, which is the shape of decision the owner and the manager make everywhere
 * else in this product.
 *
 * Additive: the attribution row is untouched and a `VOIDED` row is written beside it, exactly as a
 * campaign withdrawal works. Nothing is deleted and nothing is edited — the table refuses both.
 *
 * Voiding does **not** free the card to be attributed again. The partial unique index still holds
 * the slot, on purpose: re-attributing afterwards would be retrospective attribution, which this
 * phase refuses to invent.
 */
export async function voidReferralAttribution(
  ctx: TenantContext,
  attributionId: string,
  reason?: string,
): Promise<ReferralAttributionView> {
  requirePermission(ctx, Permission.EDIT_CUSTOMERS);
  if (ctx.role !== MembershipRole.OWNER && ctx.role !== MembershipRole.MANAGER) {
    throw new ForbiddenError("Only an owner or a manager may void a referral attribution");
  }
  const trimmed = reason?.trim();
  if (trimmed !== undefined && (trimmed.length === 0 || trimmed.length > MAX_REASON)) {
    throw new ValidationError("Invalid reason");
  }

  const attribution = await prisma.referralAttribution.findFirst({
    // businessId in the WHERE: another tenant's attribution id does not exist for this caller.
    where: { id: attributionId, businessId: ctx.businessId, entry: ReferralEntry.ATTRIBUTED },
    select: {
      id: true,
      referringShareLinkId: true,
      referringCustomerCardId: true,
      enrolledCustomerCardId: true,
      enrolledProfileId: true,
      method: true,
    },
  });
  if (!attribution) throw new NotFoundError("Referral attribution not found");

  await prisma.$transaction(async (tx) => {
    await tx.referralAttribution.create({
      data: {
        businessId: ctx.businessId,
        entry: ReferralEntry.VOIDED,
        // Copied from the row being withdrawn, so one row reads as a complete account of one event.
        referringShareLinkId: attribution.referringShareLinkId,
        referringCustomerCardId: attribution.referringCustomerCardId,
        enrolledCustomerCardId: attribution.enrolledCustomerCardId,
        enrolledProfileId: attribution.enrolledProfileId,
        method: attribution.method,
        voidsAttributionId: attribution.id,
        reason: trimmed ?? null,
        recordedAt: new Date(),
        recordedByUserId: ctx.userId,
      },
    });

    await recordAudit(tx, {
      businessId: ctx.businessId,
      actorUserId: ctx.userId,
      action: AuditAction.REFERRAL_VOIDED,
      entityType: "CustomerCard",
      entityId: attribution.enrolledCustomerCardId,
      // The attribution id. Not the reason, and not the referring side.
      metadata: { attributionId: attribution.id },
    });
  });

  const view = await getCardAttribution(ctx, attribution.enrolledCustomerCardId);
  if (!view) throw new NotFoundError("Referral attribution not found");
  return view;
}

/**
 * How many attributions a business has recorded. An aggregate, and only an aggregate.
 *
 * There is deliberately no function anywhere that lists them, ranks referrers, or counts per
 * customer. A "top referrers" table is the shape this data takes the moment somebody asks for it,
 * and it is a list of customers ordered by how many friends they brought — which is a reward
 * programme's report, for a reward programme that does not exist (D15).
 */
export interface ReferralAttributionCounts {
  recorded: number;
  voided: number;
  /** Recorded minus voided: what currently stands. */
  standing: number;
}

export async function countReferralAttributions(
  ctx: TenantContext,
  range?: { from: Date; to: Date },
  db: DbClient = prisma,
): Promise<ReferralAttributionCounts> {
  requirePermission(ctx, Permission.VIEW_CUSTOMERS);
  const window = range ? { recordedAt: { gte: range.from, lt: range.to } } : {};

  const [recorded, voided] = await Promise.all([
    db.referralAttribution.count({
      where: { businessId: ctx.businessId, entry: ReferralEntry.ATTRIBUTED, ...window },
    }),
    db.referralAttribution.count({
      where: { businessId: ctx.businessId, entry: ReferralEntry.VOIDED, ...window },
    }),
  ]);

  return { recorded, voided, standing: Math.max(recorded - voided, 0) };
}
