import { CardType, MembershipRole, OperationKind, Permission, UnitType, type CardStatus } from "@prisma/client";
import { prisma } from "../db";
import { ForbiddenError, NotFoundError } from "../errors";
import { readAvailableLocations } from "../program/available-locations";
import { isStampMechanics, readStampMechanics } from "../program/mechanics";
import { isPointsMechanics, readPointsMechanics } from "../program/points-mechanics";
import { requirePermission, type TenantContext } from "../tenant/context";
import { formatSyrianPhone } from "./phone";
import { readMoneyCard, type MoneyCardView } from "../monetary/counter";
import { isMonetaryCardType } from "../program/card-type-support";

/**
 * One customer, whole.
 *
 * Until now a merchant could open a CARD. That was fine while a business ran one program; with
 * several, a customer holding a stamp card and a points card appeared twice in the directory and
 * each page showed half of them. Worse, the card page read its balances through
 * `getCardBalances`, which parses **stamp** mechanics — so opening a points customer threw an
 * invariant error that the page turned into a 404. A merchant with a points program could not open
 * their own customers. That is fixed here by reading each card through the contract its own card
 * type owns.
 *
 * ## What this deliberately does not show
 *
 * - **no card token and no card URL.** `qrToken` and `shareToken` are capabilities: one opens the
 *   scanner path, the other opens the customer's card. Neither is selected by any query in this
 *   file. The only way to reveal a card link stays the explicit, audited, branch-scoped staff
 *   action in `counter-enrollment.ts`;
 *  - **no source token.** A source has a display name here and nothing else, which is the whole of
 *   what B7 allows a screen to know about it;
 *  - **no export.** Downloading a customer list needs its own retention, authorization and audit
 *   contract, and it is not in this prompt.
 *
 * ## Scope
 *
 * Every query is tenant-filtered in the `where`, never checked afterwards. Operations are narrowed
 * to the member's assigned branches exactly as `listCardOperations` narrows them, so a cashier
 * reading a customer sees what happened at their own branch and not what a colleague did at
 * another. Browsing the directory at all is refused for a cashier: `VIEW_CUSTOMERS` lets them serve
 * whoever is in front of them, not read the book.
 */

export interface CustomerCardView {
  customerCardId: string;
  serialNumber: string;
  status: CardStatus;
  templateId: string;
  programName: string;
  cardType: CardType;
  /** The version this card is PINNED to, which is the rule set it was sold under. */
  versionNumber: number;
  /** Live on the version this card is pinned to, never the program's current one. */
  stampBalance: number;
  rewardBalance: number;
  pointBalance: number;
  /** Stamp cards only: how many more stamps complete the next reward. */
  stampsToNextReward: number | null;
  stampsRequiredPerReward: number | null;
  /** Points cards only: what this balance can be spent on, cheapest first. */
  tiers: { name: string; requiredPoints: number; affordable: boolean }[];
  /** The branches this card's own version may be served at. Empty means the main branch only. */
  locationNames: string[];
  /** Display name of the source this card was attributed to. Never a token. */
  sourceName: string | null;
  issuedAt: Date;
  expiresAt: Date | null;
  lastActivityAt: Date | null;
  /** Money-card facts are present only for CASHBACK/DISCOUNT cards and are owner/manager scoped. */
  money: {
    currency: string;
    currencyExponent: number;
    balanceMinor: string;
    operations: MoneyCardView["recent"];
  } | null;
}

export interface CustomerProfileView {
  customerBusinessProfileId: string;
  firstName: string | null;
  lastName: string | null;
  /** Formatted for display, never for lookup. */
  phone: string;
  marketingConsent: boolean;
  firstSeenAt: Date;
  lastSeenAt: Date | null;
  cards: CustomerCardView[];
}

/**
 * Everything one customer has with this business.
 *
 * Four queries, none of them per card: the profile with its cards and their pinned versions, the
 * business's branches (to turn ids into names), and nothing else. A loop that fetched a version per
 * card would be an N+1 on the one screen a merchant opens most.
 */
