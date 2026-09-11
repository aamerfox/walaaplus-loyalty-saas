import { CardStatus, OperationKind, OperationSource, UnitType } from "@prisma/client";
import { prisma, type Tx } from "../db";
import { ConflictCode, ConflictError, NotFoundError, ValidationError } from "../errors";
import { runIdempotent } from "../ledger/idempotency";
import { appendOperationGroup, reverseOperationGroup } from "../ledger/ledger";
import type { MemberActor, MemberSource } from "../ledger/actor";
import type { OperationInput } from "../ledger/types";
import { AWARD_KINDS } from "../ledger/visits";
import { getDefaultLocationId } from "../program/stamp-program";
import { planStampConversion, readStampMechanics, stampsForPurchase, StampEarnMode, type StampMechanics } from "../program/mechanics";
import { businessDayRange } from "../time/business-day";
import type { TenantContext } from "../tenant/context";

/**
 * The stamp engine: the only way a café's loyalty value changes.
 *
 * Routes never build ledger rows. They call one of the five verbs here — award manually, award for
 * a visit, award for a purchase, redeem a reward, reverse a mistake — and each one:
 *
 *  1. runs under `runIdempotent`, because every one of them is triggered by a person tapping a
 *     phone at a counter on a bad network, and the tap will be repeated;
 *  2. locks the card row before reading balances or counting today's awards, so two cashiers
 *     serving the same customer cannot both pass a limit check that only one should pass;
 *  3. reads the rules from the version PINNED TO THE CARD, never the program's current version;
 *  4. writes one atomic group through `appendOperationGroup`, which derives the business and the
 *     acting user from the verified actor and refuses a caller-supplied transaction group id.
 *
 * What the engine deliberately does not do: touch a balance column directly, update a ledger row,
 * or offer an "edit transaction". A mistake is corrected by a compensating group (§5 reverse).
 */

/** What every write returns. A type alias, not an interface, so it satisfies Prisma's JSON input. */
export type StampOperationResult = {
  transactionGroupId: string;
  customerCardId: string;
  /** Stamps on the card after this operation. */
  stampBalance: number;
  /** Unredeemed rewards after this operation. */
  rewardBalance: number;
  /** Stamps granted by this operation; negative on a reversal. */
  stampsAwarded: number;
  /** Rewards completed by this operation. */
  rewardsEarned: number;
  /** Stamps still needed for the next reward. */
  stampsToNextReward: number;
  operations: { id: string; kind: OperationKind; unitType: UnitType; quantity: number; balanceAfter: number }[];
};

/**
 * Phase 1a runs ONE café at ONE counter.
 *
 * The location is therefore not an input. Every award, redemption and reversal attributes to the
 * business's default `Main` location, resolved inside the transaction from the business itself.
 * A caller — a screen, a route handler, a script — cannot choose it, and supplying it anyway is
 * REFUSED before anything is validated or written, rather than quietly honoured.
 *
 * This is a scope boundary, not a security boundary. `requireLocationAccess` already stops a
 * cashier acting outside their assignment, but an OWNER is unrestricted across their own
 * locations, so nothing else would stop a second counter appearing in the ledger and Phase 1b's
 * multi-location work starting by accident. Phase 1b adds the parameter back deliberately, with
 * the program's `availableLocations` and a location picker behind it.
 */
function assertNoCallerLocation(input: object): void {
  if ("locationId" in input) {
    throw new ValidationError(
      "Phase 1a operates only at the business's Main location; locationId is resolved by the server and cannot be supplied",
    );
  }
}

/** Fields every counter action shares. */
export interface StampActionInput {
  customerCardId: string;
  /**
   * Client-generated, stable across retries of the SAME intent. Two different taps must use two
   * different keys; one tap retried three times must use one key.
   */
  idempotencyKey: string;
  /** SCANNER for a counter scan, DASHBOARD for a merchant acting from the back office. */
  source: MemberSource;
  /** Internal note. Stored on the operation and never shown to the customer. */
  comment?: string;
}

