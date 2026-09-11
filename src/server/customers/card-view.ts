import { CardStatus } from "@prisma/client";
import { prisma } from "../db";
import { NotFoundError } from "../errors";
import { readStampMechanics } from "../program/mechanics";

/**
 * What the PUBLIC customer card page may show.
 *
 * The card page is opened by whoever holds its link — there is no session, and there must never be
 * a redirect to a merchant login (PRODUCT-SPEC §6.3). So the only thing that authorises the read is
 * the `shareToken` itself, and the shape of this view is the whole security boundary:
 *
 *  - it is keyed on `shareToken`, NOT on `qrToken`. Scanning a card at the counter must not hand
 *    anyone the URL that opens it, which is why the two secrets are drawn separately;
 *  - it returns **no identifiers**. No card id, customer id, business id, profile id, operation id
 *    or program version id. A page that echoed an internal id would let a holder pivot from their
 *    own card to guessing another;
 *  - it returns no staff, no configuration and no other customer;
 *  - the `qrToken` it does return is the one the holder is meant to show at the counter. It is
 *    theirs, it is already on their screen, and the scanner needs it.
 *
 * There is deliberately no way to act from here. Awards, redemptions and reversals are staff
 * actions behind a session; this view is read-only by construction.
 */
export interface PublicCardView {
  /** Shown on the card, and used as the PWA's name. */
  businessName: string;
  programName: string;
  rewardName: string;
  rewardDescription: string | null;
  /** The holder's own scanner token. Rendered as the QR the cashier reads. */
  qrToken: string;
  /** Human-readable, for a customer reading their serial to staff over the phone. */
  serialNumber: string;
  status: CardStatus;
  /** True when the card can still earn and redeem. */
  active: boolean;
  /**
   * True when the card is past its expiry date, or already marked EXPIRED. Decided here rather
   * than in the page: a view that hands a component a timestamp to compare against "now" makes
   * rendering depend on the clock, and two renders of the same data can then disagree.
   */
  expired: boolean;
  stampBalance: number;
  stampsRequiredPerReward: number;
  stampsToNextReward: number;
  /** Rewards earned and not yet collected. */
  rewardBalance: number;
  customerFirstName: string | null;
  expiresAt: Date | null;
  lastActivityAt: Date | null;
}

const TRANSACTABLE: ReadonlySet<CardStatus> = new Set<CardStatus>([CardStatus.ISSUED, CardStatus.ACTIVE]);

/**
 * Resolve a card from its opaque page token.
 *
 * A token that is unknown, malformed, or belongs to a deleted card produces the same
 * `NotFoundError`: the page must not distinguish "never existed" from "exists but not for you",
 * because that difference is exactly what makes enumeration worth attempting.
 */
export async function getPublicCardView(shareToken: string): Promise<PublicCardView> {
  if (typeof shareToken !== "string" || shareToken.length < 16) throw new NotFoundError("Card not found");

  const card = await prisma.customerCard.findFirst({
    where: { shareToken, status: { not: CardStatus.DELETED } },
    select: {
      qrToken: true,
      serialNumber: true,
      status: true,
      stampBalance: true,
      rewardBalance: true,
      expiresAt: true,
      lastActivityAt: true,
      business: { select: { name: true } },
      template: { select: { name: true } },
      profile: { select: { firstName: true } },
      programVersion: { select: { id: true, mechanics: true } },
    },
  });
  if (!card) throw new NotFoundError("Card not found");

  const mechanics = readStampMechanics(card.programVersion.mechanics, { programVersionId: card.programVersion.id });
  const expired = card.expiresAt !== null && card.expiresAt.getTime() <= Date.now();

  return {
    businessName: card.business.name,
    programName: card.template.name,
    rewardName: mechanics.rewardName,
    rewardDescription: mechanics.rewardDescription ?? null,
    qrToken: card.qrToken,
    serialNumber: card.serialNumber,
    status: card.status,
    active: TRANSACTABLE.has(card.status) && !expired,
    expired: expired || card.status === CardStatus.EXPIRED,
    stampBalance: card.stampBalance,
    stampsRequiredPerReward: mechanics.stampsRequiredPerReward,
    stampsToNextReward: mechanics.stampsRequiredPerReward - (card.stampBalance % mechanics.stampsRequiredPerReward),
    rewardBalance: card.rewardBalance,
    customerFirstName: card.profile.firstName,
    expiresAt: card.expiresAt,
    lastActivityAt: card.lastActivityAt,
  };
}

/**
 * The subset the per-card web manifest needs. Separate from the full view so the manifest route
 * cannot accidentally serialise the whole card into a file browsers cache aggressively.
 */
export interface CardManifestView {
  businessName: string;
  programName: string;
}

export async function getCardManifestView(shareToken: string): Promise<CardManifestView> {
  const view = await getPublicCardView(shareToken);
  return { businessName: view.businessName, programName: view.programName };
}
