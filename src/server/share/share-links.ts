import { createHash, randomBytes } from "node:crypto";
import { CardStatus, MembershipRole, Permission } from "@prisma/client";
import { AuditAction, recordAudit } from "../audit/audit";
import { prisma, type DbClient } from "../db";
import { ForbiddenError, NotFoundError } from "../errors";
import { requirePermission, type TenantContext } from "../tenant/context";

/**
 * The invitation capability behind a wallet pass's web link.
 *
 * ## What it is, and what it is drawn apart from
 *
 * A card carries four opaque values already: the scanner `qrToken`, the card-page `shareToken`, the
 * serial number, and the enrolment source token. This is a fifth, drawn independently of all of
 * them, because the whole point is that holding one yields none of the others. Somebody who is sent
 * an invitation link cannot open the card it came from, cannot see a balance, cannot scan anything
 * at a counter, and cannot find out whose card it was.
 *
 * ## The raw value is never stored
 *
 * Only `sha256(raw)` reaches the database. No salt and no keyed HMAC, deliberately:
 *
 *  - the input is 32 bytes of `crypto.randomBytes`, so there is no dictionary to precompute and a
 *    salt would protect against nothing;
 *  - a keyed digest would need a secret, and introducing one is outside this phase.
 *
 * A copy of the database therefore yields nobody a working link — which is the property that makes
 * it safe to keep revoked rows forever.
 *
 * ## The raw value never reaches a server log either
 *
 * The link is `https://host/share#<token>`. A URL fragment is not sent with the request, so the
 * token appears in no access log, no proxy log, no `Referer` header and no error report. The page
 * reads it in the browser and hands it to `resolveShareLink` in a POST body, which is the only
 * place on the server that ever sees one — and which writes nothing at all.
 *
 * That last part is a rule, not an implementation detail: **`resolveShareLink` records nothing.**
 * No audit row, no visit count, no IP, no device. A capability that leaves a trail every time it is
 * opened is a capability that tells somebody who has been looking at it.
 *
 * ## Issue-once, revoke-once
 *
 * `mintShareLink` revokes a card's live link and issues a new one in the same transaction. There is
 * no "regenerate in place": the raw value of the old link is unrecoverable by construction, so
 * anything that hands out a new one must retire the old one or a customer ends up with two live
 * links and no way to tell them apart. `CardShareLink` refuses DELETE and TRUNCATE by trigger, and
 * permits exactly one UPDATE — `revokedAt`, once, from NULL.
 */

/** 32 bytes = 256 bits. Guessing one is not a threat model, it is arithmetic. */
export const SHARE_TOKEN_BYTES = 32;

/** Why a link was minted. A label on the record, never a route to anything. */
export type ShareLinkPurpose = "APPLE_WALLET" | "GOOGLE_WALLET" | "WALLET_PASS";

/** Cards that may carry an invitation link. A deleted card's link is not reissued. */
const SHAREABLE: ReadonlySet<CardStatus> = new Set<CardStatus>([CardStatus.ISSUED, CardStatus.ACTIVE]);

export function shareTokenDigest(rawToken: string): string {
  return createHash("sha256").update(rawToken, "utf8").digest("hex");
}

/**
 * A minted capability.
 *
 * `rawToken` exists here and nowhere else. Whatever receives it must put it in exactly one place —
 * the wallet pass URL — and must not log it, return it to an owner screen, or write it anywhere.
 */
export interface MintedShareLink {
  id: string;
  rawToken: string;
  issuedAt: Date;
}

/**
 * Retire whatever link a card has and issue a fresh one.
 *
 * Lazy by design: nothing backfills, no bulk job walks the card table, and a card that has never
 * had a wallet pass prepared has no row here at all. A capability is minted the first time the
 * authorized issuance path asks for one, and every time it asks again.
 */
export async function mintShareLink(
  ctx: TenantContext,
  customerCardId: string,
  purpose: ShareLinkPurpose,
): Promise<MintedShareLink> {
  // A counter action, and a cashier holds EDIT_CUSTOMERS because enrolling a customer is their job
  // (owner decision B7 option 3). Adding the card they just issued to a wallet is the same moment.
  requirePermission(ctx, Permission.EDIT_CUSTOMERS);

  const card = await prisma.customerCard.findFirst({
    // businessId in the WHERE, not checked afterwards: another tenant's card id finds no row.
    where: { id: customerCardId, businessId: ctx.businessId },
    select: { id: true, status: true },
  });
  if (!card || !SHAREABLE.has(card.status)) throw new NotFoundError("Card not found");

  const rawToken = randomBytes(SHARE_TOKEN_BYTES).toString("base64url");
  const issuedAt = new Date();

  const id = await prisma.$transaction(async (tx) => {
    /*
     * The partial unique index allows one live row per card, so retiring the old one has to happen
     * before the insert rather than beside it. Inside the transaction, so a crash between the two
     * cannot leave a card with no link and a revoked one it can no longer recover.
     */
    await tx.cardShareLink.updateMany({
      where: { customerCardId: card.id, revokedAt: null },
      data: { revokedAt: issuedAt },
    });

    const created = await tx.cardShareLink.create({
      data: {
        businessId: ctx.businessId,
        customerCardId: card.id,
        tokenDigest: shareTokenDigest(rawToken),
        issuedFor: purpose,
        issuedAt,
        issuedByUserId: ctx.userId,
      },
      select: { id: true },
    });

    await recordAudit(tx, {
      businessId: ctx.businessId,
      actorUserId: ctx.userId,
      action: AuditAction.SHARE_LINK_ISSUED,
      entityType: "CustomerCard",
      entityId: card.id,
      /*
       * The row id and the purpose. **Not the token, and not the digest** — a digest in an audit
       * log is still a way to confirm a guess, and an audit row is read by more people and kept
       * longer than the capability it would be confirming.
       */
      metadata: { shareLinkId: created.id, issuedFor: purpose },
    });

    return created.id;
  });

  return { id, rawToken, issuedAt };
}

