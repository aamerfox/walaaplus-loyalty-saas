import { randomUUID } from "node:crypto";
import { OperationKind, OperationSource, Prisma, UnitType, type CardStatus, type PrismaClient } from "@prisma/client";
import { prisma, type DbClient, type Tx } from "../db";
import { ConflictError, LedgerInvariantError, NotFoundError, ValidationError } from "../errors";
import type { AppendResult, AppendedOperation, Balances, OperationGroupInput, OperationInput } from "./types";
import { readVisitRules, resolveCountsAsVisit } from "./visits";

/**
 * The ONLY code path that writes LoyaltyOperation rows.
 *
 * Guarantees (docs/PRODUCT-SPEC.md §2.1–2.4):
 *  - every group commits in one transaction, or not at all;
 *  - the card row is locked with SELECT … FOR UPDATE, so concurrent groups on the same card
 *    serialise and every balanceAfter is exact;
 *  - balances never go negative;
 *  - card balance columns are updated from the same computation that produced balanceAfter;
 *  - countsAsVisit is resolved here, once, and frozen;
 *  - reversals are new compensating rows, never mutations.
 *
 * No route or page may call Prisma's loyaltyOperation model directly.
 */

const UNIT_COLUMN: Record<UnitType, "stampBalance" | "pointBalance" | "rewardBalance" | "cashBalanceMinor" | "visitBalance"> = {
  STAMP: "stampBalance",
  POINT: "pointBalance",
  REWARD: "rewardBalance",
  CASH: "cashBalanceMinor",
  VISIT: "visitBalance",
};

const ALL_UNITS = Object.values(UnitType);

const KINDS_REQUIRING_REASON: ReadonlySet<OperationKind> = new Set<OperationKind>([
  OperationKind.REVERSAL,
  OperationKind.IMPORT_ADJUSTMENT,
  OperationKind.INTEGRATION_REVERSAL,
]);

interface LockedCard {
  id: string;
  businessId: string;
  templateId: string;
  programVersionId: string;
  customerBusinessProfileId: string;
  status: CardStatus;
  stampBalance: number;
  pointBalance: number;
  rewardBalance: number;
  cashBalanceMinor: number;
  visitBalance: number;
}

/** PrismaClient is structurally a superset of TransactionClient, so detect the ROOT client. */
function isRootClient(db: DbClient): db is PrismaClient {
  return "$transaction" in db;
}

/** Run `fn` inside `db` if it is already a transaction, otherwise open one. */
async function inTransaction<T>(db: DbClient, fn: (tx: Tx) => Promise<T>): Promise<T> {
  if (isRootClient(db)) {
    return db.$transaction(fn, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, timeout: 15_000 });
  }
  return fn(db);
}

function validateOperations(ops: OperationInput[]): void {
  if (ops.length === 0) throw new ValidationError("An operation group needs at least one operation");
  for (const op of ops) {
    if (!Number.isInteger(op.quantity) || op.quantity === 0) {
      throw new ValidationError(`Operation ${op.kind}: quantity must be a non-zero integer`);
    }
    for (const f of ["purchaseAmountMinor", "monetaryDeltaMinor", "redemptionValueMinor"] as const) {
      const v = op[f];
      if (v != null && !Number.isInteger(v)) throw new ValidationError(`Operation ${op.kind}: ${f} must be an integer`);
    }
    if (KINDS_REQUIRING_REASON.has(op.kind) && !op.reason?.trim()) {
      throw new ValidationError(`Operation ${op.kind} requires a reason`);
    }
    if (op.kind === OperationKind.REVERSAL && !op.reversalOfOperationId) {
      throw new ValidationError("REVERSAL requires reversalOfOperationId");
    }
  }
}

/**
 * Append one atomic group of operations to a card's ledger and refresh its balance projections.
 */