export interface ManualAwardInput extends StampActionInput {
  /** Stamps to grant. Positive; the ledger refuses zero. */
  quantity: number;
  /** Required when the program sets `requirePurchaseAmount`. */
  purchaseAmountMinor?: number;
}

export interface VisitAwardInput extends StampActionInput {
  purchaseAmountMinor?: number;
}

export interface PurchaseAwardInput extends StampActionInput {
  /** Integer minor units of the business currency. Whole blocks earn; the remainder is discarded. */
  purchaseAmountMinor: number;
}

export type RedeemRewardInput = StampActionInput;

export interface ReverseGroupActionInput {
  transactionGroupId: string;
  reason: string;
  idempotencyKey: string;
  source: MemberSource;
}

/** One visit award grants one stamp. Phase 1a has no per-visit multiplier. */
export const STAMPS_PER_VISIT = 1;

interface LockedCardRow {
  id: string;
  status: CardStatus;
  expiresAt: Date | null;
  programVersionId: string;
  stampBalance: number;
  rewardBalance: number;
}

interface LoadedCard {
  card: LockedCardRow;
  mechanics: StampMechanics;
  rewardTierId: string;
  timezone: string;
}

/** Card states that may still transact. ISSUED means enrolled but not yet opened. */
const TRANSACTABLE: ReadonlySet<CardStatus> = new Set<CardStatus>([CardStatus.ISSUED, CardStatus.ACTIVE]);

/**
 * Lock the card and load the rules pinned to it.
 *
 * The lock is taken FIRST and held for the rest of the transaction. Everything after it — the
 * balance, today's award count, the threshold arithmetic — is read under that lock, so a
 * concurrent award on the same card waits rather than racing. `appendOperationGroup` takes the
 * same lock again later, which is a no-op for the holder.
 */
async function loadLockedStampCard(tx: Tx, businessId: string, customerCardId: string, now: Date): Promise<LoadedCard> {
  const rows = await tx.$queryRaw<LockedCardRow[]>`
    SELECT id, status, "expiresAt", "programVersionId", "stampBalance", "rewardBalance"
      FROM "CustomerCard"
     WHERE id = ${customerCardId} AND "businessId" = ${businessId}
     FOR UPDATE`;
  const card = rows[0];
  // Tenant-scoped: a card id belonging to another business is indistinguishable from one that
  // does not exist. Never "forbidden", which would confirm it exists.
  if (!card) throw new NotFoundError("Card not found");

  if (!TRANSACTABLE.has(card.status)) {
    throw new ConflictError(`Card is ${card.status.toLowerCase()} and cannot transact`, ConflictCode.CARD_NOT_TRANSACTABLE);
  }
  if (card.expiresAt !== null && card.expiresAt.getTime() <= now.getTime()) {
    // The scheduled expiry job is Phase 1.5; until it runs, the date on the card is what counts.
    throw new ConflictError("Card has expired and cannot transact", ConflictCode.CARD_NOT_TRANSACTABLE);
  }

  const version = await tx.programVersion.findFirst({
    where: { id: card.programVersionId, template: { businessId } },
    select: {
      id: true,
      mechanics: true,
      rewardTiers: { select: { id: true }, orderBy: { sortOrder: "asc" }, take: 1 },
      template: { select: { business: { select: { timezone: true } } } },
    },
  });
  if (!version) throw new NotFoundError("Card program version not found");

  const mechanics = readStampMechanics(version.mechanics, { programVersionId: version.id });
  const rewardTierId = version.rewardTiers[0]?.id;
  if (!rewardTierId) throw new ConflictError("This program version has no reward to award or redeem");

  return { card, mechanics, rewardTierId, timezone: version.template.business.timezone };
}

/**
 * Award operations already written for this card during the business's local day.
 *
 * Counts OPERATIONS, not stamps: `dailyAwardLimit` exists to stop a cashier tapping the same
 * customer repeatedly, so a single award of five stamps is one award (PRODUCT-SPEC §5.6). The
 * window is the business's own day, not the server's — a Damascus café closing at 01:00 is still
 * trading yesterday. Exported for the timezone tests.
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

/** Money is integer minor units, always. A float here is a rounding bug waiting to be shipped. */
function assertMinorUnits(value: number | undefined, field: string): void {
  if (value === undefined) return;
  if (!Number.isInteger(value) || value < 0) {
    throw new ValidationError(`${field} must be a non-negative integer of minor units`);
  }
}

