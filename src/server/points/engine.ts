import { CardStatus, OperationKind, OperationSource, Permission, UnitType } from "@prisma/client";
import { prisma, type Tx } from "../db";
import { ConflictCode, ConflictError, NotFoundError, ValidationError } from "../errors";
import { runIdempotent } from "../ledger/idempotency";
import { appendOperationGroup, reverseOperationGroup } from "../ledger/ledger";
import type { MemberActor, MemberSource } from "../ledger/actor";
import type { OperationInput } from "../ledger/types";
import { resolveOperationLocationId } from "../program/available-locations";
import {
  assertDailyAwardLimit,
  assertIdempotencyKey,
  assertMinorUnits,
  assertNoReversalLocation,
  assertTransactable,
} from "../program/card-actions";
import {
  PointsEarnMode,
  pointsForPurchase,
  pointsForVisit,
  readPointsMechanics,
  type PointsMechanics,
} from "../program/points-mechanics";
import { getDefaultLocationId } from "../program/stamp-program";
import { requirePermission, type TenantContext } from "../tenant/context";

/**
 * The points engine: the only way a points card's value changes.
 *
 * It is a sibling of the stamp engine, not a generalisation of it. The two share the ledger, the
 * idempotency wrapper, the card lock and the daily-limit rule (`program/card-actions.ts`), and
 * they share nothing about arithmetic — because the arithmetic is the whole difference:
 *
 * | | Stamp card | Points card |
 * |---|---|---|
 * | Earning | stamps accumulate | points accumulate |
 * | Threshold | **automatic** conversion at `stampsRequiredPerReward`, remainder carried | **none** |
 * | Reward | appears in `rewardBalance` and waits to be handed over | chosen by the customer from configured tiers |
 * | Redemption | `REWARD` −1, points untouched | `POINT` −`tier.requiredPoints`, no reward balance involved |
 *
 * A points card therefore never touches `rewardBalance` or `stampBalance`, and a stamp card never
 * touches `pointBalance`. That separation is not a convention this file promises to keep — the
 * engines read their own `mechanics` discriminator (`kind: "POINTS"` / `"STAMP"`) and refuse a
 * card pinned to the other kind with a LedgerInvariantError before any arithmetic happens.
 *
 * ## The tier-redemption contract, stated before it is implemented
 *
 * One redemption is ONE ledger row inside one transaction group:
 *
 * ```
 * kind:                 REWARD_REDEEMED
 * unitType:             POINT
 * quantity:             -tier.requiredPoints          (negative, integer, never a fraction)
 * rewardTierId:         tier.id                       (the ledger verifies it against the card's
 *                                                      PINNED programVersionId)
 * redemptionValueMinor: tier.rewardValueMinor ?? null (what the reward cost the merchant)
 * balanceAfter:         the POINT balance after the debit
 * ```
 *
 * There is no second row. A `+1 REWARD` row would invent a balance nobody can spend, and a
 * `STAMP_CONVERTED` row would claim a conversion that did not happen. What makes the redemption
 * auditable is `rewardTierId`: the tier row carries the name, the cost in points and the merchant
 * value **as they were when the version was frozen**, so a tier renamed in a later version cannot
 * rewrite what a customer redeemed last month.
 *
 * **Reversal** is the ledger's ordinary compensating group: `+tier.requiredPoints` against the same
 * card, carrying `reversalOfOperationId` and the same `rewardTierId`. Points come back, the
 * redemption stops counting against `usageLimit`, and the partial unique index on
 * `reversalOfOperationId` means it can happen exactly once. Nothing is ever mutated or deleted.
 *
 * **Idempotency** is the same `runIdempotent` wrapper every counter action uses: one tap, one key,
 * one redemption however many times the network repeats it.
 */

/** What every points write returns. A type alias, not an interface, so it satisfies Prisma's JSON input. */
export type PointsOperationResult = {
  transactionGroupId: string;
  customerCardId: string;
  /** Points on the card after this operation. */
  pointBalance: number;
  /** Points granted by this operation; negative on a redemption or a reversal. */
  pointsDelta: number;
  /** The tier redeemed, when this operation was a redemption. */
  rewardTierId: string | null;
  /** Where the operation was attributed. */
  locationId: string;
  operations: { id: string; kind: OperationKind; unitType: UnitType; quantity: number; balanceAfter: number }[];
};