export async function appendOperationGroup(input: OperationGroupInput, db: DbClient = prisma): Promise<AppendResult> {
  validateOperations(input.operations);

  return inTransaction(db, async (tx) => {
    // 1. Lock the card row. Tenant-scoped: a foreign card id is simply "not found".
    const locked = await tx.$queryRaw<LockedCard[]>`
      SELECT id, "businessId", "templateId", "programVersionId", "customerBusinessProfileId", status,
             "stampBalance", "pointBalance", "rewardBalance", "cashBalanceMinor", "visitBalance"
      FROM "CustomerCard"
      WHERE id = ${input.customerCardId} AND "businessId" = ${input.businessId}
      FOR UPDATE`;
    const card = locked[0];
    if (!card) throw new NotFoundError("Card not found");
    if (card.status === "DELETED") throw new ConflictError("Card is deleted");

    // 2. Resolve related rows, all scoped to the same business.
    const [profile, location, version] = await Promise.all([
      tx.customerBusinessProfile.findFirst({
        where: { id: card.customerBusinessProfileId, businessId: input.businessId },
        select: { customerId: true },
      }),
      tx.location.findFirst({
        where: { id: input.locationId, businessId: input.businessId },
        select: { id: true },
      }),
      tx.programVersion.findFirst({
        where: { id: card.programVersionId, template: { businessId: input.businessId } },
        select: { mechanics: true },
      }),
    ]);
    if (!profile) throw new LedgerInvariantError("Card profile does not belong to this business");
    if (!location) throw new NotFoundError("Location not found");
    if (!version) throw new LedgerInvariantError("Card program version does not belong to this business");

    const visitRules = readVisitRules(version.mechanics);

    // 3. Apply operations sequentially against the locked balances.
    const balances: Balances = {
      STAMP: card.stampBalance,
      POINT: card.pointBalance,
      REWARD: card.rewardBalance,
      CASH: card.cashBalanceMinor,
      VISIT: card.visitBalance,
    };
    const transactionGroupId = input.transactionGroupId ?? randomUUID();
    const appended: AppendedOperation[] = [];

    for (const op of input.operations) {
      const next = balances[op.unitType] + op.quantity;
      if (next < 0) {
        throw new LedgerInvariantError(
          `${op.kind} of ${op.quantity} ${op.unitType} would make the balance negative (${balances[op.unitType]} → ${next})`,
        );
      }
      balances[op.unitType] = next;
      const countsAsVisit = resolveCountsAsVisit(op.kind, visitRules);

      const row = await tx.loyaltyOperation.create({
        data: {
          transactionGroupId,
          businessId: input.businessId,
          locationId: input.locationId,
          customerId: profile.customerId,
          customerBusinessProfileId: card.customerBusinessProfileId,
          customerCardId: card.id,
          templateId: card.templateId,
          programVersionId: card.programVersionId,
          performedByUserId: input.performedByUserId,
          rewardTierId: op.rewardTierId ?? null,
          kind: op.kind,
          unitType: op.unitType,
          quantity: op.quantity,
          purchaseAmountMinor: op.purchaseAmountMinor ?? null,
          monetaryDeltaMinor: op.monetaryDeltaMinor ?? null,
          redemptionValueMinor: op.redemptionValueMinor ?? null,
          balanceAfter: next,
          countsAsVisit,
          source: input.source,
          comment: op.comment ?? null,
          reason: op.reason ?? null,
          reversalOfOperationId: op.reversalOfOperationId ?? null,
          externalProvider: op.externalProvider ?? null,
          externalEventId: op.externalEventId ?? null,
        },
        select: { id: true, kind: true, unitType: true, quantity: true, balanceAfter: true, countsAsVisit: true },
      });
      appended.push(row);
    }

    // 4. Refresh projections from the very numbers written to the ledger.
    const projection: Record<string, number | Date> = { lastActivityAt: new Date() };
    for (const unit of ALL_UNITS) projection[UNIT_COLUMN[unit]] = balances[unit];
    await tx.customerCard.update({ where: { id: card.id }, data: projection });

    return { transactionGroupId, customerCardId: card.id, operations: appended, balances };
  });
}

export interface ReverseGroupInput {
  businessId: string;
  transactionGroupId: string;
  performedByUserId: string | null;
  source: OperationSource;
  reason: string;
  /** Defaults to the original group's location. */
  locationId?: string;
}

/**
 * Reverse a whole transaction group with compensating rows. Rejected when:
 *  - the group does not exist in this business;
 *  - the group is itself a reversal (reverse forward, never undo an undo);
 *  - the group was already reversed;
 *  - any resulting balance would go negative (e.g. the earned reward was already redeemed) —
 *    that case needs a manual correction, and the error says so.
 */
export async function reverseOperationGroup(input: ReverseGroupInput, db: DbClient = prisma): Promise<AppendResult> {
  if (!input.reason?.trim()) throw new ValidationError("A reversal requires a reason");

  return inTransaction(db, async (tx) => {
    const originals = await tx.loyaltyOperation.findMany({
      where: { transactionGroupId: input.transactionGroupId, businessId: input.businessId },
      orderBy: { createdAt: "asc" },
    });
    if (originals.length === 0) throw new NotFoundError("Transaction group not found");
    if (originals.some((o) => o.kind === OperationKind.REVERSAL || o.kind === OperationKind.INTEGRATION_REVERSAL)) {
      throw new ConflictError("A reversal cannot itself be reversed; write a new forward operation instead");
    }
    const already = await tx.loyaltyOperation.count({
      where: { reversalOfOperationId: { in: originals.map((o) => o.id) } },
    });
    if (already > 0) throw new ConflictError("This transaction group has already been reversed");

    const cardIds = new Set(originals.map((o) => o.customerCardId));
    if (cardIds.size !== 1) throw new LedgerInvariantError("Transaction group spans multiple cards");

    const compensating: OperationInput[] = [...originals].reverse().map((o) => ({
      kind: OperationKind.REVERSAL,
      unitType: o.unitType,
      quantity: -o.quantity,
      purchaseAmountMinor: o.purchaseAmountMinor == null ? null : -o.purchaseAmountMinor,
      monetaryDeltaMinor: o.monetaryDeltaMinor == null ? null : -o.monetaryDeltaMinor,
      redemptionValueMinor: o.redemptionValueMinor == null ? null : -o.redemptionValueMinor,
      rewardTierId: o.rewardTierId,
      reason: input.reason,
      reversalOfOperationId: o.id,
    }));

    try {
      return await appendOperationGroup(
        {
          businessId: input.businessId,
          customerCardId: originals[0].customerCardId,
          locationId: input.locationId ?? originals[0].locationId,
          performedByUserId: input.performedByUserId,
          source: input.source,
          operations: compensating,
        },
        tx,
      );
    } catch (e) {
      if (e instanceof LedgerInvariantError) {
        throw new LedgerInvariantError(
          `Cannot reverse group ${input.transactionGroupId}: ${e.message}. ` +
            "Dependent value was already consumed; apply a manual correction instead.",
        );
      }
      throw e;
    }
  });
}
