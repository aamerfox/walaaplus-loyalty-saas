import { CardStatus } from "@prisma/client";
import type { Tx } from "../db";
import { ConflictCode, ConflictError, ValidationError } from "../errors";
import { AWARD_KINDS } from "../ledger/visits";
import { businessDayRange } from "../time/business-day";

/**
 * The rules a counter action obeys whatever kind of card is on the counter.
 *
 * Stamps and points are different programs with different arithmetic, and they are deliberately
 * two engines rather than one engine with a flag — a `if (cardType === POINTS)` threaded through
 * threshold conversion is how a stamp card ends up paying out a points reward. What they genuinely
 * share is everything that has nothing to do with the unit: what a transactable card is, what the
 * daily limit counts, what an idempotency key must look like, and what counts as money.
 *
 * Those live here so the two engines cannot drift apart on them. Anything that touches quantities
 * belongs in the engine that owns the unit.
 */

/** Card states that may still transact. ISSUED means enrolled but not yet opened. */
export const TRANSACTABLE: ReadonlySet<CardStatus> = new Set<CardStatus>([CardStatus.ISSUED, CardStatus.ACTIVE]);

/** Throw the conflict a card in the wrong state deserves, with the code the UI translates. */
export function assertTransactable(card: { status: CardStatus; expiresAt: Date | null }, now: Date): void {
  if (!TRANSACTABLE.has(card.status)) {
    throw new ConflictError(`Card is ${card.status.toLowerCase()} and cannot transact`, ConflictCode.CARD_NOT_TRANSACTABLE);
  }
  if (card.expiresAt !== null && card.expiresAt.getTime() <= now.getTime()) {
    // The scheduled expiry job is Phase 1.5; until it runs, the date on the card is what counts.
    throw new ConflictError("Card has expired and cannot transact", ConflictCode.CARD_NOT_TRANSACTABLE);
  }
}

/**
 * Award operations already written for this card during the business's local day.
 *
 * Counts OPERATIONS, not units: `dailyAwardLimit` exists to stop a cashier tapping the same
 * customer repeatedly, so a single award of five hundred points is one award (PRODUCT-SPEC §5.6).
 * The window is the business's own day, not the server's — a Damascus café closing at 01:00 is
 * still trading yesterday.
 */
export async function countAwardsInBusinessDay(
  tx: Tx,
  customerCardId: string,
  timezone: string,
  now: Date,
): Promise<{ count: number; localDate: string }> {
  const { start, end, localDate } = businessDayRange(now, timezone);
  const count = await tx.loyaltyOperation.count({
    where: {
      customerCardId,
      kind: { in: [...AWARD_KINDS] },
      createdAt: { gte: start, lt: end },
    },
  });
  return { count, localDate };
}

/** Enforce a program's daily award limit. Call it under the card lock or it proves nothing. */
export async function assertDailyAwardLimit(
  tx: Tx,
  args: { customerCardId: string; timezone: string; limit: number | undefined; now: Date },
): Promise<void> {
  if (args.limit === undefined) return;
  const { count, localDate } = await countAwardsInBusinessDay(tx, args.customerCardId, args.timezone, args.now);
  if (count >= args.limit) {
    throw new ConflictError(
      `This card has reached its daily limit of ${args.limit} award(s) for ${localDate}`,
      ConflictCode.DAILY_LIMIT_REACHED,
    );
  }
}

/** Money is integer minor units, always. A float here is a rounding bug waiting to be shipped. */
export function assertMinorUnits(value: number | undefined, field: string): void {
  if (value === undefined) return;
  if (!Number.isInteger(value) || value < 0) {
    throw new ValidationError(`${field} must be a non-negative integer of minor units`);
  }
}

/**
 * A reversal may not name a location, on any program, in any phase.
 *
 * Compensating rows are always written where the ORIGINAL group was written (see
 * `reverseOperationGroup`), so a supplied location could not move value even if it were read. It is
 * refused rather than ignored because a field that is accepted and discarded is a field a caller
 * believes in: the next person to send one would reasonably expect the correction to land where
 * they said, and nothing would tell them otherwise.
 */
export function assertNoReversalLocation(input: object): void {
  if ("locationId" in input) {
    throw new ValidationError(
      "A reversal is attributed to the location of the operation it corrects; locationId cannot be supplied",
    );
  }
}

/** Minimum length of a client-generated idempotency key. Short keys collide across customers. */
export const MIN_IDEMPOTENCY_KEY_LENGTH = 8;

export function assertIdempotencyKey(key: unknown): void {
  if (typeof key !== "string" || key.trim().length < MIN_IDEMPOTENCY_KEY_LENGTH) {
    throw new ValidationError(`An idempotency key of at least ${MIN_IDEMPOTENCY_KEY_LENGTH} characters is required`);
  }
}