/** Fields every counter action shares. */
export interface PointsActionInput {
  customerCardId: string;
  /**
   * Client-generated, stable across retries of the SAME intent. Two different taps must use two
   * different keys; one tap retried three times must use one key.
   */
  idempotencyKey: string;
  /** SCANNER for a counter scan, DASHBOARD for a merchant acting from the back office. */
  source: MemberSource;
  /**
   * Which counter this happened at.
   *
   * Only meaningful when the card's pinned version lists `availableLocations`. A version that does
   * not — every Phase 1a version, and every Phase 1b one that did not ask — refuses a supplied
   * location and attributes to Main, exactly as before.
   */
  locationId?: string;
  /** Internal note. Stored on the operation and never shown to the customer. */
  comment?: string;
}

export interface ManualPointsInput extends PointsActionInput {
  /** Points to grant. Positive; the ledger refuses zero. */
  quantity: number;
  /** Required when the program sets `requirePurchaseAmount`. */
  purchaseAmountMinor?: number;
}

export interface VisitPointsInput extends PointsActionInput {
  purchaseAmountMinor?: number;
}

export interface PurchasePointsInput extends PointsActionInput {
  /** Integer minor units of the business currency. Whole blocks earn; the remainder is discarded. */
  purchaseAmountMinor: number;
}

export interface RedeemTierInput extends PointsActionInput {
  /** Must belong to the card's PINNED program version. */
  rewardTierId: string;
}

export interface ReversePointsInput {
  transactionGroupId: string;
  reason: string;
  idempotencyKey: string;
  source: MemberSource;
}

interface LockedPointsCard {
  id: string;
  status: CardStatus;
  expiresAt: Date | null;
  programVersionId: string;
  pointBalance: number;
}

interface LoadedPointsCard {
  card: LockedPointsCard;
  mechanics: PointsMechanics;
  timezone: string;
}

/**
 * Lock the card and load the rules pinned to it.
 *
 * The lock is taken FIRST and held for the rest of the transaction, so a concurrent award or
 * redemption on the same card waits rather than racing — which is what makes "enough points to
 * redeem" a decision that cannot be made twice on the same balance.
 */
async function loadLockedPointsCard(tx: Tx, businessId: string, customerCardId: string, now: Date): Promise<LoadedPointsCard> {
  const rows = await tx.$queryRaw<LockedPointsCard[]>`
    SELECT id, status, "expiresAt", "programVersionId", "pointBalance"
      FROM "CustomerCard"
     WHERE id = ${customerCardId} AND "businessId" = ${businessId}
     FOR UPDATE`;
  const card = rows[0];
  // Tenant-scoped: a card id belonging to another business is indistinguishable from one that does
  // not exist. Never "forbidden", which would confirm it exists.
  if (!card) throw new NotFoundError("Card not found");
  assertTransactable(card, now);

  const version = await tx.programVersion.findFirst({
    where: { id: card.programVersionId, template: { businessId } },
    select: { id: true, mechanics: true, template: { select: { business: { select: { timezone: true } } } } },
  });
  if (!version) throw new NotFoundError("Card program version not found");

  // Refuses a stamp card before any arithmetic: the discriminator in the pinned mechanics is what
  // decides which engine owns this card, not the caller's choice of endpoint.
  const mechanics = readPointsMechanics(version.mechanics, { programVersionId: version.id });
  return { card, mechanics, timezone: version.template.business.timezone };
}

/** Programs may demand the purchase amount on every award, not only on purchase awards. */
function assertPurchaseAmount(mechanics: PointsMechanics, purchaseAmountMinor: number | undefined): void {
  assertMinorUnits(purchaseAmountMinor, "purchaseAmountMinor");
  if (purchaseAmountMinor === undefined && mechanics.requirePurchaseAmount) {
    throw new ValidationError("This program requires the purchase amount for every award");
  }
}

