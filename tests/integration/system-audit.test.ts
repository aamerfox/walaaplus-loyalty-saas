/**
 * Prompt 0.3 item 1 — a system ledger write is traceable.
 *
 * A member write records its own WHO in the ledger row (performedByUserId, location, source).
 * A system write has no signed-in staff member, so `SystemActor.reason` must survive: one
 * AuditLog row per system group, committed in the SAME transaction as the ledger rows, carrying
 * business, source, reason, the verified on-behalf-of user, the generated group id, the card and
 * the operation ids. `onBehalfOfUserId` is verified against BusinessMembership, so a caller
 * cannot attribute a platform write to someone in another business.
 */
import { randomUUID } from "node:crypto";
import { MembershipRole, OperationKind, OperationSource, UnitType } from "@prisma/client";
import { beforeAll, describe, expect, it } from "vitest";
import { AuditAction } from "@/server/audit/audit";
import { prisma } from "@/server/db";
import { ForbiddenError } from "@/server/errors";
import { runIdempotent } from "@/server/ledger/idempotency";
import { appendOperationGroup } from "@/server/ledger/ledger";
import type { SystemActor } from "@/server/ledger/actor";
import {
  createBusinessWithCard,
  createStaff,
  ownerActor,
  resetDatabase,
  systemActor,
  type CardFixture,
} from "../setup/fixtures";

const SYSTEM_ACTION = AuditAction.LEDGER_SYSTEM_GROUP_APPENDED;

function systemAudits(businessId: string) {
  return prisma.auditLog.findMany({ where: { businessId, action: SYSTEM_ACTION }, orderBy: { createdAt: "asc" } });
}

/** API and AUTOMATION awards must STATE visit intent; ENROLLMENT/SYSTEM/IMPORT follow policy and must not. */
const NEEDS_EXPLICIT_VISIT: ReadonlySet<OperationSource> = new Set([OperationSource.API, OperationSource.AUTOMATION]);

async function awardAs(fx: CardFixture, actor: SystemActor, quantity = 1) {
  return appendOperationGroup({
    actor,
    customerCardId: fx.cardId,
    locationId: fx.locationId,
    operations: [
      {
        kind: OperationKind.MANUAL_AWARD,
        unitType: UnitType.STAMP,
        quantity,
        ...(NEEDS_EXPLICIT_VISIT.has(actor.source) ? { countsAsVisit: false } : {}),
      },
    ],
  });
}