export async function getCustomerProfile(ctx: TenantContext, profileId: string): Promise<CustomerProfileView> {
  requirePermission(ctx, Permission.VIEW_CUSTOMERS);
  if (ctx.role === MembershipRole.CASHIER) {
    throw new ForbiddenError("Cashiers may look up a customer by QR, phone or serial, not read the customer record");
  }

  const [profile, locations] = await Promise.all([
    prisma.customerBusinessProfile.findFirst({
      where: { id: profileId, businessId: ctx.businessId },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        marketingConsent: true,
        firstSeenAt: true,
        lastSeenAt: true,
        customer: { select: { normalizedPhone: true } },
        cards: {
          orderBy: { issuedAt: "asc" },
          select: {
            id: true,
            serialNumber: true,
            status: true,
            templateId: true,
            stampBalance: true,
            rewardBalance: true,
            pointBalance: true,
            issuedAt: true,
            expiresAt: true,
            lastActivityAt: true,
            // Deliberately absent: qrToken, shareToken. They are capabilities, not card facts.
            template: { select: { name: true, cardType: true } },
            utmSourceLink: { select: { name: true } },
            programVersion: {
              select: {
                versionNumber: true,
                mechanics: true,
                rewardTiers: {
                  select: { name: true, requiredPoints: true },
                  orderBy: [{ requiredPoints: "asc" }, { sortOrder: "asc" }],
                },
              },
            },
          },
        },
      },
    }),
    prisma.location.findMany({ where: { businessId: ctx.businessId }, select: { id: true, name: true } }),
  ]);
  // Tenant-filtered above, so another business's profile id is simply not found.
  if (!profile) throw new NotFoundError("Customer not found");

  const moneyCards = await Promise.all(
    profile.cards.filter((card) => isMonetaryCardType(card.template.cardType)).map(async (card) => [card.id, await readMoneyCard(ctx, card.id)] as const),
  );
  const moneyByCard = new Map(moneyCards);
  const names = new Map(locations.map((l) => [l.id, l.name]));

  return {
    customerBusinessProfileId: profile.id,
    firstName: profile.firstName,
    lastName: profile.lastName,
    phone: formatSyrianPhone(profile.customer.normalizedPhone),
    marketingConsent: profile.marketingConsent,
    firstSeenAt: profile.firstSeenAt,
    lastSeenAt: profile.lastSeenAt,
    cards: profile.cards.map((card) => {
      const mechanics = card.programVersion.mechanics;
      const isPoints = card.template.cardType === CardType.POINTS;
      /*
       * Read through the contract the card's own type owns. A row that parses as neither is
       * corrupt; the balances are still the ledger's projections and are shown, while the
       * version-derived figures are left null rather than guessed. A threshold invented on a
       * customer's record is worse than a blank one.
       */
      const stamp = !isPoints && isStampMechanics(mechanics) ? readStampMechanics(mechanics) : null;
      const points = isPoints && isPointsMechanics(mechanics) ? readPointsMechanics(mechanics) : null;
      const allowed = readAvailableLocations(stamp ?? points ?? {});

      return {
        customerCardId: card.id,
        serialNumber: card.serialNumber,
        status: card.status,
        templateId: card.templateId,
        programName: card.template.name,
        cardType: card.template.cardType,
        versionNumber: card.programVersion.versionNumber,
        stampBalance: card.stampBalance,
        rewardBalance: card.rewardBalance,
        pointBalance: card.pointBalance,
        stampsRequiredPerReward: stamp?.stampsRequiredPerReward ?? null,
        stampsToNextReward: stamp ? stamp.stampsRequiredPerReward - (card.stampBalance % stamp.stampsRequiredPerReward) : null,
        tiers: isPoints
          ? card.programVersion.rewardTiers.map((tier) => ({
              name: tier.name,
              requiredPoints: tier.requiredPoints,
              affordable: card.pointBalance >= tier.requiredPoints,
            }))
          : [],
        locationNames: (allowed ?? []).map((id) => names.get(id)).filter((name): name is string => name !== undefined),
        sourceName: card.utmSourceLink?.name ?? null,
        issuedAt: card.issuedAt,
        money: moneyByCard.has(card.id)
          ? (() => {
              const view = moneyByCard.get(card.id)!;
              return { currency: view.currency, currencyExponent: view.currencyExponent, balanceMinor: view.cashBalanceMinor, operations: view.recent };
            })()
          : null,
        expiresAt: card.expiresAt,
        lastActivityAt: card.lastActivityAt,
      };
    }),
  };
}

