import { randomUUID } from "node:crypto";
import { CardStatus, MonetaryOperationKind, MonetaryRuleKind, Permission } from "@prisma/client";
import { AuditAction, recordAudit } from "../audit/audit";
import type { Tx } from "../db";
import { ConflictCode, ConflictError, LedgerInvariantError, NotFoundError, ValidationError } from "../errors";
import { runIdempotent } from "../ledger/idempotency";
import type { MemberSource } from "../ledger/actor";
import { MEMBER_SOURCES } from "../ledger/actor";
import { resolveOperationLocationId } from "../program/available-locations";
import { assertIdempotencyKey, assertNoReversalLocation, assertTransactable } from "../program/card-actions";
import { getDefaultLocationId } from "../program/stamp-program";
import { businessDayRange } from "../time/business-day";
import { requirePermission, type TenantContext } from "../tenant/context";
import { MonetaryProgramKind, readMonetaryMechanics, type MonetaryMechanics } from "./mechanics";
import { cappedRedemption, formatMinorUnits, parseMinorAmount, percentageOfHalfUp } from "./money";
import { loadRuleForVersion, selectTier, type ResolvedRule, type ResolvedTier } from "./rules";

/**
 * The money engine: the only way a cashback balance changes, and the only thing that calculates a
 * discount.
 *
 * ## What this engine is, in one paragraph, so nobody has to infer it
 *
 * A member of staff types the PRE-DISCOUNT INVOICE TOTAL from the till. The server applies a rate
 * the merchant configured and the card is pinned to, and tells the staff member what to collect. The
 * result is an instruction to a person, recorded as a financial record. It is **not** a payment, not
 * a settlement, not a receipt, not a tax invoice, and not verified revenue: nothing here talks to a
 * till, a card scheme, a bank or a tax authority, and the invoice total is an assertion by whoever
 * typed it. `docs/PHASE-4-MONEY-MATRIX.md` §2 is the authority table this sentence comes from, and
 * §0 names the sentence this whole design exists to prevent somebody saying.
 *
 * ## The four operations
 *
 * | | What staff enter | What the server decides | Effect on the balance |
 * |---|---|---|---|
 * | `CASHBACK_EARNED` | the invoice total | the rate, the amount earned | **+** the earned amount |
 * | `CASHBACK_REDEEMED` | the invoice total and how much to take off | how much *can* come off | **−** the applied amount |
 * | `DISCOUNT_APPLIED` | the invoice total | the rate, the discount, the net | none — a discount is not cashback |
 * | `REVERSAL` | which row, and why | the exact inverse | the inverse of the reversed row |
 *
 * ## Why the balance is not a column
 *
 * `CustomerCard.cashBalanceMinor` exists and is an `int4`. This engine **does not use it**, and that
 * is a decision rather than an omission. Two reasons, in order of importance:
 *
 *  1. **`int4` is too narrow for money in SYP.** 2,147,483,647 minor units is about 21 million
 *     pounds — reachable by a real business's real customer. Widening a live column is a separate
 *     piece of work with its own migration and its own risk, and it is registered as **D33** rather
 *     than done quietly inside a feature.
 *  2. **A projection column can disagree with its history.** The balance here is the previous row's
 *     balance plus this row's effect, checked by trigger against the row before it. A forged balance
 *     cannot be inserted without contradicting its predecessor, and the unique `(card, sequence)`
 *     index makes that check safe under concurrency — a mutable column has neither property.
 *
 * So the balance is READ from the chain head and WRITTEN onto each row. There is no second copy to
 * drift.
 *
 * ## Two layers of concurrency control, and why both
 *
 *  - The card row is locked `FOR UPDATE` first, so two cashiers on the same card queue rather than
 *    race. This is what makes "there is enough balance to redeem" a decision that cannot be made
 *    twice against the same number.
 *  - The unique index on `("customerCardId", "cardSequence")` is the backstop for any writer that
 *    did not take that lock — a direct Prisma write, a future service, a bug. Two writers computing
 *    the same next sequence collide on the index; one commits and one is refused. The lock is the
 *    ergonomics; the index is the guarantee.
 */