describe("system actor audit context", () => {
  let fx: CardFixture;
  let other: CardFixture;

  beforeAll(async () => {
    await resetDatabase();
    fx = await createBusinessWithCard();
    other = await createBusinessWithCard();
  });

  it("writes exactly one traceable audit record for a system group", async () => {
    const actor = systemActor(fx, OperationSource.AUTOMATION, "birthday-bonus job run 2026-09-11");
    const result = await awardAs(fx, actor, 2);

    const audits = await systemAudits(fx.businessId);
    expect(audits).toHaveLength(1);
    const a = audits[0];

    expect(a.action).toBe(SYSTEM_ACTION);
    expect(a.entityType).toBe("LoyaltyOperationGroup");
    expect(a.entityId).toBe(result.transactionGroupId);
    expect(a.businessId).toBe(fx.businessId);
    expect(a.actorUserId).toBeNull(); // no on-behalf-of user was named
    expect(a.createdAt).toBeInstanceOf(Date);

    const meta = a.metadata as Record<string, unknown>;
    expect(meta.source).toBe(OperationSource.AUTOMATION);
    expect(meta.reason).toBe("birthday-bonus job run 2026-09-11");
    expect(meta.customerCardId).toBe(fx.cardId);
    expect(meta.locationId).toBe(fx.locationId);
    expect(meta.operationCount).toBe(1);
    expect(meta.operationIds).toEqual(result.operations.map((o) => o.id));

    // The audit row points at rows that really exist, in the same business.
    const rows = await prisma.loyaltyOperation.findMany({ where: { transactionGroupId: result.transactionGroupId } });
    expect(rows.map((r) => r.id).sort()).toEqual((meta.operationIds as string[]).slice().sort());
    expect(rows.every((r) => r.businessId === fx.businessId)).toBe(true);
  });

  it("records a multi-row group as one audit record listing every operation", async () => {
    const before = (await systemAudits(fx.businessId)).length;
    const result = await appendOperationGroup({
      actor: systemActor(fx, OperationSource.IMPORT, "legacy import batch 7"),
      customerCardId: fx.cardId,
      locationId: fx.locationId,
      operations: [
        { kind: OperationKind.IMPORT_ADJUSTMENT, unitType: UnitType.STAMP, quantity: 3, reason: "opening balance" },
        { kind: OperationKind.IMPORT_ADJUSTMENT, unitType: UnitType.POINT, quantity: 50, reason: "opening balance" },
      ],
    });
    const audits = await systemAudits(fx.businessId);
    expect(audits).toHaveLength(before + 1);
    const meta = audits[audits.length - 1].metadata as Record<string, unknown>;
    expect(meta.operationCount).toBe(2);
    expect(meta.operationIds).toHaveLength(2);
    expect(meta.reason).toBe("legacy import batch 7");
    expect(audits[audits.length - 1].entityId).toBe(result.transactionGroupId);
  });

  it("an idempotent retry creates no second ledger group and no second audit record", async () => {
    const key = `sys-${randomUUID()}`;
    const payload = { card: fx.cardId, bonus: 1 };
    const actor = systemActor(fx, OperationSource.AUTOMATION, "retry-safe job");

    const run = () =>
      runIdempotent({
        businessId: fx.businessId,
        key,
        payload,
        execute: async (tx) => {
          const r = await appendOperationGroup(
            {
              actor,
              customerCardId: fx.cardId,
              locationId: fx.locationId,
              operations: [{ kind: OperationKind.MANUAL_AWARD, unitType: UnitType.STAMP, quantity: 1, countsAsVisit: false }],
            },
            tx,
          );
          return { result: { transactionGroupId: r.transactionGroupId }, transactionGroupId: r.transactionGroupId };
        },
      });

    const auditsBefore = (await systemAudits(fx.businessId)).length;
    const first = await run();
    expect(first.replayed).toBe(false);
    const groupId = first.result.transactionGroupId;
    const opsAfterFirst = await prisma.loyaltyOperation.count({ where: { transactionGroupId: groupId } });

    const second = await run();
    expect(second.replayed).toBe(true);
    expect(second.result.transactionGroupId).toBe(groupId);

    expect(await prisma.loyaltyOperation.count({ where: { transactionGroupId: groupId } })).toBe(opsAfterFirst);
    const auditsAfter = await systemAudits(fx.businessId);
    expect(auditsAfter).toHaveLength(auditsBefore + 1);
    expect(auditsAfter.filter((a) => a.entityId === groupId)).toHaveLength(1);
  });

  it("member scanner and dashboard writes create no system audit event", async () => {
    const before = (await systemAudits(fx.businessId)).length;
    for (const source of [OperationSource.SCANNER, OperationSource.DASHBOARD] as const) {
      await appendOperationGroup({
        actor: await ownerActor(fx, source),
        customerCardId: fx.cardId,
        locationId: fx.locationId,
        operations: [{ kind: OperationKind.MANUAL_AWARD, unitType: UnitType.STAMP, quantity: 1 }],
      });
    }
    expect(await systemAudits(fx.businessId)).toHaveLength(before);
  });

  describe("on-behalf-of attribution is verified", () => {
    it("accepts an active member of the same business and records them", async () => {
      const manager = await createStaff(fx, MembershipRole.MANAGER, []);
      const result = await awardAs(fx, {
        ...systemActor(fx, OperationSource.IMPORT, "dashboard-triggered import"),
        onBehalfOfUserId: manager.userId,
      });

      const audit = await prisma.auditLog.findFirstOrThrow({ where: { entityId: result.transactionGroupId, action: SYSTEM_ACTION } });
      expect(audit.actorUserId).toBe(manager.userId);
      const rows = await prisma.loyaltyOperation.findMany({ where: { transactionGroupId: result.transactionGroupId } });
      expect(rows.every((r) => r.performedByUserId === manager.userId)).toBe(true);
    });

    it("rejects a user from ANOTHER business and writes nothing", async () => {
      const opsBefore = await prisma.loyaltyOperation.count({ where: { businessId: fx.businessId } });
      const auditsBefore = (await systemAudits(fx.businessId)).length;

      await expect(
        awardAs(fx, { ...systemActor(fx, OperationSource.API, "cross-tenant attempt"), onBehalfOfUserId: other.userId }),
      ).rejects.toBeInstanceOf(ForbiddenError);

      expect(await prisma.loyaltyOperation.count({ where: { businessId: fx.businessId } })).toBe(opsBefore);
      expect(await systemAudits(fx.businessId)).toHaveLength(auditsBefore);
      expect(await prisma.loyaltyOperation.count({ where: { performedByUserId: other.userId } })).toBe(0);
    });

    it("rejects an unknown user id and a deactivated member, writing nothing", async () => {
      const opsBefore = await prisma.loyaltyOperation.count({ where: { businessId: fx.businessId } });

      await expect(
        awardAs(fx, { ...systemActor(fx, OperationSource.API, "unknown user"), onBehalfOfUserId: randomUUID() }),
      ).rejects.toBeInstanceOf(ForbiddenError);

      const staff = await createStaff(fx, MembershipRole.CASHIER, [fx.locationId]);
      await prisma.businessMembership.update({ where: { id: staff.membershipId }, data: { active: false } });
      await expect(
        awardAs(fx, { ...systemActor(fx, OperationSource.API, "deactivated member"), onBehalfOfUserId: staff.userId }),
      ).rejects.toBeInstanceOf(ForbiddenError);

      expect(await prisma.loyaltyOperation.count({ where: { businessId: fx.businessId } })).toBe(opsBefore);
    });
  });

  it("stores no credentials or oversized free text in the audit metadata", async () => {
    const result = await awardAs(fx, systemActor(fx, OperationSource.SYSTEM, "x".repeat(900)));
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { entityId: result.transactionGroupId, action: SYSTEM_ACTION } });
    const meta = audit.metadata as Record<string, unknown>;
    expect((meta.reason as string).length).toBe(500); // bounded
    expect(Object.keys(meta).sort()).toEqual([
      "customerCardId",
      "locationId",
      "operationCount",
      "operationIds",
      "reason",
      "source",
    ]);
    expect(JSON.stringify(meta)).not.toMatch(/password|secret|token|hash/i);
  });
});