export interface ProfileActivityItem {
  id: string;
  transactionGroupId: string;
  kind: OperationKind;
  unitType: UnitType;
  quantity: number;
  balanceAfter: number;
  countsAsVisit: boolean;
  createdAt: Date;
  programName: string;
  locationName: string;
  /** Set when this row UNDOES another. A reversal is a row of its own, never an edit. */
  reversalOfOperationId: string | null;
  comment: string | null;
  reason: string | null;
}

const MAX_ACTIVITY = 100;
const DEFAULT_ACTIVITY = 25;

/**
 * One customer's whole history with this business, newest first, across every card they hold.
 *
 * Ordered by `(createdAt desc, id desc)` and paged on `id`, so the order is total even when two
 * rows share an instant — which they always do inside a transaction group. A page taken while a
 * cashier is serving the same customer cannot skip or repeat a row, because the cursor is a row id
 * and not an offset.
 *
 * Program and branch names are resolved from two small lookups after the page is read, not from a
 * join per row: a hundred rows would otherwise be a hundred extra reads on the screen a merchant
 * scrolls.
 */
export async function listProfileActivity(
  ctx: TenantContext,
  profileId: string,
  opts: { cursor?: string; limit?: number } = {},
): Promise<{ items: ProfileActivityItem[]; nextCursor: string | null }> {
  requirePermission(ctx, Permission.VIEW_OPERATIONS);

  const profile = await prisma.customerBusinessProfile.findFirst({
    where: { id: profileId, businessId: ctx.businessId },
    select: { id: true },
  });
  if (!profile) throw new NotFoundError("Customer not found");

  const take = Math.min(Math.max(Math.trunc(opts.limit ?? DEFAULT_ACTIVITY), 1), MAX_ACTIVITY);
  const rows = await prisma.loyaltyOperation.findMany({
    where: {
      customerBusinessProfileId: profileId,
      businessId: ctx.businessId,
      // The same branch narrowing the per-card history uses. A cashier reads their own branch.
      ...(ctx.locationIds === null ? {} : { locationId: { in: [...ctx.locationIds] } }),
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: take + 1,
    ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
    select: {
      id: true,
      transactionGroupId: true,
      kind: true,
      unitType: true,
      quantity: true,
      balanceAfter: true,
      countsAsVisit: true,
      createdAt: true,
      templateId: true,
      locationId: true,
      reversalOfOperationId: true,
      comment: true,
      reason: true,
    },
  });

  const page = rows.slice(0, take);
  const [templates, locations] = await Promise.all([
    prisma.programTemplate.findMany({
      where: { id: { in: [...new Set(page.map((r) => r.templateId))] }, businessId: ctx.businessId },
      select: { id: true, name: true },
    }),
    prisma.location.findMany({
      where: { id: { in: [...new Set(page.map((r) => r.locationId))] }, businessId: ctx.businessId },
      select: { id: true, name: true },
    }),
  ]);
  const programNames = new Map(templates.map((t) => [t.id, t.name]));
  const locationNames = new Map(locations.map((l) => [l.id, l.name]));

  return {
    items: page.map(({ templateId, locationId, ...row }) => ({
      ...row,
      programName: programNames.get(templateId) ?? "",
      locationName: locationNames.get(locationId) ?? "",
    })),
    nextCursor: rows.length > take ? page[page.length - 1].id : null,
  };
}