function toResult(
  appended: { transactionGroupId: string; customerCardId: string; balances: Record<UnitType, number>; operations: { id: string; kind: OperationKind; unitType: UnitType; quantity: number; balanceAfter: number }[] },
  locationId: string,
  rewardTierId: string | null,
): PointsOperationResult {
  return {
    transactionGroupId: appended.transactionGroupId,
    customerCardId: appended.customerCardId,
    pointBalance: appended.balances[UnitType.POINT],
    pointsDelta: appended.operations.filter((o) => o.unitType === UnitType.POINT).reduce((sum, o) => sum + o.quantity, 0),
    rewardTierId,
    locationId,
    operations: appended.operations.map((o) => ({
      id: o.id,
      kind: o.kind,
      unitType: o.unitType,
      quantity: o.quantity,
      balanceAfter: o.balanceAfter,
    })),
  };
}

/** Shared preamble: open the idempotent transaction, lock the card, resolve the location. */
async function runPointsAction(
  ctx: TenantContext,
  input: PointsActionInput,
  payload: Record<string, unknown>,
  action: (tx: Tx, loaded: LoadedPointsCard, actor: MemberActor, locationId: string, now: Date) => Promise<PointsOperationResult>,
): Promise<PointsOperationResult> {
  assertIdempotencyKey(input.idempotencyKey);
  const actor: MemberActor = { kind: "member", ctx, source: input.source };

  const outcome = await runIdempotent<PointsOperationResult>({
    businessId: ctx.businessId,
    key: input.idempotencyKey,
    // The payload is what makes a retry safe: the same key with different intent is a client bug
    // and is refused, rather than silently replaying the wrong answer. The location is part of the
    // intent — the same tap at a different branch is a different operation.
    payload: {
      ...payload,
      customerCardId: input.customerCardId,
      source: input.source,
      locationId: input.locationId ?? null,
    },
    execute: async (tx) => {
      const now = new Date();
      const loaded = await loadLockedPointsCard(tx, ctx.businessId, input.customerCardId, now);
      const locationId = await resolveOperationLocationId(tx, {
        ctx,
        mechanics: loaded.mechanics,
        requestedLocationId: input.locationId,
        defaultLocationId: await getDefaultLocationId(tx, ctx.businessId),
      });
      const result = await action(tx, loaded, actor, locationId, now);
      return { result, transactionGroupId: result.transactionGroupId };
    },
  });
  return outcome.result;
}

/** Write one award group: a single POINT row. Points never convert, so there is nothing else to write. */
async function writeAward(
  tx: Tx,
  loaded: LoadedPointsCard,
  actor: MemberActor,
  locationId: string,
  kind: OperationKind,
  points: number,
  extras: { purchaseAmountMinor?: number; comment?: string },
): Promise<PointsOperationResult> {
  const operations: OperationInput[] = [
    {
      kind,
      unitType: UnitType.POINT,
      quantity: points,
      purchaseAmountMinor: extras.purchaseAmountMinor ?? null,
      comment: extras.comment ?? null,
    },
  ];
  const appended = await appendOperationGroup({ actor, customerCardId: loaded.card.id, locationId, operations }, tx);
  return toResult(appended, locationId, null);
}

/**
 * Staff grant points at their discretion.
 *
 * Allowed whatever the program's earn mode: a merchant always needs "the tablet was down, give them
 * their points". `maxPointsPerManualAward` bounds it when the program sets one, because the number
 * here is typed by a human on a phone.
 */