/** Longest reason this engine will persist on a reversal. */
export const MAX_REASON_LENGTH = 500;

/**
 * What every money write returns.
 *
 * **Every amount is a decimal STRING, not a number.** Two reasons, and both are load-bearing:
 * a `bigint` cannot be `JSON.stringify`d at all, and this value is stored verbatim as the
 * idempotency record's response — so it must survive a round trip through JSON and come back
 * identical. A `number` would survive that trip only while the amount stays under 2^53, which is a
 * property of the merchant's prices rather than of the code.
 *
 * `currencyExponent` travels with them so a caller can render them without looking anything up, and
 * without assuming two decimal places.
 */
export type MonetaryOperationResult = {
  operationId: string;
  transactionGroupId: string;
  customerCardId: string;
  kind: MonetaryOperationKind;
  locationId: string;
  currency: string;
  currencyExponent: number;
  /** The pre-discount invoice total as entered by staff. A staff assertion, never a verified figure. */
  grossAmountMinor: string;
  /** What the staff member asked to redeem, before capping. Null except on a redemption. */
  requestedRedemptionMinor: string | null;
  /** What the staff member should collect. Calculated here; never entered. */
  netCounterAmountMinor: string;
  /** The discount taken off this invoice. Null except on a discount. */
  discountMinor: string | null;
  /** Signed change to the cashback balance: + earned, − redeemed, 0 on a discount. */
  cashEffectMinor: string;
  /** The cashback balance after this operation. */
  cashBalanceAfterMinor: string;
  /** The rate applied, in basis points. Null when the operation is not rate-driven. */
  rateBasisPoints: number | null;
  /** The tier the rate came from. Null when the operation is not rate-driven. */
  monetaryTierId: string | null;
  /** The row this one reverses. Null unless this is a reversal. */
  reversalOfId: string | null;
  /** The same amounts written out in major units, for a person to read. Never localised here. */
  display: { gross: string; net: string; cashEffect: string; balanceAfter: string; discount: string | null };
};

/** Fields every money counter action shares. */
export interface MonetaryActionInput {
  customerCardId: string;
  /** The PRE-DISCOUNT invoice total, in minor units, as typed at the counter. */
  grossAmountMinor: bigint | number | string;
  idempotencyKey: string;
  source: MemberSource;
  /** Required only when the program runs at more than one counter. */
  locationId?: string;
}

export interface RedeemCashbackInput extends MonetaryActionInput {
  /** How much of the balance the staff member wants to take off this bill, before capping. */
  requestedRedemptionMinor: bigint | number | string;
}

export interface ReverseMonetaryInput {
  monetaryOperationId: string;
  reason: string;
  idempotencyKey: string;
  source: MemberSource;
}

// ─── Loading ──────────────────────────────────────────────────────────────────

interface LockedMonetaryCard {
  id: string;
  status: CardStatus;
  expiresAt: Date | null;
  programVersionId: string;
  templateId: string;
  customerBusinessProfileId: string;
}

interface LoadedMonetaryCard {
  card: LockedMonetaryCard;
  mechanics: MonetaryMechanics;
  rule: ResolvedRule;
  timezone: string;
}

/**
 * Lock the card and load the rules it is pinned to.
 *
 * Taken FIRST and held for the rest of the transaction. Tenant-scoped: a card belonging to another
 * business is "not found", never "forbidden", because "forbidden" would confirm it exists.
 */
