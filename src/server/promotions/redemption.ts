import {
  MembershipRole,
  Permission,
  PromotionState,
  RedemptionEntry,
  RedemptionMethod,
} from "@prisma/client";
import { AuditAction, recordAudit } from "../audit/audit";
import { prisma } from "../db";
import { ForbiddenError, NotFoundError, ValidationError } from "../errors";
import { requirePermission, type TenantContext } from "../tenant/context";
import { codeDigest, digestsMatch, isUsableCode } from "./codes";
import { MAX_PROMOTIONS_PER_BUSINESS } from "./promotions";

/**
 * Redeeming a coupon at the counter.
 *
 * ## What a redemption is
 *
 * A durable **entitlement**: this customer is owed something, and a person will hand it over. It
 * moves no money, no points, no stamps and no loyalty balance, touches no campaign, issues no wallet
 * pass and sends no message. A test asserts every balance is byte-identical afterwards.
 *
 * The cashier is told, in as many words, that the offer was **recorded for manual fulfilment**. A
 * success message that said "applied" or "redeemed" alone would let a till believe something
 * happened to a total.
 *
 * ## One generic refusal
 *
 * Unknown, malformed, draft, paused, expired, outside the window, fully used, already used by this
 * customer, another business's: all `NOT_ACCEPTED`. A cashier who could tell those apart could ask
 * the till which codes exist, one guess at a time.
 *
 * **And a refusal never fails the workflow.** The card lookup or the enrolment that carried the code
 * has already succeeded; the customer is standing at the counter. A bad coupon is a second sentence,
 * not an error.
 *
 * ## The raw code
 *
 * Arrives in a POST body on an authenticated staff route, is normalised, hashed against each
 * candidate promotion's salt, and discarded. It is never stored, returned, rendered, logged or
 * written to an audit row — and neither is the digest, because a digest of a short human-chosen
 * string is still a way to confirm a guess.
 *
 * ## Atomicity
 *
 * The promotion row is locked `FOR UPDATE` before the counts are read, so two tills redeeming the
 * last coupon at the same moment serialise: the second sees the first's row and is refused. The
 * database re-counts in `promotion_redemption_validate`, which is the backstop for any caller that
 * skips the lock.
 */

/** What the counter is told. Two values, and the refusal names no reason. */
export type RedemptionOutcome =
  | { outcome: "RECORDED"; redemptionId: string; promotionName: string; benefitDescription: string }
  | { outcome: "NOT_ACCEPTED" };

export interface RedeemCouponInput {
  /** As typed. Normalised and hashed here; never stored. */
  code: string;
  customerCardId: string;
}

/**
 * Redeem a code for a card.
 *
 * `MAKE_REDEMPTIONS` — the permission a cashier already holds to hand over a loyalty reward, which
 * is the same act with a different piece of paper behind it.
 */