/** Programs may demand the purchase amount on every award, not only on purchase awards. */
function assertPurchaseAmount(mechanics: StampMechanics, purchaseAmountMinor: number | undefined): void {
  assertMinorUnits(purchaseAmountMinor, "purchaseAmountMinor");
  if (purchaseAmountMinor === undefined && mechanics.requirePurchaseAmount) {
    throw new ValidationError("This program requires the purchase amount for every award");
  }
}

/**
 * Build the rows one award becomes, and write them as ONE group.
 *
 * A threshold crossing is not a second transaction: the award, the stamps it consumes and the
 * reward it completes commit together or not at all (PRODUCT-SPEC §5.3). The remainder stays on
 * the card, and a large enough award completes several rewards at once.
 */
async function writeAward(
  tx: Tx,
  loaded: LoadedCard,
  actor: MemberActor,
  locationId: string,
  kind: OperationKind,
  stamps: number,
  extras: { purchaseAmountMinor?: number; comment?: string },
): Promise<StampOperationResult> {
  const { mechanics, rewardTierId } = loaded;
  const plan = planStampConversion(mechanics, loaded.card.stampBalance, stamps);

  const operations: OperationInput[] = [
    {
      kind,
      unitType: UnitType.STAMP,
      quantity: stamps,
      purchaseAmountMinor: extras.purchaseAmountMinor ?? null,
      comment: extras.comment ?? null,
    },
  ];
  if (plan.rewardsEarned > 0) {
    operations.push(
      // One conversion row for every stamp consumed, and one reward row for every reward
      // completed. Two rows rather than 2n rows: the quantities carry the multiplicity, and
      // reconciliation sums quantities.
      { kind: OperationKind.STAMP_CONVERTED, unitType: UnitType.STAMP, quantity: -plan.stampsConverted, rewardTierId },
      { kind: OperationKind.REWARD_EARNED, unitType: UnitType.REWARD, quantity: plan.rewardsEarned, rewardTierId },
    );
  }

  const appended = await appendOperationGroup({ actor, customerCardId: loaded.card.id, locationId, operations }, tx);

  const stampBalance = appended.balances[UnitType.STAMP];
  const rewardBalance = appended.balances[UnitType.REWARD];
  return {
    transactionGroupId: appended.transactionGroupId,
    customerCardId: appended.customerCardId,
    stampBalance,
    rewardBalance,
    stampsAwarded: stamps,
    rewardsEarned: plan.rewardsEarned,
    stampsToNextReward: mechanics.stampsRequiredPerReward - (stampBalance % mechanics.stampsRequiredPerReward),
    operations: appended.operations.map((o) => ({
      id: o.id,
      kind: o.kind,
      unitType: o.unitType,
      quantity: o.quantity,
      balanceAfter: o.balanceAfter,
    })),
  };
}

/** Shared preamble: resolve the location, open the idempotent transaction, lock the card. */
async function runCardAction(
  ctx: TenantContext,
  input: StampActionInput,
  payload: Record<string, unknown>,
  action: (tx: Tx, loaded: LoadedCard, actor: MemberActor, locationId: string, now: Date) => Promise<StampOperationResult>,
): Promise<StampOperationResult> {
  assertNoCallerLocation(input);
  if (typeof input.idempotencyKey !== "string" || input.idempotencyKey.trim().length < 8) {
    throw new ValidationError("An idempotency key of at least 8 characters is required");
  }
  const actor: MemberActor = { kind: "member", ctx, source: input.source };

  const outcome = await runIdempotent<StampOperationResult>({
    businessId: ctx.businessId,
    key: input.idempotencyKey,
    // The payload is what makes a retry safe: the same key with different intent is a client bug
    // and is refused, rather than silently replaying the wrong answer.
    payload: { ...payload, customerCardId: input.customerCardId, source: input.source },
    execute: async (tx) => {
      const now = new Date();
      // Always Main. Not a default the caller can override — the only location Phase 1a has.
      const locationId = await getDefaultLocationId(tx, ctx.businessId);
      const loaded = await loadLockedStampCard(tx, ctx.businessId, input.customerCardId, now);
      const result = await action(tx, loaded, actor, locationId, now);
      return { result, transactionGroupId: result.transactionGroupId };
    },
  });
  return outcome.result;
}