export async function awardManualPoints(ctx: TenantContext, input: ManualPointsInput): Promise<PointsOperationResult> {
  if (!Number.isInteger(input.quantity) || input.quantity < 1) {
    throw new ValidationError("Manual award quantity must be a positive integer");
  }
  assertMinorUnits(input.purchaseAmountMinor, "purchaseAmountMinor");

  return runPointsAction(
    ctx,
    input,
    { op: "manual", quantity: input.quantity, purchaseAmountMinor: input.purchaseAmountMinor ?? null, comment: input.comment ?? null },
    async (tx, loaded, actor, locationId, now) => {
      const max = loaded.mechanics.maxPointsPerManualAward;
      if (max !== undefined && input.quantity > max) {
        throw new ValidationError(`This program allows at most ${max} points in one manual award`);
      }
      assertPurchaseAmount(loaded.mechanics, input.purchaseAmountMinor);
      await assertDailyAwardLimit(tx, {
        customerCardId: loaded.card.id,
        timezone: loaded.timezone,
        limit: loaded.mechanics.dailyAwardLimit,
        now,
      });
      return writeAward(tx, loaded, actor, locationId, OperationKind.MANUAL_AWARD, input.quantity, {
        purchaseAmountMinor: input.purchaseAmountMinor,
        comment: input.comment,
      });
    },
  );
}

/** One visit, `pointsPerVisit` points. Requires a PER_VISIT program. */
export async function awardVisitPoints(ctx: TenantContext, input: VisitPointsInput): Promise<PointsOperationResult> {
  return runPointsAction(
    ctx,
    input,
    { op: "visit", purchaseAmountMinor: input.purchaseAmountMinor ?? null, comment: input.comment ?? null },
    async (tx, loaded, actor, locationId, now) => {
      if (loaded.mechanics.earnMode !== PointsEarnMode.PER_VISIT) {
        throw new ValidationError(`Visit awards need a PER_VISIT program; this one earns by ${loaded.mechanics.earnMode}`);
      }
      assertPurchaseAmount(loaded.mechanics, input.purchaseAmountMinor);
      await assertDailyAwardLimit(tx, {
        customerCardId: loaded.card.id,
        timezone: loaded.timezone,
        limit: loaded.mechanics.dailyAwardLimit,
        now,
      });
      return writeAward(tx, loaded, actor, locationId, OperationKind.VISIT_AWARD, pointsForVisit(loaded.mechanics), {
        purchaseAmountMinor: input.purchaseAmountMinor,
        comment: input.comment,
      });
    },
  );
}

/**
 * Whole blocks of spend earn points; the remainder is discarded, not carried (PRODUCT-SPEC §5.5).
 * A purchase too small to fill one block earns nothing and is refused rather than written as a
 * zero-quantity row, which the ledger would reject anyway.
 */
export async function awardPurchasePoints(ctx: TenantContext, input: PurchasePointsInput): Promise<PointsOperationResult> {
  if (!Number.isInteger(input.purchaseAmountMinor) || input.purchaseAmountMinor < 0) {
    throw new ValidationError("purchaseAmountMinor must be a non-negative integer of minor units");
  }

  return runPointsAction(
    ctx,
    input,
    { op: "purchase", purchaseAmountMinor: input.purchaseAmountMinor, comment: input.comment ?? null },
    async (tx, loaded, actor, locationId, now) => {
      if (loaded.mechanics.earnMode !== PointsEarnMode.SPEND_BLOCK) {
        throw new ValidationError(`Purchase awards need a SPEND_BLOCK program; this one earns by ${loaded.mechanics.earnMode}`);
      }
      const points = pointsForPurchase(loaded.mechanics, input.purchaseAmountMinor);
      if (points === 0) {
        throw new ValidationError(
          `A purchase of ${input.purchaseAmountMinor} does not complete a block of ${loaded.mechanics.spendAmountPerBlockMinor}`,
        );
      }
      await assertDailyAwardLimit(tx, {
        customerCardId: loaded.card.id,
        timezone: loaded.timezone,
        limit: loaded.mechanics.dailyAwardLimit,
        now,
      });
      return writeAward(tx, loaded, actor, locationId, OperationKind.PURCHASE_AWARD, points, {
        purchaseAmountMinor: input.purchaseAmountMinor,
        comment: input.comment,
      });
    },
  );
}

/**
 * How many times this card has redeemed this tier and kept it — redemptions minus their reversals.
 *
 * Read under the card lock, so it cannot race a concurrent redemption. A reversed redemption does
 * not count: the customer got their points back, so they have not consumed the tier.
 */