/**
 * Revoke a card's live link without issuing another. The customer's pass link stops working.
 *
 * A higher bar than minting, deliberately. Minting happens at the counter — a cashier handing over
 * a card is exactly the person who adds it to a wallet, which is why `EDIT_CUSTOMERS` alone is the
 * right gate there. Revoking destroys something the customer already holds and is not part of
 * serving whoever is standing in front of you, so it takes the same bar as editing a consent
 * record: `EDIT_CUSTOMERS`, and not a cashier.
 *
 * `src/server/tenant/permissions.ts` asks for exactly this: the comment beside the cashier's
 * `EDIT_CUSTOMERS` grant says anything guarded on it later must decide whether a cashier should
 * have it, rather than assume the bit still means what it meant when it was added.
 */
export async function revokeShareLink(ctx: TenantContext, customerCardId: string): Promise<boolean> {
  requirePermission(ctx, Permission.EDIT_CUSTOMERS);
  if (ctx.role === MembershipRole.CASHIER) {
    throw new ForbiddenError("Cashiers may hand a customer their card, not withdraw a link they already hold");
  }

  const card = await prisma.customerCard.findFirst({
    where: { id: customerCardId, businessId: ctx.businessId },
    select: { id: true },
  });
  if (!card) throw new NotFoundError("Card not found");

  return prisma.$transaction(async (tx) => {
    const { count } = await tx.cardShareLink.updateMany({
      where: { customerCardId: card.id, businessId: ctx.businessId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    if (count === 0) return false;

    await recordAudit(tx, {
      businessId: ctx.businessId,
      actorUserId: ctx.userId,
      action: AuditAction.SHARE_LINK_REVOKED,
      entityType: "CustomerCard",
      entityId: card.id,
      metadata: { revoked: count },
    });
    return true;
  });
}

/** Whether a card has a live invitation link, for an owner screen. Never the token or the digest. */
export interface ShareLinkStatus {
  live: boolean;
  issuedAt: Date | null;
  issuedFor: string | null;
  /** How many have been issued over this card's life, live and revoked. */
  everIssued: number;
}

export async function getShareLinkStatus(ctx: TenantContext, customerCardId: string): Promise<ShareLinkStatus> {
  requirePermission(ctx, Permission.VIEW_CUSTOMERS);
  if (ctx.role === MembershipRole.CASHIER) {
    // The same bar the consent history uses: serving a customer is not reading their record.
    throw new ForbiddenError("Cashiers may serve a customer at the counter, not read their card's links");
  }

  const [live, everIssued] = await Promise.all([
    prisma.cardShareLink.findFirst({
      where: { customerCardId, businessId: ctx.businessId, revokedAt: null },
      select: { issuedAt: true, issuedFor: true },
    }),
    prisma.cardShareLink.count({ where: { customerCardId, businessId: ctx.businessId } }),
  ]);

  return {
    live: live !== null,
    issuedAt: live?.issuedAt ?? null,
    issuedFor: live?.issuedFor ?? null,
    everIssued,
  };
}

/**
 * What the PUBLIC invitation page is allowed to know.
 *
 * A business name, and nothing else. No customer name, no phone, no card, no balance, no programme,
 * no serial, no token of any kind, and no identifier a caller could pivot from.
 *
 * `null` covers every failure in one shape: unknown, revoked, malformed, a card that has since been
 * deleted, and a business that is no longer active. The page renders the same generic notice for
 * all of them, because distinguishing "never existed" from "existed and was revoked" is exactly the
 * difference worth probing for.
 */
export interface PublicShareView {
  businessName: string;
}

/**
 * Resolve a raw capability. **Writes nothing.**
 *
 * No audit row, no counter, no IP, no user agent, no timestamp update. This is the one endpoint in
 * the product that a stranger reaches while holding a secret, and the honest handling of that is to
 * answer the question and forget it happened.
 *
 * Not rate limited, and that is a decision rather than an oversight: a per-address limit would mean
 * storing the address of everybody who opens an invitation, which is the tracking this page exists
 * without. The token is 256 bits of randomness behind a single indexed digest lookup; guessing is
 * not a threat model.
 */
export async function resolveShareLink(rawToken: unknown, db: DbClient = prisma): Promise<PublicShareView | null> {
  // Shape-checked before hashing so a hostile body cannot reach the database at all.
  if (typeof rawToken !== "string" || rawToken.length < 32 || rawToken.length > 256) return null;

  const link = await db.cardShareLink.findFirst({
    where: { tokenDigest: shareTokenDigest(rawToken), revokedAt: null },
    select: {
      card: { select: { status: true } },
      business: { select: { name: true, active: true } },
    },
  });
  if (!link) return null;
  if (!link.business.active) return null;
  if (!SHAREABLE.has(link.card.status)) return null;

  return { businessName: link.business.name };
}