/** Enforce the program's daily award limit, under the card lock. */
async function assertDailyLimit(tx: Tx, loaded: LoadedCard, now: Date): Promise<void> {
  const limit = loaded.mechanics.dailyAwardLimit;
  if (limit === undefined) return;
  const { count, localDate } = await countAwardsInBusinessDay(tx, loaded.card.id, loaded.timezone, now);
  if (count >= limit) {
    throw new ConflictError(
      `This card has reached its daily limit of ${limit} award(s) for ${localDate}`,
      ConflictCode.DAILY_LIMIT_REACHED,
    );
  }
}

/**
 * Staff grant stamps at their discretion.
 *
 * Allowed whatever the program's earn mode: a café always needs "the tablet was down, give them
 * their stamp". The earn mode governs the automatic paths, not the manual override.
 */
export async function awardManualStamps(ctx: TenantContext, input: ManualAwardInput): Promise<StampOperationResult> {
  if (!Number.isInteger(input.quantity) || input.quantity < 1) {
    throw new ValidationError("Manual award quantity must be a positive integer");
  }
  assertMinorUnits(input.purchaseAmountMinor, "purchaseAmountMinor");

  return runCardAction(
    ctx,
    input,
    { op: "manual", quantity: input.quantity, purchaseAmountMinor: input.purchaseAmountMinor ?? null, comment: input.comment ?? null },
    async (tx, loaded, actor, locationId, now) => {
      assertPurchaseAmount(loaded.mechanics, input.purchaseAmountMinor);
      await assertDailyLimit(tx, loaded, now);
      return writeAward(tx, loaded, actor, locationId, OperationKind.MANUAL_AWARD, input.quantity, {
        purchaseAmountMinor: input.purchaseAmountMinor,
        comment: input.comment,
      });
    },
  );
}

/** One visit, one stamp. Requires a PER_VISIT program. */
export async function awardVisitStamp(ctx: TenantContext, input: VisitAwardInput): Promise<StampOperationResult> {
  return runCardAction(
    ctx,
    input,
    { op: "visit", purchaseAmountMinor: input.purchaseAmountMinor ?? null, comment: input.comment ?? null },
    async (tx, loaded, actor, locationId, now) => {
      if (loaded.mechanics.earnMode !== StampEarnMode.PER_VISIT) {
        throw new ValidationError(`Visit awards need a PER_VISIT program; this one earns by ${loaded.mechanics.earnMode}`);
      }
      assertPurchaseAmount(loaded.mechanics, input.purchaseAmountMinor);
      await assertDailyLimit(tx, loaded, now);
      return writeAward(tx, loaded, actor, locationId, OperationKind.VISIT_AWARD, STAMPS_PER_VISIT, {
        purchaseAmountMinor: input.purchaseAmountMinor,
        comment: input.comment,
      });
    },
  );
}

/**
 * Whole blocks of spend earn stamps; the remainder is discarded, not carried (PRODUCT-SPEC §5.5).
 * A purchase too small to fill one block earns nothing and is refused rather than written as a
 * zero-quantity row, which the ledger would reject anyway.
 */
