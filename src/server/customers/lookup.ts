import { CardType, MembershipRole, OperationKind, Permission, Prisma, UnitType, type CardStatus } from "@prisma/client";
import { prisma } from "../db";
import { ForbiddenError, NotFoundError } from "../errors";
import { readStampMechanics } from "../program/mechanics";
import { readPointsMechanics } from "../program/points-mechanics";
import { requirePermission, type TenantContext } from "../tenant/context";
import { formatSyrianPhone, tryNormalizeSyrianPhone } from "./phone";

/**
 * Finding a customer, and reading what happened to their card.
 *
 * Every query in this file is filtered by `ctx.businessId`. Not "checked afterwards" — filtered,
 * so a card, token or phone number belonging to another business produces `NotFoundError`, the
 * same answer as a value that does not exist anywhere. That distinction matters: a scanner is a
 * public-facing device, and a merchant who can tell "not found" from "forbidden" can use a
 * competitor's QR code, or a list of phone numbers, to learn who their competitor's customers are.
 *
 * Phone lookup is a first-class path, not a fallback (PRODUCT-SPEC §7): a delivery business never
 * sees the customer's screen.
 */

/**
 * One card at the counter, in whichever program it belongs to.
 *
 * **This used to be stamp-shaped, and that was a defect Phase 1b Prompt 1 shipped.** `toSearchResult`
 * read the pinned mechanics through `readStampMechanics`, which throws for a points version - so the
 * moment a business ran a points program, a phone lookup for any customer holding one failed
 * outright, taking their stamp cards down with it because the lookup maps over every card the phone
 * matched. The engines were isolated; the read that feeds the scanner was not.
 *
 * It is now a discriminated union on `cardType`, read through whichever contract owns the version.
 * The shared fields are the ones a cashier identifies a person by; the rest belongs to the program.
 */
interface CardSearchBase {
  customerCardId: string;
  serialNumber: string;
  status: CardStatus;
  /** Formatted for display, e.g. `+963 944 123 456`. Never used for lookup. */
  phone: string;
  firstName: string | null;
  lastName: string | null;
  templateId: string;
  programName: string;
  /**
   * How this program earns, so the counter shows the buttons that exist.
   *
   * Offering "award for a visit" on a spend-block program is offering a request the engine refuses,
   * and the cashier finds out with a customer in front of them. It is program configuration, not
   * customer data: safe on a staff screen, and nowhere near a public one.
   */
  earnMode: "MANUAL" | "PER_VISIT" | "SPEND_BLOCK";
  expiresAt: Date | null;
  lastActivityAt: Date | null;
}

export interface StampCardSearchResult extends CardSearchBase {
  cardType: typeof CardType.STAMP;
  stampBalance: number;
  rewardBalance: number;
  stampsRequiredPerReward: number;
  stampsToNextReward: number;
}

export interface PointsCardSearchResult extends CardSearchBase {
  cardType: typeof CardType.POINTS;
  pointBalance: number;
  pointsLabel: string | null;
  /** Tiers on the card's PINNED version, cheapest first, with what this balance can afford. */
  tiers: { id: string; name: string; requiredPoints: number; affordable: boolean }[];
}

export type CardSearchResult = StampCardSearchResult | PointsCardSearchResult;

const CARD_SELECT = {
  id: true,
  serialNumber: true,
  status: true,
  stampBalance: true,
  pointBalance: true,
  rewardBalance: true,
  expiresAt: true,
  lastActivityAt: true,
  templateId: true,
  template: { select: { name: true, cardType: true } },
  profile: { select: { firstName: true, lastName: true, customer: { select: { normalizedPhone: true } } } },
  programVersion: {
    select: {
      id: true,
      mechanics: true,
      rewardTiers: {
        select: { id: true, name: true, requiredPoints: true },
        orderBy: [{ requiredPoints: "asc" }, { sortOrder: "asc" }],
      },
    },
  },
} satisfies Prisma.CustomerCardSelect;

type CardWithProfile = {
  id: string;
  serialNumber: string;
  status: CardStatus;
  stampBalance: number;
  pointBalance: number;
  rewardBalance: number;
  expiresAt: Date | null;
  lastActivityAt: Date | null;
  templateId: string;
  template: { name: string; cardType: CardType };
  profile: { firstName: string | null; lastName: string | null; customer: { normalizedPhone: string } };
  programVersion: { id: string; mechanics: unknown; rewardTiers: { id: string; name: string; requiredPoints: number }[] };
};

