import { CardStatus, CardType, Permission } from "@prisma/client";
import { prisma } from "../db";
import { NotFoundError, ValidationError } from "../errors";
import { readStampMechanics } from "../program/mechanics";
import { publicShareUrl } from "../program/public-urls";
import { getShareLinkStatus, mintShareLink, type ShareLinkStatus } from "../share/share-links";
import { requirePermission, type TenantContext } from "../tenant/context";
import {
  buildApplePassJson,
  buildGoogleLoyaltyObject,
  redactInvitationUrls,
  REDACTED_TOKEN,
  type ApplePassJson,
  type GoogleLoyaltyObject,
  type WalletPassInput,
} from "./pass-payloads";

/**
 * Wallet passes: the authorized path that mints a card's invitation capability, and the redacted
 * view an owner screen is allowed to see.
 *
 * ## Two functions, and the difference between them is the point
 *
 * `issueWalletPassPayloads` **mints**. It draws a fresh capability, revokes the card's previous
 * one, and returns payloads containing the live URL. It is the function a future signing step calls,
 * and it is deliberately **not exposed on any route in this phase**: there is no signing, so there
 * is nothing legitimate to do with an unsigned payload that carries a live token, and a route
 * returning one would be a token-disclosure surface built for no consumer.
 *
 * `previewWalletPass` **does not mint**. It reports whether a card has a live link and shows where
 * in each payload the URL sits, with the token replaced by a placeholder. That is what the owner UI
 * gets, because the capability belongs to the customer, in their wallet, and nowhere else.
 *
 * A preview that minted would be worse than useless: every look at a card would retire the link the
 * customer already has in their wallet.
 *
 * ## Issuer configuration does not exist here
 *
 * Apple needs a Pass Type ID and a team identifier; Google needs an issuer id and a class. All four
 * are deployment configuration, and this phase may not add an environment variable or a secret. So
 * they are parameters, filled with obvious placeholders for a preview and supplied by the caller
 * for a real issuance. Nothing in this file invents one, because a configuration decision written
 * as a constant is a configuration decision nobody made.
 */

/** What a preview shows in place of the issuer's real namespace. */
const PLACEHOLDER_IDS = {
  apple: { passTypeIdentifier: "pass.<not-configured>", teamIdentifier: "<not-configured>" },
  google: { objectId: "<issuer>.<not-configured>", classId: "<issuer>.<not-configured>" },
} as const;

/** Resolve everything a payload needs from one card, tenant-scoped. */
async function readCard(ctx: TenantContext, customerCardId: string) {
  const card = await prisma.customerCard.findFirst({
    // businessId in the WHERE: another tenant's card id resolves to no row at all.
    where: { id: customerCardId, businessId: ctx.businessId, status: { not: CardStatus.DELETED } },
    select: {
      id: true,
      qrToken: true,
      serialNumber: true,
      status: true,
      stampBalance: true,
      rewardBalance: true,
      expiresAt: true,
      business: { select: { name: true } },
      template: { select: { name: true, cardType: true } },
      profile: { select: { firstName: true } },
      programVersion: { select: { id: true, mechanics: true } },
    },
  });
  if (!card) throw new NotFoundError("Card not found");
  if (card.template.cardType !== CardType.STAMP) {
    /*
     * Honest refusal rather than a half-filled pass. A points card's balances mean something else,
     * and `readStampMechanics` throws for one — a payload built by ignoring that would put a
     * plausible wrong number in a customer's wallet, where they cannot see it corrected.
     */
    throw new ValidationError("Wallet passes are built for stamp cards only in this phase");
  }
  return card;
}

function toInput(
  card: Awaited<ReturnType<typeof readCard>>,
  locale: "en" | "ar",
  invitationUrl: string | null,
): WalletPassInput {
  const mechanics = readStampMechanics(card.programVersion.mechanics, { programVersionId: card.programVersion.id });
  return {
    businessName: card.business.name,
    programName: card.template.name,
    rewardName: mechanics.rewardName,
    qrToken: card.qrToken,
    serialNumber: card.serialNumber,
    stampBalance: card.stampBalance,
    stampsRequiredPerReward: mechanics.stampsRequiredPerReward,
    rewardBalance: card.rewardBalance,
    customerFirstName: card.profile.firstName,
    invitationUrl,
    locale,
    expiresAt: card.expiresAt,
  };
}

export interface WalletPassPayloads {
  apple: ApplePassJson;
  google: GoogleLoyaltyObject;
}

export interface IssuedWalletPass extends WalletPassPayloads {
  /** The capability's row id. The raw token is in the payloads and nowhere else. */
  shareLinkId: string;
}

export interface WalletIssuerIds {
  apple: { passTypeIdentifier: string; teamIdentifier: string };
  google: { objectId: string; classId: string };
}

/**
 * Mint a fresh invitation capability and build both payloads around it.
 *
 * Lazy: this is the only thing that creates a `CardShareLink`, and it creates one per issuance.
 * Nothing backfills and no bulk job walks the card table — a card that has never had a pass prepared
 * has no row at all.
 *
 * The returned payloads carry the live URL. Whatever calls this must sign and deliver them and must
 * not log them, store them, or show them to a member of staff.
 */
export async function issueWalletPassPayloads(
  ctx: TenantContext,
  customerCardId: string,
  opts: { locale: "en" | "ar"; ids: WalletIssuerIds },
): Promise<IssuedWalletPass> {
  requirePermission(ctx, Permission.EDIT_CUSTOMERS);
  const card = await readCard(ctx, customerCardId);

  const minted = await mintShareLink(ctx, card.id, "WALLET_PASS");
  const input = toInput(card, opts.locale, publicShareUrl(minted.rawToken));

  return {
    shareLinkId: minted.id,
    apple: buildApplePassJson(input, opts.ids.apple),
    google: buildGoogleLoyaltyObject(input, opts.ids.google),
  };
}

export interface WalletPassPreview extends WalletPassPayloads {
  link: ShareLinkStatus;
  /**
   * Always false in this build. Signing needs an Apple Pass Type ID certificate and a Google
   * service-account key, and no route delivers a pass — see `docs/evidence/phase-3a-prompt-1.md`.
   */
  signed: false;
}

/**
 * Show a member of staff what a pass would contain, with the capability removed.
 *
 * Mints nothing. Where a live link exists the invitation URL is rendered with a placeholder in
 * place of the token, so the screen can answer "does this pass carry the link, and where does it
 * sit" without answering "and what is it".
 */
export async function previewWalletPass(
  ctx: TenantContext,
  customerCardId: string,
  locale: "en" | "ar",
): Promise<WalletPassPreview> {
  requirePermission(ctx, Permission.VIEW_CUSTOMERS);
  const card = await readCard(ctx, customerCardId);
  const link = await getShareLinkStatus(ctx, card.id);

  // A shaped URL rather than the real one. `redactInvitationUrls` runs over the finished payloads
  // too, so even a field added later that happens to carry a URL is covered.
  const shown = link.live ? publicShareUrl(REDACTED_TOKEN) : null;
  const input = toInput(card, locale, shown);

  return {
    link,
    signed: false,
    apple: redactInvitationUrls(buildApplePassJson(input, PLACEHOLDER_IDS.apple)),
    google: redactInvitationUrls(buildGoogleLoyaltyObject(input, PLACEHOLDER_IDS.google)),
  };
}