export async function awardPurchaseStamps(ctx: TenantContext, input: PurchaseAwardInput): Promise<StampOperationResult> {
  if (!Number.isInteger(input.purchaseAmountMinor) || input.purchaseAmountMinor < 0) {
    throw new ValidationError("purchaseAmountMinor must be a non-negative integer of minor units");
  }

  return runCardAction(
    ctx,
    input,
    { op: "purchase", purchaseAmountMinor: input.purchaseAmountMinor, comment: input.comment ?? null },
    async (tx, loaded, actor, locationId, now) => {
      if (loaded.mechanics.earnMode !== StampEarnMode.SPEND_BLOCK) {
        throw new ValidationError(`Purchase awards need a SPEND_BLOCK program; this one earns by ${loaded.mechanics.earnMode}`);
      }
      const stamps = stampsForPurchase(loaded.mechanics, input.purchaseAmountMinor);
      if (stamps === 0) {
        throw new ValidationError(
          `A purchase of ${input.purchaseAmountMinor} does not complete a block of ${loaded.mechanics.spendAmountPerBlockMinor}`,
        );
      }
      await assertDailyLimit(tx, loaded, now);
      return writeAward(tx, loaded, actor, locationId, OperationKind.PURCHASE_AWARD, stamps, {
        purchaseAmountMinor: input.purchaseAmountMinor,
        comment: input.comment,
      });
    },
  );
}

/**
 * Hand over one earned reward.
 *
 * Decrements `rewardBalance` by exactly one and touches stamps not at all. It never converts,
 * never tops up, and never fires because a balance happened to reach a threshold: rewards sit in
 * `rewardBalance` until a human gives the customer their coffee.
 */
export async function redeemReward(ctx: TenantContext, input: RedeemRewardInput): Promise<StampOperationResult> {
  return runCardAction(
    ctx,
    input,
    { op: "redeem", comment: input.comment ?? null },
    async (tx, loaded, actor, locationId) => {
      if (loaded.card.rewardBalance < 1) {
        throw new ConflictError("This card has no reward to redeem", ConflictCode.NO_REWARD_AVAILABLE);
      }
      const appended = await appendOperationGroup(
        {
          actor,
          customerCardId: loaded.card.id,
          locationId,
          operations: [
            {
              kind: OperationKind.REWARD_REDEEMED,
              unitType: UnitType.REWARD,
              quantity: -1,
              rewardTierId: loaded.rewardTierId,
              // What the reward cost the merchant, for later ROI reporting.
              redemptionValueMinor: loaded.mechanics.rewardValueMinor ?? null,
              comment: input.comment ?? null,
            },
          ],
        },
        tx,
      );
      const stampBalance = appended.balances[UnitType.STAMP];
      return {
        transactionGroupId: appended.transactionGroupId,
        customerCardId: appended.customerCardId,
        stampBalance,
        rewardBalance: appended.balances[UnitType.REWARD],
        stampsAwarded: 0,
        rewardsEarned: 0,
        stampsToNextReward: loaded.mechanics.stampsRequiredPerReward - (stampBalance % loaded.mechanics.stampsRequiredPerReward),
        operations: appended.operations.map((o) => ({
          id: o.id,
          kind: o.kind,
          unitType: o.unitType,
          quantity: o.quantity,
          balanceAfter: o.balanceAfter,
        })),
      };
    },
  );
}

/**
 * Undo a whole group with compensating rows.
 *
 * Delegates to the Phase 0 reversal, which locks the card first, refuses to reverse a reversal or
 * an already-reversed group, and refuses when the value has since been consumed — a reward earned
 * and then redeemed cannot be un-earned, and the error says to correct it manually instead.
 */
