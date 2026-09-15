import { CardType } from "@prisma/client";
import { ValidationError } from "../errors";
import { isMonetaryMechanics, monetaryMechanicsSchema } from "../monetary/mechanics";
import { readAvailableLocations } from "./available-locations";
import { isStampMechanics, readStampMechanics } from "./mechanics";
import { isPointsMechanics, readPointsMechanics } from "./points-mechanics";

/**
 * The one place that knows how many kinds of card exist, and what each of them is handled by.
 *
 * ## Why this file exists
 *
 * Phase 4 added `CASHBACK` and `DISCOUNT` to a `CardType` enum that had held two values since Phase
 * 0. Adding them broke **seven** separate places, every one of them the same shape:
 *
 * ```ts
 * if (cardType === CardType.POINTS) { …points… }
 * return { …stamp… };                      // ← everything that is not POINTS is now STAMP
 * ```
 *
 * or its mechanics equivalent:
 *
 * ```ts
 * isPointsMechanics(m) ? … : isStampMechanics(m) ? … : undefined   // ← money falls off the end
 * ```
 *
 * Neither form fails when a new value is added. The first **silently routes** the new type into the
 * stamp engine; the second **silently drops** it, which in one case meant a money programme could
 * have its only counter closed without anything noticing it had been stranded. A compiler that had
 * been asked the question would have answered it — so this file asks the question.
 *
 * ## How it stops the next one
 *
 * `CARD_TYPE_SUPPORT` is a `Record<CardType, …>`. Adding a fifth value to the enum makes it fail to
 * compile until somebody states, in one line, what that card type is and which engine owns it.
 * `tests/unit/card-type-support.test.ts` asserts the same thing at runtime, so the guarantee does
 * not depend on anybody keeping `strict` on.
 *
 * Nothing here decides behaviour by itself. It is the shared vocabulary the dispatches use so that
 * "I forgot about cashback" becomes a build error instead of a customer's balance.
 */

/** Which engine owns a card type's value, and therefore which module may move it. */
export const CardEngine = {
  /** `src/server/stamp/engine.ts` */
  STAMP: "STAMP",
  /** `src/server/points/engine.ts` */
  POINTS: "POINTS",
  /** `src/server/monetary/engine.ts` — real money in currency minor units. */
  MONETARY: "MONETARY",
} as const;
export type CardEngine = (typeof CardEngine)[keyof typeof CardEngine];

export interface CardTypeSupport {
  /** The engine that owns this card type's balance. */
  readonly engine: CardEngine;
  /**
   * Whether the **stamp/points counter** — the scanner screen, its routes, card lookup and the
   * generic reversal path — can operate this card type.
   *
   * False for the money types, and not because the work is unfinished: their counter UI, routes and
   * customer views are Phase 4 Prompt 2. Until then every one of those paths must refuse a money
   * card **by name**, rather than route it into the stamp engine or fail with an error that blames
   * the data for not being stamp mechanics.
   */
  readonly counterUi: boolean;
  /** Whether the draft-version editor can edit this card type. Money rates are frozen to a version. */
  readonly draftEditor: boolean;
  /** Whether `src/server/wallet/` builds a pass for it. Stamp only, in every phase so far. */
  readonly walletPass: boolean;
}

/**
 * Exhaustive by construction: `Record<CardType, …>` will not compile with a value missing.
 *
 * Adding a card type here is a deliberate act with four answers attached, which is the point.
 */
export const CARD_TYPE_SUPPORT: Readonly<Record<CardType, CardTypeSupport>> = {
  [CardType.STAMP]: { engine: CardEngine.STAMP, counterUi: true, draftEditor: true, walletPass: true },
  [CardType.POINTS]: { engine: CardEngine.POINTS, counterUi: true, draftEditor: true, walletPass: false },
  [CardType.CASHBACK]: { engine: CardEngine.MONETARY, counterUi: false, draftEditor: false, walletPass: false },
  [CardType.DISCOUNT]: { engine: CardEngine.MONETARY, counterUi: false, draftEditor: false, walletPass: false },
};

/** Card types whose value the monetary engine owns. */
export function isMonetaryCardType(cardType: CardType): boolean {
  return CARD_TYPE_SUPPORT[cardType].engine === CardEngine.MONETARY;
}

/**
 * Refuse a card type the stamp/points counter cannot operate, by name and for the right reason.
 *
 * The sentence matters. Before this existed, a cashback card reaching `findCardByQrToken` was
 * refused — but with *"Program version … does not hold valid stamp mechanics"*, which reads as data
 * corruption and would have sent somebody looking for a broken row. The card is fine; this screen
 * simply does not serve it yet.
 */
export function assertCounterSupportsCardType(cardType: CardType): void {
  if (CARD_TYPE_SUPPORT[cardType].counterUi) return;
  throw new ValidationError(
    isMonetaryCardType(cardType)
      ? "This is a cashback or discount card. The counter screen for money programs is not built yet, so this card cannot be served here."
      : `The counter does not support ${cardType} cards`,
  );
}

/**
 * The locations a version runs at, read through **whichever contract owns it** — all of them.
 *
 * Replaces the `points ? … : stamp ? … : undefined` ladder that appeared in four places. That shape
 * is what let a money version fall off the end and be treated as "Main only", which in
 * `tenant/locations.ts` meant its counters could be closed without it being reported as stranded.
 *
 * Returns `null` for "Main only, the Phase 1a rule" **and** for a row that parses as no contract at
 * all. Those two are deliberately not distinguished here, because every caller wants the same safe
 * reading and the engines refuse a corrupt row loudly when value actually moves. Callers that need
 * to know the difference should read the contract directly.
 */
export function readVersionAvailableLocations(mechanics: unknown): readonly string[] | null {
  if (isPointsMechanics(mechanics)) return readAvailableLocations(readPointsMechanics(mechanics));
  if (isStampMechanics(mechanics)) return readAvailableLocations(readStampMechanics(mechanics));
  if (isMonetaryMechanics(mechanics)) {
    return readAvailableLocations(monetaryMechanicsSchema.parse(mechanics));
  }
  return null;
}

/**
 * Which contract owns this version's mechanics, or `null` when it parses as none of them.
 *
 * Exists because `readVersionAvailableLocations` deliberately collapses "Main only" and "corrupt"
 * into the same `null`, and one caller genuinely needs them apart: `assertCardWithinMemberScope`
 * hands a cashier a capability, and for that decision a row nobody can parse must FAIL CLOSED rather
 * than be read as the most permissive setting.
 *
 * That distinction was briefly lost while consolidating these ladders, which is the whole reason it
 * is now a named function with its own test rather than an inline condition.
 */
export function versionContractOf(mechanics: unknown): "STAMP" | "POINTS" | "CASHBACK" | "DISCOUNT" | null {
  if (isPointsMechanics(mechanics)) return "POINTS";
  if (isStampMechanics(mechanics)) return "STAMP";
  if (isMonetaryMechanics(mechanics)) return monetaryMechanicsSchema.parse(mechanics).kind;
  return null;
}

/**
 * Compile-time exhaustiveness: pass the value a `switch` should have handled.
 *
 * ```ts
 * switch (cardType) {
 *   case CardType.STAMP: …
 *   case CardType.POINTS: …
 *   default: assertNeverCardType(cardType);   // ← fails to compile when a value is added
 * }
 * ```
 *
 * It throws as well as failing to compile, because `strict` can be turned off and a `Prisma` enum
 * can hold a value a stale generated client has never heard of.
 */
export function assertNeverCardType(value: never): never {
  throw new ValidationError(`Unhandled card type: ${String(value)}`);
}