async function loadLockedMonetaryCard(
  tx: Tx,
  businessId: string,
  customerCardId: string,
  expected: MonetaryProgramKind,
  now: Date,
): Promise<LoadedMonetaryCard> {
  if (typeof customerCardId !== "string" || customerCardId.trim() === "") throw new NotFoundError("Card not found");

  const rows = await tx.$queryRaw<LockedMonetaryCard[]>`
    SELECT id, status, "expiresAt", "programVersionId", "templateId", "customerBusinessProfileId"
      FROM "CustomerCard"
     WHERE id = ${customerCardId} AND "businessId" = ${businessId}
     FOR UPDATE`;
  const card = rows[0];
  if (!card) throw new NotFoundError("Card not found");
  assertTransactable(card, now);

  const version = await tx.programVersion.findFirst({
    where: { id: card.programVersionId, template: { businessId } },
    select: { id: true, mechanics: true, template: { select: { business: { select: { timezone: true } } } } },
  });
  if (!version) throw new NotFoundError("Card program version not found");

  /*
   * Refuses the wrong engine before any arithmetic, twice over: the mechanics discriminator says
   * which program this is, and the rule's own `kind` says it again from a real column. They cannot
   * disagree through `createMonetaryProgram`, and if they ever did, the operation stops rather than
   * picking one.
   */
  const mechanics = readMonetaryMechanics(version.mechanics, expected, { programVersionId: version.id });
  const rule = await loadRuleForVersion(tx, card.programVersionId);
  const expectedRuleKind = expected === MonetaryProgramKind.CASHBACK ? MonetaryRuleKind.CASHBACK : MonetaryRuleKind.DISCOUNT;
  if (rule.kind !== expectedRuleKind) {
    throw new LedgerInvariantError(`Program version ${version.id} holds a ${rule.kind} rule, not ${expectedRuleKind}`);
  }

  return { card, mechanics, rule, timezone: version.template.business.timezone };
}

/**
 * Lock the card for a REVERSAL, and load the rule the row being reversed was written under.
 *
 * Two deliberate differences from the forward loader:
 *
 *  1. **It does not ask what kind of program this is.** A reversal's caller never says; the rule is
 *     read from the row being reversed, which is the only answer that cannot be wrong.
 *  2. **It does not call `assertTransactable`.** A correction to a financial record must be possible
 *     on a card that has since been paused or has expired - the existing ledger's
 *     `reverseOperationGroup` takes the same position, and for the same reason: refusing to fix a
 *     mistake because the customer's card lapsed afterwards leaves the mistake standing forever.
 */
async function loadLockedCardForReversal(
  tx: Tx,
  businessId: string,
  customerCardId: string,
  monetaryRuleId: string,
): Promise<{ card: LockedMonetaryCard; rule: ResolvedRule }> {
  const rows = await tx.$queryRaw<LockedMonetaryCard[]>`
    SELECT id, status, "expiresAt", "programVersionId", "templateId", "customerBusinessProfileId"
      FROM "CustomerCard"
     WHERE id = ${customerCardId} AND "businessId" = ${businessId}
     FOR UPDATE`;
  const card = rows[0];
  if (!card) throw new NotFoundError("Card not found");

  const rule = await loadRuleForVersion(tx, card.programVersionId);
  if (rule.id !== monetaryRuleId) {
    // The card has been re-pinned, or the row belongs to a different program. Either way the
    // arithmetic below would be written against a rule that did not produce the original.
    throw new LedgerInvariantError(`Operation was written under rule ${monetaryRuleId}, but its card is pinned to ${rule.id}`);
  }
  return { card, rule };
}

interface CardMoneyState {
  balanceMinor: bigint;
  sequence: bigint;
  cumulativeSpendMinor: bigint;
}

/**
 * The card's money position: the chain head, and the spend that decides which tier applies.
 *
 * ## What "cumulative qualified spend" counts, stated exactly
 *
 * The sum of `grossAmountMinor` over this card's operations that **still stand** — every kind of
 * money operation, excluding reversal rows themselves (which assert no invoice) and excluding any
 * row that has since been reversed. A withdrawn sale must not keep a customer in a higher band; that
 * is the whole reason a reversal is a linked row rather than a deletion.
 *
 * ## Which spend selects the tier: the history, NOT this invoice
 *
 * The tier is chosen from spend recorded BEFORE this operation. A customer who has spent 900,000 and
 * presents a 200,000 invoice earns at the rate for 900,000, and the 200,000 counts towards their
 * next visit.
 *
 * The alternative — including today's invoice — is equally arguable and produces different money, so
 * it is stated here rather than left to be discovered. Two reasons for this reading: it is the one a
 * cashier can explain ("you're on the gold rate because of what you've spent with us"), and it is
 * monotonic, so a customer's rate never depends on how a purchase happens to be split across
 * receipts. It is recorded as **D35** for the owner to confirm or overturn; overturning it changes
 * one line here and nothing else in the design.
 */