export async function reverseStampOperation(ctx: TenantContext, input: ReverseGroupActionInput): Promise<StampOperationResult> {
  assertNoCallerLocation(input);
  if (typeof input.idempotencyKey !== "string" || input.idempotencyKey.trim().length < 8) {
    throw new ValidationError("An idempotency key of at least 8 characters is required");
  }
  const actor: MemberActor = { kind: "member", ctx, source: input.source };

  const outcome = await runIdempotent<StampOperationResult>({
    businessId: ctx.businessId,
    key: input.idempotencyKey,
    payload: { op: "reverse", transactionGroupId: input.transactionGroupId, reason: input.reason },
    execute: async (tx) => {
      // The compensating rows land at Main, like everything else this phase writes.
      const locationId = await getDefaultLocationId(tx, ctx.businessId);
      const appended = await reverseOperationGroup(
        { actor, transactionGroupId: input.transactionGroupId, reason: input.reason, locationId },
        tx,
      );
      const loaded = await tx.customerCard.findFirstOrThrow({
        where: { id: appended.customerCardId, businessId: ctx.businessId },
        select: { programVersion: { select: { id: true, mechanics: true } } },
      });
      const mechanics = readStampMechanics(loaded.programVersion.mechanics, { programVersionId: loaded.programVersion.id });
      const stampBalance = appended.balances[UnitType.STAMP];
      const stampsAwarded = appended.operations
        .filter((o) => o.unitType === UnitType.STAMP)
        .reduce((sum, o) => sum + o.quantity, 0);

      const result: StampOperationResult = {
        transactionGroupId: appended.transactionGroupId,
        customerCardId: appended.customerCardId,
        stampBalance,
        rewardBalance: appended.balances[UnitType.REWARD],
        stampsAwarded,
        rewardsEarned: 0,
        stampsToNextReward: mechanics.stampsRequiredPerReward - (stampBalance % mechanics.stampsRequiredPerReward),
        operations: appended.operations.map((o) => ({
          id: o.id,
          kind: o.kind,
          unitType: o.unitType,
          quantity: o.quantity,
          balanceAfter: o.balanceAfter,
        })),
      };
      return { result, transactionGroupId: result.transactionGroupId };
    },
  });
  return outcome.result;
}

/**
 * Grant the enrollment welcome bonus.
 *
 * Internal to enrollment: it runs inside the transaction that CREATED the card, which is what
 * makes it exactly-once — only one transaction wins the card insert, so only one writes this.
 * The actor is the platform, not a staff member, and the source is ENROLLMENT, so the Phase 0
 * visit policy records it as not a visit without anyone having to say so.
 */
export async function grantWelcomeStamps(
  tx: Tx,
  args: { businessId: string; customerCardId: string; locationId: string; stamps: number; reason: string },
): Promise<void> {
  if (!Number.isInteger(args.stamps) || args.stamps < 1) return;

  const loaded = await loadLockedStampCard(tx, args.businessId, args.customerCardId, new Date());
  const plan = planStampConversion(loaded.mechanics, loaded.card.stampBalance, args.stamps);
  const operations: OperationInput[] = [
    { kind: OperationKind.WELCOME_BONUS, unitType: UnitType.STAMP, quantity: args.stamps },
  ];
  // Mechanics refuse a welcome bonus that alone completes a card, but a merchant may still
  // configure one that completes a card carrying stamps from a previous enrollment attempt.
  if (plan.rewardsEarned > 0) {
    operations.push(
      { kind: OperationKind.STAMP_CONVERTED, unitType: UnitType.STAMP, quantity: -plan.stampsConverted, rewardTierId: loaded.rewardTierId },
      { kind: OperationKind.REWARD_EARNED, unitType: UnitType.REWARD, quantity: plan.rewardsEarned, rewardTierId: loaded.rewardTierId },
    );
  }

  await appendOperationGroup(
    {
      actor: { kind: "system", businessId: args.businessId, source: OperationSource.ENROLLMENT, reason: args.reason },
      customerCardId: args.customerCardId,
      locationId: args.locationId,
      operations,
    },
    tx,
  );
}

/** Read-only snapshot for the scanner screen. Tenant-scoped. */
export async function getCardBalances(ctx: TenantContext, customerCardId: string) {
  const card = await prisma.customerCard.findFirst({
    where: { id: customerCardId, businessId: ctx.businessId },
    select: { id: true, status: true, stampBalance: true, rewardBalance: true, expiresAt: true, programVersion: { select: { id: true, mechanics: true } } },
  });
  if (!card) throw new NotFoundError("Card not found");
  const mechanics = readStampMechanics(card.programVersion.mechanics, { programVersionId: card.programVersion.id });
  return {
    customerCardId: card.id,
    status: card.status,
    stampBalance: card.stampBalance,
    rewardBalance: card.rewardBalance,
    stampsRequiredPerReward: mechanics.stampsRequiredPerReward,
    stampsToNextReward: mechanics.stampsRequiredPerReward - (card.stampBalance % mechanics.stampsRequiredPerReward),
    expiresAt: card.expiresAt,
  };
}