async function countTierRedemptions(tx: Tx, customerCardId: string, rewardTierId: string): Promise<number> {
  const redemptions = await tx.loyaltyOperation.findMany({
    where: { customerCardId, rewardTierId, kind: OperationKind.REWARD_REDEEMED },
    select: { id: true },
  });
  if (redemptions.length === 0) return 0;
  const reversed = await tx.loyaltyOperation.count({
    where: { reversalOfOperationId: { in: redemptions.map((r) => r.id) } },
  });
  return redemptions.length - reversed;
}

/**
 * Spend points on one configured reward.
 *
 * Everything that decides the price is read from the tier row on the card's PINNED version, never
 * from the caller: a request names which tier, and nothing else. The balance check happens under
 * the card lock, and the ledger's own non-negative invariant is the backstop beneath it.
 */
export async function redeemRewardTier(ctx: TenantContext, input: RedeemTierInput): Promise<PointsOperationResult> {
  if (typeof input.rewardTierId !== "string" || input.rewardTierId.trim().length === 0) {
    throw new ValidationError("rewardTierId is required");
  }

  return runPointsAction(
    ctx,
    input,
    { op: "redeem", rewardTierId: input.rewardTierId, comment: input.comment ?? null },
    async (tx, loaded, actor, locationId) => {
      // Tenant-scoped AND version-scoped: a tier from another business, or from another version of
      // this same program, is "not found" rather than "forbidden".
      const tier = await tx.rewardTier.findFirst({
        where: { id: input.rewardTierId, programVersionId: loaded.card.programVersionId },
        select: { id: true, requiredPoints: true, rewardValueMinor: true, usageLimit: true },
      });
      if (!tier) throw new NotFoundError("Reward tier not found for this card's program");

      if (loaded.card.pointBalance < tier.requiredPoints) {
        throw new ConflictError(
          `This card has ${loaded.card.pointBalance} points and the reward costs ${tier.requiredPoints}`,
          ConflictCode.NO_REWARD_AVAILABLE,
        );
      }

      if (tier.usageLimit !== null) {
        const used = await countTierRedemptions(tx, loaded.card.id, tier.id);
        if (used >= tier.usageLimit) {
          throw new ConflictError(
            `This card has already redeemed this reward ${tier.usageLimit} time(s), which is its limit`,
            ConflictCode.NO_REWARD_AVAILABLE,
          );
        }
      }

      const appended = await appendOperationGroup(
        {
          actor,
          customerCardId: loaded.card.id,
          locationId,
          operations: [
            {
              kind: OperationKind.REWARD_REDEEMED,
              unitType: UnitType.POINT,
              quantity: -tier.requiredPoints,
              rewardTierId: tier.id,
              // What the reward cost the merchant, for later ROI reporting.
              redemptionValueMinor: tier.rewardValueMinor,
              comment: input.comment ?? null,
            },
          ],
        },
        tx,
      );
      return toResult(appended, locationId, tier.id);
    },
  );
}

/**
 * Undo a whole points group with compensating rows.
 *
 * Delegates to the Phase 0 reversal, which locks the card first, refuses to reverse a reversal or
 * an already-reversed group, and refuses when the value has since been spent. The compensating
 * rows are attributed to the ORIGINAL group's location, never the reverser's — see
 * `reverseOperationGroup`.
 */
export async function reversePointsOperation(ctx: TenantContext, input: ReversePointsInput): Promise<PointsOperationResult> {
  assertNoReversalLocation(input);
  assertIdempotencyKey(input.idempotencyKey);
  const actor: MemberActor = { kind: "member", ctx, source: input.source };

  const outcome = await runIdempotent<PointsOperationResult>({
    businessId: ctx.businessId,
    key: input.idempotencyKey,
    payload: { op: "reverse", transactionGroupId: input.transactionGroupId, reason: input.reason },
    execute: async (tx) => {
      const appended = await reverseOperationGroup(
        { actor, transactionGroupId: input.transactionGroupId, reason: input.reason },
        tx,
      );
      const originalLocation = await tx.loyaltyOperation.findFirstOrThrow({
        where: { transactionGroupId: appended.transactionGroupId },
        select: { locationId: true, rewardTierId: true },
      });
      const result = toResult(appended, originalLocation.locationId, originalLocation.rewardTierId);
      return { result, transactionGroupId: result.transactionGroupId };
    },
  });
  return outcome.result;
}

