import { z } from "zod";
import { LedgerInvariantError, ValidationError } from "../errors";
import { availableLocationsSchema } from "../program/available-locations";

/**
 * The mechanics contract for a CASHBACK or DISCOUNT program version — and, more importantly, the
 * contract that says **money is not in here**.
 *
 * ## The rule this file enforces
 *
 * `ProgramVersion.mechanics` is a `Json` column. The stamp and points engines keep their rules in
 * it, and for stamps and points that is fine: a stamp threshold is a count, and a count read back
 * as the wrong type is obviously wrong. Money is not like that. A rate stored as JSON can be
 * `0.05`, `"5%"`, `5`, or `500`, all of which look plausible, and three of which pay the customer
 * the wrong amount. Worse, a JSON column has no foreign key, no `CHECK`, and no trigger — nothing
 * would stop a rate being edited after a card was sold under it.
 *
 * So the rates, the tiers and the currency live in `MonetaryRule` / `MonetaryTier`: real columns,
 * with real constraints, frozen by trigger, joined to the operation that used them. This JSON
 * carries only what has nothing to do with money — where the program runs, and how often a counter
 * may act on one card in a day.
 *
 * `assertNoMoneyInMechanics` below is the explicit form of that rule. `z.strictObject` would already
 * refuse an unknown key, but it would refuse it as "unrecognized key", and the person reading that
 * message is precisely the person who needs to be told *why* their rate was rejected and where it
 * belongs instead.
 *
 * ## Why there is no welcome bonus
 *
 * Stamp and points programs can hand out a welcome balance at enrolment. A cashback program cannot,
 * and it is not an oversight: a welcome cashback is the business giving away real money to anybody
 * who signs up, with no invoice behind it and no staff member at a counter. That is a payout
 * decision with fraud consequences, and it is not in Phase 4's scope. Cashback is earned against a
 * gross invoice a member of staff entered, and there is no other way for a balance to rise.
 */

/** Which of the two money programs a version is. Mirrors `MonetaryRuleKind` in the database. */
export const MonetaryProgramKind = {
  /** A percentage of the invoice becomes a money balance on the card, spendable on a later bill. */
  CASHBACK: "CASHBACK",
  /** A percentage off the invoice, now. Nothing is stored, nothing accumulates. */
  DISCOUNT: "DISCOUNT",
} as const;
export type MonetaryProgramKind = (typeof MonetaryProgramKind)[keyof typeof MonetaryProgramKind];

/** Current contract version. A pinned version keeps the number it was written with. */
export const MONETARY_MECHANICS_CONTRACT_VERSION = 1;

/** Generous for a real counter, still a refusal for a runaway loop. */
const MAX_DAILY_OPERATION_LIMIT = 1_000;

export const monetaryMechanicsSchema = z.strictObject({
  /**
   * Discriminator. `readMonetaryMechanics` takes the kind it expects, so a discount version handed
   * to the cashback path is refused before any arithmetic, exactly as a stamp version handed to the
   * points engine is.
   */
  kind: z.enum([MonetaryProgramKind.CASHBACK, MonetaryProgramKind.DISCOUNT]),
  contractVersion: z.literal(MONETARY_MECHANICS_CONTRACT_VERSION),

  /** Counters this version runs at. Absent means the business's Main location only. */
  availableLocations: availableLocationsSchema.optional(),

  /**
   * How many monetary operations one card may have in a business day. A COUNT, not an amount — the
   * same control the stamp and points engines call `dailyAwardLimit`, and it exists for the same
   * reason: to stop one card being run repeatedly at a counter, not to cap a sum of money.
   */
  dailyOperationLimit: z.number().int().min(1).max(MAX_DAILY_OPERATION_LIMIT).optional(),
});

export type MonetaryMechanics = z.infer<typeof monetaryMechanicsSchema>;
export type MonetaryMechanicsInput = z.input<typeof monetaryMechanicsSchema>;

/**
 * Keys that mean money, and are therefore refused here by name.
 *
 * Not an exhaustive list of every possible spelling — an exhaustive list is impossible, and
 * `strictObject` is what actually closes the door. This is the list of the ones somebody would
 * plausibly reach for, so that reaching for them produces an explanation rather than a rejection.
 */
const MONEY_KEYS = [
  "rate",
  "rateBasisPoints",
  "percent",
  "percentage",
  "cashbackPercent",
  "discountPercent",
  "amount",
  "amountMinor",
  "fixedAmountMinor",
  "maxDiscountMinor",
  "minSpendMinor",
  "currency",
  "currencyExponent",
  "tiers",
  "thresholds",
  "money",
] as const;

/**
 * Refuse a mechanics object that tries to carry money, and say where money goes instead.
 *
 * Called on the way IN (a merchant configuring a program) and never relaxed on the way out: a
 * version stored before this check existed cannot exist, because `MonetaryRule` and this contract
 * arrive in the same migration.
 */
export function assertNoMoneyInMechanics(input: unknown): void {
  if (!input || typeof input !== "object" || Array.isArray(input)) return;
  const found = MONEY_KEYS.filter((k) => k in (input as Record<string, unknown>));
  if (found.length > 0) {
    throw new ValidationError(
      `A money program's rates, amounts and currency are not part of its mechanics: remove ${found.join(", ")}. ` +
        "Rates are configured as tiers on the program's monetary rule, where the database can constrain them and " +
        "freeze them against the cards already issued.",
    );
  }
}

/** Validate mechanics supplied by a merchant. Use at the boundary where a program is configured. */
export function parseMonetaryMechanics(input: unknown): MonetaryMechanics {
  assertNoMoneyInMechanics(input);
  const parsed = monetaryMechanicsSchema.safeParse(input);
  if (!parsed.success) throw new ValidationError("Invalid money program mechanics", parsed.error.issues);
  return parsed.data;
}

/**
 * Read mechanics ALREADY STORED on a `ProgramVersion`, insisting on the kind the caller expects.
 *
 * A failure is not bad input: it is a corrupt row, or a card being run through the wrong engine.
 * That is an invariant violation (422) and it stops the operation — it must never fall back to a
 * default, because a defaulted rate pays out a number nobody configured.
 */
export function readMonetaryMechanics(
  mechanics: unknown,
  expected: MonetaryProgramKind,
  context: { programVersionId?: string } = {},
): MonetaryMechanics {
  const parsed = monetaryMechanicsSchema.safeParse(mechanics);
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map((i) => i.path.join(".") || "(root)"))].sort().join(", ");
    throw new LedgerInvariantError(
      `Program version ${context.programVersionId ?? "(unknown)"} does not hold valid money mechanics: ${fields}`,
    );
  }
  if (parsed.data.kind !== expected) {
    throw new LedgerInvariantError(
      `Program version ${context.programVersionId ?? "(unknown)"} is a ${parsed.data.kind} program, not ${expected}`,
    );
  }
  return parsed.data;
}

/** True when this version is a money program of either kind. Never throws. */
export function isMonetaryMechanics(mechanics: unknown): boolean {
  return monetaryMechanicsSchema.safeParse(mechanics).success;
}
