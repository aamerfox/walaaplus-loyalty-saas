import { CardStatus, MonetaryOperationKind, Permission } from "@prisma/client";
import { prisma } from "../db";
import { NotFoundError } from "../errors";
import { readCardMoneyState } from "./engine";
import { isMoneyCardType } from "./draft";
import { formatMinorUnits } from "./money";
import { loadRuleForVersion, selectTier } from "./rules";
import { requirePermission, type TenantContext } from "../tenant/context";

/**
 * What the counter needs to know about a money card before anybody types a bill.
 *
 * Read-only, and deliberately separate from `customers/lookup.ts`. That module serves the stamp and
 * points counter and returns a shape built around stamps and points; a money card has a balance in
 * currency, a rate that depends on prior spend, and no notion of either. One function returning both
 * shapes would be a discriminated union that every caller has to narrow, for two screens that share
 * no controls.
 *
 * **The balance here is the chain, not a column.** It is the `cashBalanceAfterMinor` of the latest
 * operation on the card, which is the same value the engine recomputes under the card's lock before
 * it writes. This read is for showing a person; it is never the input to a write.
 *
 * There is a trap worth naming: `CustomerCard` carries an `Int` column literally called
 * `cashBalanceMinor`, marked *reserved: gift/cashback*, left over from the original schema. It is
 * NOT this balance, nothing maintains it, and it is an `Int` where money is `BigInt`. Reading it
 * would return zero for every card in the product and look entirely plausible while doing so.
 */

export interface MoneyCardOperation {
  id: string;
  kind: MonetaryOperationKind;
  at: Date;
  /** Minor units, as strings: `bigint` does not cross into a client component. */
  grossAmountMinor: string;
  netCounterAmountMinor: string;
  cashEffectMinor: string;
  cashBalanceAfterMinor: string;
  discountMinor: string | null;
  rateBasisPoints: number | null;
  reversalOfId: string | null;
  /** True when some LATER row reverses this one, so the screen can stop offering to reverse it. */
  reversed: boolean;
}

export interface MoneyCardView {
  customerCardId: string;
  cardStatus: CardStatus;
  customerName: string | null;
  templateId: string;
  templateName: string;
  cardType: "CASHBACK" | "DISCOUNT";
  programVersionId: string;
  /** The version this CARD is pinned to — not the template's live one. */
  versionNumber: number;
  currency: string;
  currencyExponent: number;
  cashBalanceMinor: string;
  /** Qualified spend so far, which is what decides the tier for the NEXT invoice (D35). */
  qualifiedSpendMinor: string;
  /** The rate that will apply to the next invoice, from the tier that prior spend has reached. */
  nextRateBasisPoints: number;
  display: { balance: string; qualifiedSpend: string };
  recent: MoneyCardOperation[];
}

const RECENT_LIMIT = 10;

/**
 * Load a money card for the counter.
 *
 * Refuses a card outside the caller's tenant exactly as if it did not exist — the same answer as a
 * wrong id, so a counter cannot be used to discover whether another business holds a given card.
 */
export async function readMoneyCard(ctx: TenantContext, customerCardId: string): Promise<MoneyCardView> {
  requirePermission(ctx, Permission.VIEW_CUSTOMERS);

  const card = await prisma.customerCard.findFirst({
    where: { id: customerCardId, businessId: ctx.businessId },
    select: {
      id: true,
      status: true,
      programVersionId: true,
      programVersion: {
        select: {
          versionNumber: true,
          template: { select: { id: true, name: true, cardType: true } },
        },
      },
      // The name is on the per-business PROFILE, not on the customer: the same person can be known
      // by different names to two businesses, and neither owns the other's record of them.
      profile: { select: { firstName: true, lastName: true } },
    },
  });
  if (!card) throw new NotFoundError("Card not found");

  const cardType = card.programVersion.template.cardType;
  if (!isMoneyCardType(cardType)) throw new NotFoundError("Card not found");

  const rule = await loadRuleForVersion(prisma, card.programVersionId);

  /*
   * The engine's OWN reader, not a second query that means roughly the same thing. The balance is
   * the latest row in the chain by `cardSequence`, and qualified spend excludes reversal rows and
   * anything since reversed - a definition worth stating once and calling twice.
   */
  const state = await readCardMoneyState(prisma, card.id);
  const balance = state.balanceMinor;
  const qualifiedSpend = state.cumulativeSpendMinor;
  const tier = selectTier(rule.tiers, qualifiedSpend);

  const recent = await prisma.monetaryOperation.findMany({
    where: { customerCardId: card.id },
    orderBy: { cardSequence: "desc" },
    take: RECENT_LIMIT,
    select: {
      id: true,
      kind: true,
      createdAt: true,
      grossAmountMinor: true,
      netCounterAmountMinor: true,
      cashEffectMinor: true,
      cashBalanceAfterMinor: true,
      discountMinor: true,
      rateBasisPoints: true,
      reversalOfId: true,
    },
  });

  // Which of these rows already has a reversal pointing at it. One query, not one per row.
  const reversedIds = new Set(
    (
      await prisma.monetaryOperation.findMany({
        where: { customerCardId: card.id, reversalOfId: { in: recent.map((r) => r.id) } },
        select: { reversalOfId: true },
      })
    ).flatMap((r) => (r.reversalOfId ? [r.reversalOfId] : [])),
  );

  const name = card.profile;

  return {
    customerCardId: card.id,
    cardStatus: card.status,
    customerName: name ? [name.firstName, name.lastName].filter(Boolean).join(" ") || null : null,
    templateId: card.programVersion.template.id,
    templateName: card.programVersion.template.name,
    cardType: cardType as MoneyCardView["cardType"],
    programVersionId: card.programVersionId,
    versionNumber: card.programVersion.versionNumber,
    currency: rule.currency,
    currencyExponent: rule.currencyExponent,
    cashBalanceMinor: balance.toString(),
    qualifiedSpendMinor: qualifiedSpend.toString(),
    nextRateBasisPoints: tier.rateBasisPoints,
    display: {
      balance: formatMinorUnits(balance, rule.currencyExponent),
      qualifiedSpend: formatMinorUnits(qualifiedSpend, rule.currencyExponent),
    },
    recent: recent.map((row) => ({
      id: row.id,
      kind: row.kind,
      at: row.createdAt,
      grossAmountMinor: row.grossAmountMinor.toString(),
      netCounterAmountMinor: row.netCounterAmountMinor.toString(),
      cashEffectMinor: row.cashEffectMinor.toString(),
      cashBalanceAfterMinor: row.cashBalanceAfterMinor.toString(),
      discountMinor: row.discountMinor?.toString() ?? null,
      rateBasisPoints: row.rateBasisPoints,
      reversalOfId: row.reversalOfId,
      reversed: reversedIds.has(row.id),
    })),
  };
}