export async function redeemCoupon(ctx: TenantContext, input: RedeemCouponInput): Promise<RedemptionOutcome> {
  requirePermission(ctx, Permission.MAKE_REDEMPTIONS);

  if (typeof input.code !== "string" || !isUsableCode(input.code)) return { outcome: "NOT_ACCEPTED" };

  const card = await prisma.customerCard.findFirst({
    // businessId in the WHERE: another tenant's card id resolves to no row at all.
    where: { id: input.customerCardId, businessId: ctx.businessId },
    select: { id: true, customerBusinessProfileId: true },
  });
  if (!card) return { outcome: "NOT_ACCEPTED" };

  /*
   * A salted digest cannot be looked up directly, so the candidates are read and compared. Scoped to
   * ACTIVE promotions of THIS business, bounded by the per-business cap — which keeps the work
   * small and keeps the lookup inside one tenant by construction rather than by a `WHERE` somebody
   * could forget to write.
   */
  const candidates = await prisma.promotion.findMany({
    where: { businessId: ctx.businessId, state: PromotionState.ACTIVE },
    select: { id: true, codeSalt: true, codeDigest: true },
    take: MAX_PROMOTIONS_PER_BUSINESS,
  });

  let promotionId: string | null = null;
  for (const candidate of candidates) {
    if (digestsMatch(candidate.codeDigest, codeDigest(candidate.codeSalt, ctx.businessId, input.code))) {
      promotionId = candidate.id;
      break;
    }
  }
  if (!promotionId) return { outcome: "NOT_ACCEPTED" };

  try {
    return await prisma.$transaction(async (tx) => {
      /*
       * The lock, before anything is counted. Two tills redeeming the last coupon at the same
       * instant serialise here; the second reads the first's row and is refused rather than both
       * seeing "one left".
       */
      await tx.$executeRaw`SELECT id FROM "Promotion" WHERE id = ${promotionId} FOR UPDATE`;

      const promotion = await tx.promotion.findFirst({
        where: { id: promotionId, businessId: ctx.businessId },
        select: {
          id: true,
          name: true,
          benefitDescription: true,
          state: true,
          startsAt: true,
          endsAt: true,
          totalLimit: true,
          perCustomerLimit: true,
        },
      });
      if (!promotion || promotion.state !== PromotionState.ACTIVE) return { outcome: "NOT_ACCEPTED" as const };

      /*
       * The window, checked here so a cashier gets a refusal rather than a database error.
       *
       * This is NOT where the rule lives. `walaaplus_validate_redemption` stamps `recordedAt` with
       * the server's own clock and re-checks the window against it, so the answer does not depend
       * on this process's idea of the time, and a writer that skips this service gets the same
       * answer. Nothing below passes a timestamp.
       */
      const now = new Date();
      if (promotion.startsAt && now < promotion.startsAt) return { outcome: "NOT_ACCEPTED" as const };
      if (promotion.endsAt && now >= promotion.endsAt) return { outcome: "NOT_ACCEPTED" as const };

      /*
       * Limits, over redemptions that have not been voided. A void here means "that did not
       * happen", so it frees the slot and the customer can use their coupon — deliberately the
       * opposite of `ReferralAttribution`, where voiding does not free one because re-attributing
       * would be retrospective.
       */
      if (promotion.totalLimit !== null) {
        const used = await countStanding(tx, promotion.id, null);
        if (used >= promotion.totalLimit) return { outcome: "NOT_ACCEPTED" as const };
      }
      if (promotion.perCustomerLimit !== null) {
        const used = await countStanding(tx, promotion.id, card.customerBusinessProfileId);
        if (used >= promotion.perCustomerLimit) return { outcome: "NOT_ACCEPTED" as const };
      }

      const redemption = await tx.promotionRedemption.create({
        data: {
          businessId: ctx.businessId,
          promotionId: promotion.id,
          entry: RedemptionEntry.REDEEMED,
          customerCardId: card.id,
          customerBusinessProfileId: card.customerBusinessProfileId,
          method: RedemptionMethod.COUNTER_TYPED_CODE,
          recordedByUserId: ctx.userId,
        },
        select: { id: true },
      });

      await recordAudit(tx, {
        businessId: ctx.businessId,
        actorUserId: ctx.userId,
        action: AuditAction.PROMOTION_REDEEMED,
        entityType: "CustomerCard",
        entityId: card.id,
        // The two row ids. **Never the code, never its digest, and no amount** — there is none.
        metadata: { redemptionId: redemption.id, promotionId: promotion.id },
      });

      return {
        outcome: "RECORDED" as const,
        redemptionId: redemption.id,
        promotionName: promotion.name,
        benefitDescription: promotion.benefitDescription,
      };
    });
  } catch {
    /*
     * The database refused it — a limit the trigger re-counted, or a row that did not agree with
     * itself. Either way it is the integrity rules working, and the answer is the same generic one
     * as every other refusal rather than an error a cashier has to interpret at a till.
     */
    return { outcome: "NOT_ACCEPTED" };
  }
}

/** Redemptions that currently stand, for a promotion and optionally for one customer. */
async function countStanding(
  tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0],
  promotionId: string,
  profileId: string | null,
): Promise<number> {
  const rows = await tx.promotionRedemption.findMany({
    where: {
      promotionId,
      entry: RedemptionEntry.REDEEMED,
      ...(profileId ? { customerBusinessProfileId: profileId } : {}),
      // Not withdrawn. The same condition the trigger applies, written the same way round.
      voidedBy: { none: {} },
    },
    select: { id: true },
  });
  return rows.length;
}

/** One entitlement on a customer's record. Never a code, and never an amount. */
export interface RedemptionView {
  id: string;
  promotionName: string;
  benefitDescription: string;
  recordedAt: Date;
  voided: boolean;
  voidedAt: Date | null;
  voidReason: string | null;
  /** A name, never an email and never a user id. */
  recordedByName: string | null;
}