function toSearchResult(card: CardWithProfile): CardSearchResult {
  const base = {
    customerCardId: card.id,
    serialNumber: card.serialNumber,
    status: card.status,
    phone: formatSyrianPhone(card.profile.customer.normalizedPhone),
    firstName: card.profile.firstName,
    lastName: card.profile.lastName,
    templateId: card.templateId,
    programName: card.template.name,
    expiresAt: card.expiresAt,
    lastActivityAt: card.lastActivityAt,
  };

  /*
   * The template's `cardType` says which contract owns this version, and the contract is then read
   * strictly. A row whose two disagree is corrupt and throws here rather than being displayed as
   * whichever kind the reader guessed - the balance on a counter screen is not a place to guess.
   */
  if (card.template.cardType === CardType.POINTS) {
    const mechanics = readPointsMechanics(card.programVersion.mechanics, { programVersionId: card.programVersion.id });
    return {
      ...base,
      earnMode: mechanics.earnMode,
      cardType: CardType.POINTS,
      pointBalance: card.pointBalance,
      pointsLabel: mechanics.pointsLabel ?? null,
      tiers: card.programVersion.rewardTiers.map((t) => ({
        id: t.id,
        name: t.name,
        requiredPoints: t.requiredPoints,
        affordable: card.pointBalance >= t.requiredPoints,
      })),
    };
  }

  const mechanics = readStampMechanics(card.programVersion.mechanics, { programVersionId: card.programVersion.id });
  return {
    ...base,
    earnMode: mechanics.earnMode,
    cardType: CardType.STAMP,
    stampBalance: card.stampBalance,
    rewardBalance: card.rewardBalance,
    stampsRequiredPerReward: mechanics.stampsRequiredPerReward,
    stampsToNextReward: mechanics.stampsRequiredPerReward - (card.stampBalance % mechanics.stampsRequiredPerReward),
  };
}

/** True when this card is a stamp card. Narrows the union for callers that only handle one kind. */
export function isStampCard(card: CardSearchResult): card is StampCardSearchResult {
  return card.cardType === CardType.STAMP;
}

/** Scanner path 1: the customer shows their QR. */
export async function findCardByQrToken(ctx: TenantContext, qrToken: string): Promise<CardSearchResult> {
  requirePermission(ctx, Permission.VIEW_CUSTOMERS);
  if (typeof qrToken !== "string" || qrToken.length < 8) throw new NotFoundError("Card not found");

  const card = await prisma.customerCard.findFirst({
    where: { qrToken, businessId: ctx.businessId },
    select: CARD_SELECT,
  });
  if (!card) throw new NotFoundError("Card not found");
  return toSearchResult(card);
}

/** Scanner path 2: the customer gives their phone number. */
export async function findCardsByPhone(ctx: TenantContext, phone: string): Promise<CardSearchResult[]> {
  requirePermission(ctx, Permission.VIEW_CUSTOMERS);
  const normalized = tryNormalizeSyrianPhone(phone);
  // An unparseable search box is simply no match, not an error the cashier has to dismiss.
  if (!normalized) return [];

  const cards = await prisma.customerCard.findMany({
    where: { businessId: ctx.businessId, profile: { customer: { normalizedPhone: normalized } } },
    select: CARD_SELECT,
    orderBy: { createdAt: "asc" },
  });
  return cards.map(toSearchResult);
}

/** Scanner path 3: the serial printed on the card. */
export async function findCardBySerial(ctx: TenantContext, serialNumber: string): Promise<CardSearchResult> {
  requirePermission(ctx, Permission.VIEW_CUSTOMERS);
  const card = await prisma.customerCard.findFirst({
    where: { serialNumber: serialNumber.trim().toUpperCase(), businessId: ctx.businessId },
    select: CARD_SELECT,
  });
  if (!card) throw new NotFoundError("Card not found");
  return toSearchResult(card);
}

export interface CustomerListItem {
  customerBusinessProfileId: string;
  customerCardId: string | null;
  firstName: string | null;
  lastName: string | null;
  phone: string;
  stampBalance: number;
  rewardBalance: number;
  firstSeenAt: Date;
  lastSeenAt: Date | null;
}

export interface ListPage<T> {
  items: T[];
  /** Pass back as `cursor` for the next page. Null when the list is exhausted. */
  nextCursor: string | null;
}

const MAX_PAGE = 100;
const DEFAULT_PAGE = 25;