async function readCardMoneyState(tx: Tx, customerCardId: string): Promise<CardMoneyState> {
  const rows = await tx.$queryRaw<CardMoneyState[]>`
    SELECT
      COALESCE((SELECT o."cashBalanceAfterMinor" FROM "MonetaryOperation" o
                 WHERE o."customerCardId" = ${customerCardId}
                 ORDER BY o."cardSequence" DESC LIMIT 1), 0)::bigint AS "balanceMinor",
      COALESCE((SELECT o."cardSequence" FROM "MonetaryOperation" o
                 WHERE o."customerCardId" = ${customerCardId}
                 ORDER BY o."cardSequence" DESC LIMIT 1), 0)::bigint AS "sequence",
      COALESCE((SELECT SUM(o."grossAmountMinor") FROM "MonetaryOperation" o
                 WHERE o."customerCardId" = ${customerCardId}
                   AND o."kind" <> 'REVERSAL'
                   AND NOT EXISTS (SELECT 1 FROM "MonetaryOperation" r WHERE r."reversalOfId" = o."id")), 0)::bigint
        AS "cumulativeSpendMinor"`;
  return rows[0];
}

/**
 * Enforce the program's daily operation limit.
 *
 * Counts OPERATIONS in the BUSINESS's own day, not the server's — a Damascus café closing at 01:00
 * is still trading yesterday. Reversals are excluded: the limit exists to stop a card being run
 * repeatedly at a counter, and refusing a correction because the mistake it corrects used up the
 * day's allowance would be the wrong answer to the wrong question.
 */
async function assertDailyOperationLimit(
  tx: Tx,
  args: { customerCardId: string; timezone: string; limit: number | undefined; now: Date },
): Promise<void> {
  if (args.limit === undefined) return;
  const { start, end, localDate } = businessDayRange(args.now, args.timezone);
  const count = await tx.monetaryOperation.count({
    where: {
      customerCardId: args.customerCardId,
      kind: { not: MonetaryOperationKind.REVERSAL },
      createdAt: { gte: start, lt: end },
    },
  });
  if (count >= args.limit) {
    throw new ConflictError(
      `This card has reached its daily limit of ${args.limit} operation(s) for ${localDate}`,
      ConflictCode.DAILY_LIMIT_REACHED,
    );
  }
}

// ─── Writing ──────────────────────────────────────────────────────────────────

interface WriteArgs {
  tx: Tx;
  businessId: string;
  card: LockedMonetaryCard;
  rule: ResolvedRule;
  state: CardMoneyState;
  locationId: string;
  performedByUserId: string;
  kind: MonetaryOperationKind;
  grossAmountMinor: bigint;
  requestedRedemptionMinor: bigint | null;
  discountMinor: bigint | null;
  cashEffectMinor: bigint;
  netCounterAmountMinor: bigint;
  tier: ResolvedTier | null;
  reversalOfId: string | null;
  reason: string | null;
}

/**
 * Append one row, with its place in the chain computed rather than supplied.
 *
 * The sequence and the balance are derived here from the state read under the lock, and the database
 * recomputes both before it will accept the row. That duplication is the point: this service could
 * have a bug, and a financial record that depends on it being correct is not a financial record.
 */
