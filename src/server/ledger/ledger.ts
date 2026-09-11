import { randomUUID } from "node:crypto";
import { OperationKind, Prisma, UnitType, type CardStatus, type PrismaClient } from "@prisma/client";
import { AuditAction, recordAudit } from "../audit/audit";
import { prisma, type DbClient, type Tx } from "../db";
import { ConflictCode, ConflictError, ForbiddenError, LedgerInvariantError, NotFoundError, ValidationError } from "../errors";
import { requireLocationAccess } from "../tenant/context";
import { actorBusinessId, actorUserId, assertMemberMayWrite, systemReason, validateActor, type LedgerActor } from "./actor";
import type { AppendResult, AppendedOperation, Balances, OperationGroupInput, OperationInput } from "./types";
import { readVisitRules, resolveCountsAsVisit } from "./visits";

/**
 * The ONLY code path that writes LoyaltyOperation rows.
 *
 * Guarantees (docs/PRODUCT-SPEC.md §2.1–2.6):
 *  - business and acting user are DERIVED from a verified actor, never accepted from the caller;
 *  - member actors are checked for the permission each operation kind requires and for access
 *    to the location, inside the same transaction as the write;
 *  - every group commits in one transaction, or not at all;
 *  - the card row is locked with SELECT … FOR UPDATE, so concurrent groups on the same card
 *    serialise and every balanceAfter is exact;
 *  - balances never go negative;
 *  - card balance columns are updated from the same computation that produced balanceAfter;
 *  - countsAsVisit is resolved here, once, and frozen;
 *  - reversals are new compensating rows, never mutations.
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

/**
 * Run `fn` inside `db` if it is already a transaction, otherwise open one.
 *
 * `maxWait` is how long a caller waits for a free connection before the write FAILS. Prisma's
 * default is 2 s, which is short for this workload: a busy branch at closing time, or a queue of
 * scans landing on one card, makes writes queue behind the row lock by design. A burst should
 * wait and then succeed, not error — the customer is standing at the counter. 10 s is still well
 * inside the 15 s statement timeout, so a genuinely stuck transaction still fails loudly.
 */
async function inTransaction<T>(db: DbClient, fn: (tx: Tx) => Promise<T>): Promise<T> {
  if (isRootClient(db)) {
    return db.$transaction(fn, {
      isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
      timeout: 15_000,
      maxWait: 10_000,
    });
  }
  return fn(db);
}

function validateOperations(actor: LedgerActor, ops: OperationInput[]): void {
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
    // Permission per kind for staff; system-only kinds are refused for members.
    assertMemberMayWrite(actor, op.kind);
  }
}

/** Lock the card row. Tenant-scoped: a foreign card id is simply "not found". */
async function lockCard(tx: Tx, businessId: string, customerCardId: string): Promise<LockedCard> {
  const rows = await tx.$queryRaw<LockedCard[]>`
    SELECT id, "businessId", "templateId", "programVersionId", "customerBusinessProfileId", status,
           "stampBalance", "pointBalance", "rewardBalance", "cashBalanceMinor", "visitBalance"
    FROM "CustomerCard"
    WHERE id = ${customerCardId} AND "businessId" = ${businessId}
    FOR UPDATE`;
  const card = rows[0];
  if (!card) throw new NotFoundError("Card not found");
  if (card.status === "DELETED") throw new ConflictError("Card is deleted");
  return card;
}

/**
 * Append one atomic group of operations to a card's ledger and refresh its balance projections.
 */