function pageSize(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_PAGE;
  return Math.min(Math.max(Math.trunc(limit), 1), MAX_PAGE);
}

/**
 * The business's customer directory.
 *
 * A cashier holds `VIEW_CUSTOMERS`, but that permission is scoped to "the scanned or searched
 * customer" (PRODUCT-SPEC §3): it lets them serve whoever is at the counter, not export the
 * business's customer list. Browsing the directory is therefore an owner or manager action, and a
 * cashier who calls this is refused even though the permission bit is set.
 */
export async function listCustomers(
  ctx: TenantContext,
  opts: { search?: string; cursor?: string; limit?: number } = {},
): Promise<ListPage<CustomerListItem>> {
  requirePermission(ctx, Permission.VIEW_CUSTOMERS);
  if (ctx.role === MembershipRole.CASHIER) {
    throw new ForbiddenError("Cashiers may look up a customer by QR, phone or serial, not browse the customer list");
  }

  const take = pageSize(opts.limit);
  const search = opts.search?.trim();
  const phone = search ? tryNormalizeSyrianPhone(search) : null;

  const profiles = await prisma.customerBusinessProfile.findMany({
    where: {
      businessId: ctx.businessId,
      ...(search
        ? {
            OR: [
              // A search box takes a name or a phone number; both are tried, and a phone is
              // matched only in its canonical form so partial digits cannot scan the table.
              { firstName: { contains: search, mode: "insensitive" as const } },
              { lastName: { contains: search, mode: "insensitive" as const } },
              ...(phone ? [{ customer: { normalizedPhone: phone } }] : []),
            ],
          }
        : {}),
    },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      firstSeenAt: true,
      lastSeenAt: true,
      customer: { select: { normalizedPhone: true } },
      cards: { select: { id: true, stampBalance: true, rewardBalance: true }, orderBy: { createdAt: "asc" }, take: 1 },
    },
    orderBy: { id: "asc" },
    take: take + 1,
    ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
  });

  const items = profiles.slice(0, take).map((p) => ({
    customerBusinessProfileId: p.id,
    customerCardId: p.cards[0]?.id ?? null,
    firstName: p.firstName,
    lastName: p.lastName,
    phone: formatSyrianPhone(p.customer.normalizedPhone),
    stampBalance: p.cards[0]?.stampBalance ?? 0,
    rewardBalance: p.cards[0]?.rewardBalance ?? 0,
    firstSeenAt: p.firstSeenAt,
    lastSeenAt: p.lastSeenAt,
  }));
  return { items, nextCursor: profiles.length > take ? items[items.length - 1].customerBusinessProfileId : null };
}

export interface OperationListItem {
  id: string;
  transactionGroupId: string;
  kind: OperationKind;
  unitType: UnitType;
  quantity: number;
  balanceAfter: number;
  countsAsVisit: boolean;
  purchaseAmountMinor: number | null;
  comment: string | null;
  reason: string | null;
  reversalOfOperationId: string | null;
  locationId: string;
  performedByUserId: string | null;
  createdAt: Date;
}

/**
 * One card's history, newest first.
 *
 * A cashier's view is narrowed to their assigned locations, which is what
 * "`VIEW_OPERATIONS` limited to assigned locations" means in practice: they can see what happened
 * at their own counter, not what a colleague did at another branch.
 */
export async function listCardOperations(
  ctx: TenantContext,
  customerCardId: string,
  opts: { cursor?: string; limit?: number } = {},
): Promise<ListPage<OperationListItem>> {
  requirePermission(ctx, Permission.VIEW_OPERATIONS);

  // Tenant-scoped existence check first, so a foreign card id is "not found" rather than an
  // empty list, which would otherwise confirm the id exists somewhere.
  const card = await prisma.customerCard.findFirst({
    where: { id: customerCardId, businessId: ctx.businessId },
    select: { id: true },
  });
  if (!card) throw new NotFoundError("Card not found");

  const take = pageSize(opts.limit);
  const rows = await prisma.loyaltyOperation.findMany({
    where: {
      customerCardId,
      businessId: ctx.businessId,
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
      purchaseAmountMinor: true,
      comment: true,
      reason: true,
      reversalOfOperationId: true,
      locationId: true,
      performedByUserId: true,
      createdAt: true,
    },
  });

  const items = rows.slice(0, take);
  return { items, nextCursor: rows.length > take ? items[items.length - 1].id : null };
}