async function appendOperation(args: WriteArgs): Promise<MonetaryOperationResult> {
  const transactionGroupId = randomUUID();
  const balanceAfter = args.state.balanceMinor + args.cashEffectMinor;

  const row = await args.tx.monetaryOperation.create({
    data: {
      transactionGroupId,
      businessId: args.businessId,
      locationId: args.locationId,
      customerBusinessProfileId: args.card.customerBusinessProfileId,
      customerCardId: args.card.id,
      templateId: args.card.templateId,
      programVersionId: args.card.programVersionId,
      monetaryRuleId: args.rule.id,
      monetaryTierId: args.tier?.id ?? null,
      kind: args.kind,
      currency: args.rule.currency,
      currencyExponent: args.rule.currencyExponent,
      grossAmountMinor: args.grossAmountMinor,
      requestedRedemptionMinor: args.requestedRedemptionMinor,
      cashEffectMinor: args.cashEffectMinor,
      discountMinor: args.discountMinor,
      netCounterAmountMinor: args.netCounterAmountMinor,
      rateBasisPoints: args.tier?.rateBasisPoints ?? null,
      cashBalanceAfterMinor: balanceAfter,
      cardSequence: args.state.sequence + 1n,
      reversalOfId: args.reversalOfId,
      reason: args.reason,
      performedByUserId: args.performedByUserId,
    },
    select: { id: true },
  });

  const exponent = args.rule.currencyExponent;
  return {
    operationId: row.id,
    transactionGroupId,
    customerCardId: args.card.id,
    kind: args.kind,
    locationId: args.locationId,
    currency: args.rule.currency,
    currencyExponent: exponent,
    grossAmountMinor: args.grossAmountMinor.toString(),
    requestedRedemptionMinor: args.requestedRedemptionMinor?.toString() ?? null,
    netCounterAmountMinor: args.netCounterAmountMinor.toString(),
    discountMinor: args.discountMinor?.toString() ?? null,
    cashEffectMinor: args.cashEffectMinor.toString(),
    cashBalanceAfterMinor: balanceAfter.toString(),
    rateBasisPoints: args.tier?.rateBasisPoints ?? null,
    monetaryTierId: args.tier?.id ?? null,
    reversalOfId: args.reversalOfId,
    display: {
      gross: formatMinorUnits(args.grossAmountMinor, exponent),
      net: formatMinorUnits(args.netCounterAmountMinor, exponent),
      cashEffect: formatMinorUnits(args.cashEffectMinor, exponent),
      balanceAfter: formatMinorUnits(balanceAfter, exponent),
      discount: args.discountMinor === null ? null : formatMinorUnits(args.discountMinor, exponent),
    },
  };
}

/** Shared entry checks: a member source, a usable idempotency key, a sane invoice. */
function assertCommonInput(input: MonetaryActionInput): bigint {
  if (!MEMBER_SOURCES.has(input.source)) {
    throw new ValidationError(`Source ${input.source} is not a counter source`);
  }
  assertIdempotencyKey(input.idempotencyKey);
  return parseMinorAmount(input.grossAmountMinor, "grossAmountMinor");
}

// ─── Cashback ─────────────────────────────────────────────────────────────────

/**
 * Earn cashback on an invoice.
 *
 * Requires `MAKE_ACCRUALS`, the same permission that awards a stamp or a point: this is the "give
 * the customer what they earned" action, and a cashier does it.
 *
 * Nothing about what the customer pays today changes — the trigger refuses a row where it does. The
 * customer pays the invoice and the balance goes up.
 */
export async function earnCashback(ctx: TenantContext, input: MonetaryActionInput): Promise<MonetaryOperationResult> {
  requirePermission(ctx, Permission.MAKE_ACCRUALS);
  const gross = assertCommonInput(input);
  const now = new Date();

  const outcome = await runIdempotent<MonetaryOperationResult>({
    businessId: ctx.businessId,
    key: input.idempotencyKey,
    payload: {
      op: "monetary.cashback.earn",
      businessId: ctx.businessId,
      customerCardId: input.customerCardId,
      grossAmountMinor: gross.toString(),
      locationId: input.locationId ?? null,
    },
    execute: async (tx) => {
      const { card, mechanics, rule, timezone } = await loadLockedMonetaryCard(
        tx,
        ctx.businessId,
        input.customerCardId,
        MonetaryProgramKind.CASHBACK,
        now,
      );
      await assertDailyOperationLimit(tx, { customerCardId: card.id, timezone, limit: mechanics.dailyOperationLimit, now });

      const locationId = await resolveOperationLocationId(tx, {
        ctx,
        mechanics,
        requestedLocationId: input.locationId,
        defaultLocationId: await getDefaultLocationId(tx, ctx.businessId),
      });

      const state = await readCardMoneyState(tx, card.id);
      const tier = selectTier(rule.tiers, state.cumulativeSpendMinor);
      const earned = percentageOfHalfUp(gross, tier.rateBasisPoints);

      const result = await appendOperation({
        tx,
        businessId: ctx.businessId,
        card,
        rule,
        state,
        locationId,
        performedByUserId: ctx.userId,
        kind: MonetaryOperationKind.CASHBACK_EARNED,
        grossAmountMinor: gross,
        requestedRedemptionMinor: null,
        discountMinor: null,
        cashEffectMinor: earned,
        // Earning does not change what is collected today. The trigger refuses anything else.
        netCounterAmountMinor: gross,
        tier,
        reversalOfId: null,
        reason: null,
      });
      return { result, transactionGroupId: result.transactionGroupId };
    },
  });
  return outcome.result;
}

