import { CardType } from "@prisma/client";
import { prisma } from "../db";
import { NotFoundError } from "../errors";
import { assertCounterSupportsCardType, assertNeverCardType } from "./card-type-support";
import type { MemberSource } from "../ledger/actor";
import { reversePointsOperation, type PointsOperationResult } from "../points/engine";
import { reverseStampOperation, type StampOperationResult } from "../stamp/engine";
import type { TenantContext } from "../tenant/context";

/**
 * Counter actions that are the same verb on both kinds of card.
 *
 * There is exactly one today — a reversal — and it needs this module for a specific reason: the
 * engines are deliberately separate, so *something* has to decide which one owns a given
 * transaction group, and that decision must not be made by the caller.
 *
 * A client that said "this is a points reversal" would be asserting a fact about a row it cannot
 * see. Worse, it would be asserting it about a group id, and a wrong assertion would reach the
 * wrong engine's mechanics reader and fail with an invariant error that blames the data. So the
 * card type is resolved here, from the group, inside the caller's tenant.
 */

/** Which engine owns this transaction group. Tenant-scoped: another business's group is not found. */
export async function cardTypeOfGroup(ctx: TenantContext, transactionGroupId: string): Promise<CardType> {
  if (typeof transactionGroupId !== "string" || transactionGroupId.trim() === "") {
    throw new NotFoundError("Transaction group not found");
  }
  const row = await prisma.loyaltyOperation.findFirst({
    where: { transactionGroupId, businessId: ctx.businessId },
    select: { template: { select: { cardType: true } } },
  });
  if (!row) throw new NotFoundError("Transaction group not found");
  return row.template.cardType;
}

/** Which engine owns this card. Tenant-scoped, same answer for foreign and nonexistent ids. */
export async function cardTypeOf(ctx: TenantContext, customerCardId: string): Promise<CardType> {
  const card = await prisma.customerCard.findFirst({
    where: { id: customerCardId, businessId: ctx.businessId },
    select: { template: { select: { cardType: true } } },
  });
  if (!card) throw new NotFoundError("Card not found");
  return card.template.cardType;
}

export interface ReverseCounterInput {
  transactionGroupId: string;
  reason: string;
  idempotencyKey: string;
  source: MemberSource;
}

export type ReverseCounterResult =
  | ({ cardType: typeof CardType.STAMP } & StampOperationResult)
  | ({ cardType: typeof CardType.POINTS } & PointsOperationResult);

/**
 * Undo a group, whichever kind of card it belongs to.
 *
 * Both engines delegate to the same Phase 0 reversal underneath: compensating rows, attributed to
 * the ORIGINAL group's location, refused if the group is itself a reversal, already reversed, or if
 * the value has since been spent. This function only picks the engine.
 */
export async function reverseCounterOperation(ctx: TenantContext, input: ReverseCounterInput): Promise<ReverseCounterResult> {
  const cardType = await cardTypeOfGroup(ctx, input.transactionGroupId);
  /*
   * Exhaustive, not `POINTS or else STAMP`.
   *
   * A money group cannot reach here today - `cardTypeOfGroup` resolves a `LoyaltyOperation`, and the
   * monetary engine writes `MonetaryOperation` rows and nothing else, so a money transaction group
   * id is simply not found. That makes this a LATENT trap rather than a live defect, and it is
   * exactly the trap that cost four other call sites: the day anything writes a `LoyaltyOperation`
   * for a money card, an `else` here would hand it to the STAMP engine.
   *
   * `assertNeverCardType` turns that into a compile error instead. Money reversals go through
   * `reverseMonetaryOperation`, which is linked, append-only and refuses a reversal of a reversal.
   */
  switch (cardType) {
    case CardType.POINTS:
      return { cardType: CardType.POINTS, ...(await reversePointsOperation(ctx, input)) };
    case CardType.STAMP:
      return { cardType: CardType.STAMP, ...(await reverseStampOperation(ctx, input)) };
    case CardType.CASHBACK:
    case CardType.DISCOUNT:
      assertCounterSupportsCardType(cardType);
      throw new Error("unreachable");
    default:
      return assertNeverCardType(cardType);
  }
}