/**
 * What a customer is owed, and what was withdrawn.
 *
 * The same bar as the consent history: reading a customer's record is not serving them, so a cashier
 * is refused. They redeem a code the customer presents; they do not browse what that customer has
 * been given.
 */
export async function listCardRedemptions(ctx: TenantContext, customerCardId: string): Promise<RedemptionView[]> {
  requirePermission(ctx, Permission.VIEW_CUSTOMERS);
  if (ctx.role === MembershipRole.CASHIER) {
    throw new ForbiddenError("Cashiers may serve a customer at the counter, not read their record");
  }

  const rows = await prisma.promotionRedemption.findMany({
    where: { customerCardId, businessId: ctx.businessId, entry: RedemptionEntry.REDEEMED },
    orderBy: { recordedAt: "desc" },
    take: 50,
    select: {
      id: true,
      recordedAt: true,
      promotion: { select: { name: true, benefitDescription: true } },
      recordedBy: { select: { firstName: true, lastName: true } },
      voidedBy: { select: { recordedAt: true, reason: true }, orderBy: { recordedAt: "desc" }, take: 1 },
    },
  });

  return rows.map((row) => {
    const voided = row.voidedBy[0] ?? null;
    return {
      id: row.id,
      promotionName: row.promotion.name,
      benefitDescription: row.promotion.benefitDescription,
      recordedAt: row.recordedAt,
      voided: voided !== null,
      voidedAt: voided?.recordedAt ?? null,
      voidReason: voided?.reason ?? null,
      recordedByName: [row.recordedBy?.firstName, row.recordedBy?.lastName].filter(Boolean).join(" ") || null,
    };
  });
}

/** A void note is a sentence for colleagues, not a case file. */
const MAX_REASON = 280;

/**
 * Withdraw a redemption.
 *
 * Owner or manager only. Redeeming happens at a till and is a cashier's job; deciding that a record
 * of what happened was wrong is a correction to the business's own history.
 *
 * Additive: the redemption row is untouched and a `VOIDED` row is written beside it. **It frees the
 * slot** — the customer may redeem again — because a void here means the redemption did not happen.
 */
export async function voidRedemption(
  ctx: TenantContext,
  redemptionId: string,
  reason?: string,
): Promise<RedemptionView> {
  requirePermission(ctx, Permission.MAKE_REDEMPTIONS);
  if (ctx.role !== MembershipRole.OWNER && ctx.role !== MembershipRole.MANAGER) {
    throw new ForbiddenError("Only an owner or a manager may withdraw a redemption");
  }
  const trimmed = reason?.trim();
  if (trimmed !== undefined && (trimmed.length === 0 || trimmed.length > MAX_REASON)) {
    throw new ValidationError("Invalid reason");
  }

  const existing = await prisma.promotionRedemption.findFirst({
    where: { id: redemptionId, businessId: ctx.businessId, entry: RedemptionEntry.REDEEMED },
    select: {
      id: true,
      promotionId: true,
      customerCardId: true,
      customerBusinessProfileId: true,
      method: true,
    },
  });
  if (!existing) throw new NotFoundError("Redemption not found");

  await prisma.$transaction(async (tx) => {
    await tx.promotionRedemption.create({
      data: {
        businessId: ctx.businessId,
        promotionId: existing.promotionId,
        entry: RedemptionEntry.VOIDED,
        // Copied from the row being withdrawn, so one row reads as a complete account of one event.
        // `promotion_redemption_validate` checks the copy is faithful.
        customerCardId: existing.customerCardId,
        customerBusinessProfileId: existing.customerBusinessProfileId,
        method: existing.method,
        voidsRedemptionId: existing.id,
        reason: trimmed ?? null,
        recordedByUserId: ctx.userId,
      },
    });

    await recordAudit(tx, {
      businessId: ctx.businessId,
      actorUserId: ctx.userId,
      action: AuditAction.PROMOTION_REDEMPTION_VOIDED,
      entityType: "CustomerCard",
      entityId: existing.customerCardId,
      // The row id. Not the reason, not the code, and there is no amount to omit.
      metadata: { redemptionId: existing.id, promotionId: existing.promotionId },
    });
  });

  const views = await listCardRedemptions(ctx, existing.customerCardId);
  const view = views.find((row) => row.id === existing.id);
  if (!view) throw new NotFoundError("Redemption not found");
  return view;
}