/**
 * Spend cashback against an invoice.
 *
 * Requires `MAKE_REDEMPTIONS`. The amount that actually comes off is
 * `min(requested, balance, invoice)` — see `cappedRedemption` for why each of the three caps is
 * there, and in particular why the invoice cap is what keeps this from being a cash withdrawal.
 *
 * A request larger than the balance is CAPPED, not refused: "you have 4,000 left, take it off this
 * 3,000 bill" is an ordinary thing to say at a counter, and the row records both what was asked and
 * what was applied. A request against a card with NOTHING on it is refused, because there is no
 * sensible thing for a cashier to do with a zero and telling them so is the point.
 */
export async function redeemCashback(ctx: TenantContext, input: RedeemCashbackInput): Promise<MonetaryOperationResult> {
  requirePermission(ctx, Permission.MAKE_REDEMPTIONS);
  const gross = assertCommonInput(input);
  const requested = parseMinorAmount(input.requestedRedemptionMinor, "requestedRedemptionMinor");
  if (requested === 0n) throw new ValidationError("A redemption must be for more than zero");
  const now = new Date();

  const outcome = await runIdempotent<MonetaryOperationResult>({
    businessId: ctx.businessId,
    key: input.idempotencyKey,
    payload: {
      op: "monetary.cashback.redeem",
      businessId: ctx.businessId,
      customerCardId: input.customerCardId,
      grossAmountMinor: gross.toString(),
      requestedRedemptionMinor: requested.toString(),
      locationId: input.locationId ?? null,
    },
    execute: async (tx) => {
      const { card, mechanics, rule, timezone } = await loadLockedMonetaryCard(
        tx,
        ctx.businessId,
        input.customerCardId,
        MonetaryProgramKind.CASHBACK,
        now,
      );
      await assertDailyOperationLimit(tx, { customerCardId: card.id, timezone, limit: mechanics.dailyOperationLimit, now });

      const locationId = await resolveOperationLocationId(tx, {
        ctx,
        mechanics,
        requestedLocationId: input.locationId,
        defaultLocationId: await getDefaultLocationId(tx, ctx.businessId),
      });

      const state = await readCardMoneyState(tx, card.id);
      if (state.balanceMinor === 0n) {
        throw new ConflictError("This card has no cashback to spend", ConflictCode.NO_REWARD_AVAILABLE);
      }
      const applied = cappedRedemption({ requestedMinor: requested, balanceMinor: state.balanceMinor, grossMinor: gross });
      if (applied === 0n) {
        // Reachable only with a zero invoice, since the balance is non-zero and the request is not.
        throw new ConflictError("Nothing can be taken off an invoice of zero", ConflictCode.NO_REWARD_AVAILABLE);
      }

      const result = await appendOperation({
        tx,
        businessId: ctx.businessId,
        card,
        rule,
        state,
        locationId,
        performedByUserId: ctx.userId,
        kind: MonetaryOperationKind.CASHBACK_REDEEMED,
        grossAmountMinor: gross,
        requestedRedemptionMinor: requested,
        discountMinor: null,
        cashEffectMinor: -applied,
        netCounterAmountMinor: gross - applied,
        // A redemption is not rate-driven: no tier produced it, so none is claimed.
        tier: null,
        reversalOfId: null,
        reason: null,
      });
      return { result, transactionGroupId: result.transactionGroupId };
    },
  });
  return outcome.result;
}