export async function appendOperationGroup(input: OperationGroupInput, db: DbClient = prisma): Promise<AppendResult> {
  // The group id is the ledger's to mint. TypeScript removes the field from the contract; this
  // rejects an untyped JavaScript caller that supplies it anyway, rather than ignoring it silently.
  if ("transactionGroupId" in input) {
    throw new ValidationError("transactionGroupId is generated by the ledger and cannot be supplied by the caller");
  }
  validateActor(input.actor);
  validateOperations(input.actor, input.operations);
  const businessId = actorBusinessId(input.actor);
  const performedByUserId = actorUserId(input.actor);

  return inTransaction(db, async (tx) => {
    // 1. Lock the card (tenant-scoped).
    const card = await lockCard(tx, businessId, input.customerCardId);

    // 2. Location: for members, requireLocationAccess checks BOTH that the location belongs to the
    //    business and that this member may operate there. For system actors, only tenant membership.
    if (input.actor.kind === "member") {
      await requireLocationAccess(tx, input.actor.ctx, input.locationId);
    } else {
      const loc = await tx.location.findFirst({
        where: { id: input.locationId, businessId, active: true },
        select: { id: true },
      });
      if (!loc) throw new NotFoundError("Location not found");

      // 2b. A system actor may name a user it acts for. VERIFY that user is an active member of
      //     THIS business before it is written to performedByUserId or the audit row — otherwise a
      //     caller could attribute a platform write to an unrelated person, in any tenant.
      if (performedByUserId) {
        const member = await tx.businessMembership.findFirst({
          where: { userId: performedByUserId, businessId, active: true, user: { active: true } },
          select: { id: true },
        });
        if (!member) throw new ForbiddenError("onBehalfOfUserId is not an active member of this business");
      }
    }

    // 3. Resolve related rows, all scoped to the same business.
    const [profile, version] = await Promise.all([
      tx.customerBusinessProfile.findFirst({
        where: { id: card.customerBusinessProfileId, businessId },
        select: { customerId: true },
      }),
      tx.programVersion.findFirst({
        where: { id: card.programVersionId, template: { businessId } },
        select: { mechanics: true },
      }),
    ]);
    if (!profile) throw new LedgerInvariantError("Card profile does not belong to this business");
    if (!version) throw new LedgerInvariantError("Card program version does not belong to this business");

    // 3b. Reward tiers must belong to the card's PINNED program version. Foreign business, foreign
    //     version, or unknown ids all produce the same generic error so nothing cross-tenant leaks.
    const tierIds = [...new Set(input.operations.map((o) => o.rewardTierId).filter((id): id is string => !!id))];
    if (tierIds.length > 0) {
      const found = await tx.rewardTier.count({ where: { id: { in: tierIds }, programVersionId: card.programVersionId } });
      if (found !== tierIds.length) throw new LedgerInvariantError("Reward tier does not belong to this card's program version");
    }

    const visitRules = readVisitRules(version.mechanics);

    // 4. Apply operations sequentially against the locked balances.
    const balances: Balances = {
      STAMP: card.stampBalance,
      POINT: card.pointBalance,
      REWARD: card.rewardBalance,
      CASH: card.cashBalanceMinor,
      VISIT: card.visitBalance,
    };
    // Server-generated, always. A reversal references the original group through
    // reversalOfOperationId on each row; the compensating GROUP still gets its own new id.
    const transactionGroupId = randomUUID();
    const appended: AppendedOperation[] = [];

    for (const op of input.operations) {
      // Policy validation first (bad input), then balance arithmetic (state invariant).
      // Frozen here, once: kind + source + version policy + explicit intent (where required).
      const countsAsVisit = resolveCountsAsVisit({
        kind: op.kind,
        source: input.actor.source,
        rules: visitRules,
        explicit: op.countsAsVisit,
      });

      const next = balances[op.unitType] + op.quantity;
      if (next < 0) {
        throw new LedgerInvariantError(
          `${op.kind} of ${op.quantity} ${op.unitType} would make the balance negative (${balances[op.unitType]} → ${next})`,
        );
      }
      balances[op.unitType] = next;

      const row = await tx.loyaltyOperation.create({
        data: {
          transactionGroupId,
          businessId,
          locationId: input.locationId,
          customerId: profile.customerId,
          customerBusinessProfileId: card.customerBusinessProfileId,
          customerCardId: card.id,
          templateId: card.templateId,
          programVersionId: card.programVersionId,
          performedByUserId,
          rewardTierId: op.rewardTierId ?? null,
          kind: op.kind,
          unitType: op.unitType,
          quantity: op.quantity,
          purchaseAmountMinor: op.purchaseAmountMinor ?? null,
          monetaryDeltaMinor: op.monetaryDeltaMinor ?? null,
          redemptionValueMinor: op.redemptionValueMinor ?? null,
          balanceAfter: next,
          countsAsVisit,
          source: input.actor.source,
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

    // 5. Refresh projections from the very numbers written to the ledger.
    const projection: Record<string, number | Date> = { lastActivityAt: new Date() };
    for (const unit of ALL_UNITS) projection[UNIT_COLUMN[unit]] = balances[unit];
    await tx.customerCard.update({ where: { id: card.id }, data: projection });

    // 6. A system write has no signed-in staff member behind it, so the WHY lives in one audit row
    //    committed with the ledger rows. Member writes need none: the ledger itself records the
    //    acting user, the location and the source. A retried request replays its stored response
    //    without re-executing (idempotency.ts), so no second audit row is ever written.
    if (input.actor.kind === "system") {
      await recordAudit(tx, {
        action: AuditAction.LEDGER_SYSTEM_GROUP_APPENDED,
        entityType: "LoyaltyOperationGroup",
        entityId: transactionGroupId,
        businessId,
        actorUserId: performedByUserId, // verified member, or null
        metadata: {
          source: input.actor.source,
          reason: systemReason(input.actor),
          customerCardId: card.id,
          locationId: input.locationId,
          operationIds: appended.map((o) => o.id),
          operationCount: appended.length,
        },
      });
    }

    return { transactionGroupId, customerCardId: card.id, operations: appended, balances };
  });
}

export interface ReverseGroupInput {
  actor: LedgerActor;
  transactionGroupId: string;
  reason: string;
  /** Defaults to the original group's location. Members must have access to it. */
  locationId?: string;
}

/**
 * Reverse a whole transaction group with compensating rows. Rejected when:
 *  - the group does not exist in the actor's business;
 *  - the group is itself a reversal (reverse forward, never undo an undo);
 *  - the group was already reversed;
 *  - any resulting balance would go negative (e.g. the earned reward was already redeemed) —
 *    that case needs a manual correction, and the error says so.
 */
export async function reverseOperationGroup(input: ReverseGroupInput, db: DbClient = prisma): Promise<AppendResult> {
  validateActor(input.actor);
  if (!input.reason?.trim()) throw new ValidationError("A reversal requires a reason");
  const businessId = actorBusinessId(input.actor);

  return inTransaction(db, async (tx) => {
    // 1. Find the card the group belongs to (tenant-scoped, no lock yet).
    const probe = await tx.loyaltyOperation.findFirst({
      where: { transactionGroupId: input.transactionGroupId, businessId },
      select: { customerCardId: true },
    });
    if (!probe) throw new NotFoundError("Transaction group not found");

    // 2. LOCK THE CARD FIRST. Every reversal of any group on this card now serialises here, so the
    //    "already reversed" check below cannot race with a concurrent reversal of the same group.
    await lockCard(tx, businessId, probe.customerCardId);

    // 3. Re-read the group under the lock.
    const originals = await tx.loyaltyOperation.findMany({
      where: { transactionGroupId: input.transactionGroupId, businessId },
      orderBy: { createdAt: "asc" },
    });
    if (originals.some((o) => o.kind === OperationKind.REVERSAL || o.kind === OperationKind.INTEGRATION_REVERSAL)) {
      throw new ConflictError("A reversal cannot itself be reversed; write a new forward operation instead");
    }
    const cardIds = new Set(originals.map((o) => o.customerCardId));
    if (cardIds.size !== 1) throw new LedgerInvariantError("Transaction group spans multiple cards");

    const already = await tx.loyaltyOperation.count({
      where: { reversalOfOperationId: { in: originals.map((o) => o.id) } },
    });
    if (already > 0) throw new ConflictError("This transaction group has already been reversed", ConflictCode.ALREADY_REVERSED);

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
          actor: input.actor,
          customerCardId: originals[0].customerCardId,
          locationId: input.locationId ?? originals[0].locationId,
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
      // Database-level backstop: the partial unique index on reversalOfOperationId refuses a
      // second reversal row for the same original even if the check above were ever bypassed.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
        throw new ConflictError("This transaction group has already been reversed", ConflictCode.ALREADY_REVERSED);
      }
      throw e;
    }
  });
}