/**
 * Grant the enrollment welcome bonus on a points card.
 *
 * Internal to enrollment: it runs inside the transaction that CREATED the card, which is what makes
 * it exactly-once — only one transaction wins the card insert, so only one writes this. The actor
 * is the platform, not a staff member, and the source is ENROLLMENT, so the Phase 0 visit policy
 * records it as not a visit without anyone having to say so.
 */
export async function grantWelcomePoints(
  tx: Tx,
  args: { businessId: string; customerCardId: string; locationId: string; points: number; reason: string },
): Promise<void> {
  if (!Number.isInteger(args.points) || args.points < 1) return;

  await appendOperationGroup(
    {
      actor: { kind: "system", businessId: args.businessId, source: OperationSource.ENROLLMENT, reason: args.reason },
      customerCardId: args.customerCardId,
      locationId: args.locationId,
      operations: [{ kind: OperationKind.WELCOME_BONUS, unitType: UnitType.POINT, quantity: args.points }],
    },
    tx,
  );
}

export interface PointsCardSummary {
  customerCardId: string;
  status: CardStatus;
  pointBalance: number;
  pointsLabel: string | null;
  expiresAt: Date | null;
  /** Tiers on the card's PINNED version, cheapest first, with what this card can afford now. */
  tiers: { id: string; name: string; description: string | null; requiredPoints: number; affordable: boolean; remainingUses: number | null }[];
}

/** Read-only snapshot for a staff screen. Tenant-scoped and permission-gated. */
export async function getPointsCardSummary(ctx: TenantContext, customerCardId: string): Promise<PointsCardSummary> {
  requirePermission(ctx, Permission.VIEW_CUSTOMERS);
  const card = await prisma.customerCard.findFirst({
    where: { id: customerCardId, businessId: ctx.businessId },
    select: {
      id: true,
      status: true,
      pointBalance: true,
      expiresAt: true,
      programVersion: {
        select: {
          id: true,
          mechanics: true,
          rewardTiers: {
            select: { id: true, name: true, description: true, requiredPoints: true, usageLimit: true },
            orderBy: [{ requiredPoints: "asc" }, { sortOrder: "asc" }],
          },
        },
      },
    },
  });
  if (!card) throw new NotFoundError("Card not found");
  const mechanics = readPointsMechanics(card.programVersion.mechanics, { programVersionId: card.programVersion.id });

  /*
   * Redemptions and their reversals for the whole card in two queries, not two per tier. A screen
   * read that opens a transaction per reward is a screen read that gets slower as a merchant adds
   * rewards - and this one runs every time a cashier scans a card.
   */
  const redemptions = await prisma.loyaltyOperation.findMany({
    where: { customerCardId: card.id, kind: OperationKind.REWARD_REDEEMED },
    select: { id: true, rewardTierId: true },
  });
  const reversedIds = new Set(
    (
      await prisma.loyaltyOperation.findMany({
        where: { reversalOfOperationId: { in: redemptions.map((r) => r.id) } },
        select: { reversalOfOperationId: true },
      })
    ).map((r) => r.reversalOfOperationId),
  );
  const used = new Map<string, number>();
  for (const r of redemptions) {
    if (r.rewardTierId === null || reversedIds.has(r.id)) continue;
    used.set(r.rewardTierId, (used.get(r.rewardTierId) ?? 0) + 1);
  }

  const tiers = card.programVersion.rewardTiers.map((t) => ({
    id: t.id,
    name: t.name,
    description: t.description,
    requiredPoints: t.requiredPoints,
    affordable: card.pointBalance >= t.requiredPoints,
    remainingUses: t.usageLimit === null ? null : Math.max(0, t.usageLimit - (used.get(t.id) ?? 0)),
  }));

  return {
    customerCardId: card.id,
    status: card.status,
    pointBalance: card.pointBalance,
    pointsLabel: mechanics.pointsLabel ?? null,
    expiresAt: card.expiresAt,
    tiers,
  };
}