// ─── Discount ─────────────────────────────────────────────────────────────────

/**
 * Calculate the discount on an invoice and record what the staff member was told to collect.
 *
 * Requires `MAKE_REDEMPTIONS`. A discount gives value away at the counter, so it sits with
 * redemption rather than with accrual — a cashier who may award points but not hand out rewards
 * should not be able to take money off a bill either.
 *
 * **The balance is not touched.** A discount is not cashback and the two are separate program types;
 * the trigger refuses a discount row with any cash effect at all. Nothing accumulates, and there is
 * nothing to spend later.
 */
export async function applyDiscount(ctx: TenantContext, input: MonetaryActionInput): Promise<MonetaryOperationResult> {
  requirePermission(ctx, Permission.MAKE_REDEMPTIONS);
  const gross = assertCommonInput(input);
  const now = new Date();

  const outcome = await runIdempotent<MonetaryOperationResult>({
    businessId: ctx.businessId,
    key: input.idempotencyKey,
    payload: {
      op: "monetary.discount.apply",
      businessId: ctx.businessId,
      customerCardId: input.customerCardId,
      grossAmountMinor: gross.toString(),
      locationId: input.locationId ?? null,
    },
    execute: async (tx) => {
      const { card, mechanics, rule, timezone } = await loadLockedMonetaryCard(
        tx,
        ctx.businessId,
        input.customerCardId,
        MonetaryProgramKind.DISCOUNT,
        now,
      );
      await assertDailyOperationLimit(tx, { customerCardId: card.id, timezone, limit: mechanics.dailyOperationLimit, now });

      const locationId = await resolveOperationLocationId(tx, {
        ctx,
        mechanics,
        requestedLocationId: input.locationId,
        defaultLocationId: await getDefaultLocationId(tx, ctx.businessId),
      });

      const state = await readCardMoneyState(tx, card.id);
      const tier = selectTier(rule.tiers, state.cumulativeSpendMinor);
      const discount = percentageOfHalfUp(gross, tier.rateBasisPoints);

      const result = await appendOperation({
        tx,
        businessId: ctx.businessId,
        card,
        rule,
        state,
        locationId,
        performedByUserId: ctx.userId,
        kind: MonetaryOperationKind.DISCOUNT_APPLIED,
        grossAmountMinor: gross,
        requestedRedemptionMinor: null,
        discountMinor: discount,
        // A discount never moves the cashback balance. The trigger refuses anything else.
        cashEffectMinor: 0n,
        netCounterAmountMinor: gross - discount,
        tier,
        reversalOfId: null,
        reason: null,
      });
      return { result, transactionGroupId: result.transactionGroupId };
    },
  });
  return outcome.result;
}

// ─── Reversal ─────────────────────────────────────────────────────────────────

/**
 * Undo one money operation with a linked, append-only reversal.
 *
 * Requires **both** `MAKE_ACCRUALS` and `MAKE_REDEMPTIONS`, matching the existing ledger rule: a
 * reversal both removes and restores value depending on what it undoes, and a member of staff who
 * may only do one half of that should not be able to do the other half by correcting it.
 *
 * Nothing is edited and nothing is deleted. The reversal:
 *
 *  - carries the exact inverse cash effect, recomputed by the trigger from the original row;
 *  - asserts no invoice of its own (`gross` and `net` are zero), so it cannot inflate spend;
 *  - excludes the original from cumulative qualified spend, so a withdrawn sale stops counting
 *    towards the customer's tier;
 *  - is attributed to the ORIGINAL row's location, never a location the caller names;
 *  - can happen exactly once, because `reversalOfId` carries a partial unique index;
 *  - cannot itself be reversed — undoing an undo is a new operation, not a second negation.
 *
 * **A reversal can be refused for lack of balance, and that is correct.** Reversing an EARNING when
 * the customer has already spent the money would drive the balance below zero; the non-negative
 * bound refuses it, and the honest answer is that the value is gone rather than a negative balance
 * the customer would have to pay off.
 */
export async function reverseMonetaryOperation(ctx: TenantContext, input: ReverseMonetaryInput): Promise<MonetaryOperationResult> {
  requirePermission(ctx, Permission.MAKE_ACCRUALS);
  requirePermission(ctx, Permission.MAKE_REDEMPTIONS);
  if (!MEMBER_SOURCES.has(input.source)) throw new ValidationError(`Source ${input.source} is not a counter source`);
  assertIdempotencyKey(input.idempotencyKey);
  assertNoReversalLocation(input);
  const reason = typeof input.reason === "string" ? input.reason.trim() : "";
  if (reason === "") throw new ValidationError("A reversal must record why");
  const boundedReason = reason.slice(0, MAX_REASON_LENGTH);

  const outcome = await runIdempotent<MonetaryOperationResult>({
    businessId: ctx.businessId,
    key: input.idempotencyKey,
    payload: {
      op: "monetary.reverse",
      businessId: ctx.businessId,
      monetaryOperationId: input.monetaryOperationId,
      reason: boundedReason,
    },
    execute: async (tx) => {
      // Tenant-scoped: another business's operation is indistinguishable from one that never existed.
      const original = await tx.monetaryOperation.findFirst({
        where: { id: input.monetaryOperationId, businessId: ctx.businessId },
        select: {
          id: true,
          kind: true,
          customerCardId: true,
          locationId: true,
          cashEffectMinor: true,
          monetaryRuleId: true,
          currency: true,
        },
      });
      if (!original) throw new NotFoundError("Operation not found");
      if (original.kind === MonetaryOperationKind.REVERSAL) {
        throw new ConflictError("A reversal cannot itself be reversed", ConflictCode.ALREADY_REVERSED);
      }

      /*
       * Lock the CARD before reading whether a reversal already exists. Without the lock this is a
       * check-then-act: two cashiers pressing undo at once would both find nothing and both write.
       * The partial unique index on `reversalOfId` would still refuse the second, but as a raw
       * constraint error rather than the sentence below.
       */
      const { card, rule } = await loadLockedCardForReversal(tx, ctx.businessId, original.customerCardId, original.monetaryRuleId);

      const already = await tx.monetaryOperation.count({ where: { reversalOfId: original.id } });
      if (already > 0) throw new ConflictError("This operation has already been reversed", ConflictCode.ALREADY_REVERSED);

      const state = await readCardMoneyState(tx, card.id);
      const effect = -original.cashEffectMinor;
      if (state.balanceMinor + effect < 0n) {
        throw new ConflictError(
          "This cashback has already been spent, so the award cannot be taken back",
          ConflictCode.ALREADY_REVERSED,
        );
      }

      const result = await appendOperation({
        tx,
        businessId: ctx.businessId,
        card,
        rule,
        state,
        // The original's counter, never one the caller named.
        locationId: original.locationId,
        performedByUserId: ctx.userId,
        kind: MonetaryOperationKind.REVERSAL,
        grossAmountMinor: 0n,
        requestedRedemptionMinor: null,
        discountMinor: null,
        cashEffectMinor: effect,
        netCounterAmountMinor: 0n,
        tier: null,
        reversalOfId: original.id,
        reason: boundedReason,
      });

      await recordAudit(tx, {
        businessId: ctx.businessId,
        actorUserId: ctx.userId,
        action: AuditAction.MONETARY_OPERATION_REVERSED,
        entityType: "MonetaryOperation",
        entityId: result.operationId,
        // Row ids and the signed effect. Never the customer, and never a name.
        metadata: {
          reversedOperationId: original.id,
          reversedKind: original.kind,
          cashEffectMinor: effect.toString(),
          currency: rule.currency,
        },
      });

      return { result, transactionGroupId: result.transactionGroupId };
    },
  });
  return outcome.result;
}
