/**
 * Prompt 0.3 item 2 — the transaction group id belongs to the ledger, never to the caller.
 *
 * A caller that could choose `transactionGroupId` could merge unrelated writes into one atomic-
 * looking group, or attach rows to a group belonging to another card or business. The id is
 * therefore generated inside `appendOperationGroup` for every executed group; retries reuse the
 * ORIGINAL id through the idempotency record, and reversals reference the original group through
 * `reversalOfOperationId` on each row while the compensating group gets its own new id.
 */
import { randomUUID } from "node:crypto";
import { OperationKind, OperationSource, UnitType } from "@prisma/client";
import { beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/db";
import { ValidationError } from "@/server/errors";
import { runIdempotent } from "@/server/ledger/idempotency";
import { appendOperationGroup, reverseOperationGroup } from "@/server/ledger/ledger";
import type { OperationGroupInput } from "@/server/ledger/types";
import { createBusinessWithCard, ownerActor, resetDatabase, type CardFixture } from "../setup/fixtures";

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe("transactionGroupId is server-generated", () => {
  let fx: CardFixture;
  let award: (qty?: number) => Promise<{ transactionGroupId: string }>;

  beforeAll(async () => {
    await resetDatabase();
    fx = await createBusinessWithCard();
    award = async (qty = 1) =>
      appendOperationGroup({
        actor: await ownerActor(fx, OperationSource.DASHBOARD),
        customerCardId: fx.cardId,
        locationId: fx.locationId,
        operations: [{ kind: OperationKind.MANUAL_AWARD, unitType: UnitType.STAMP, quantity: qty }],
      });
  });

  it("generates a fresh UUID for every executed group", async () => {
    const a = await award();
    const b = await award();
    expect(a.transactionGroupId).toMatch(UUID_V4);
    expect(b.transactionGroupId).toMatch(UUID_V4);
    expect(a.transactionGroupId).not.toBe(b.transactionGroupId);
  });

  it("rejects a forged transactionGroupId from an untyped caller, writing nothing", async () => {
    const forged = randomUUID();
    const before = await prisma.loyaltyOperation.count();
    // Exactly what plain JavaScript (a route handler spreading a JSON body) could pass.
    const input = {
      actor: await ownerActor(fx, OperationSource.DASHBOARD),
      customerCardId: fx.cardId,
      locationId: fx.locationId,
      operations: [{ kind: OperationKind.MANUAL_AWARD, unitType: UnitType.STAMP, quantity: 1 }],
      transactionGroupId: forged,
    } as unknown as OperationGroupInput;

    await expect(appendOperationGroup(input)).rejects.toBeInstanceOf(ValidationError);
    await expect(appendOperationGroup(input)).rejects.toThrow(/cannot be supplied/i);
    expect(await prisma.loyaltyOperation.count()).toBe(before);
    expect(await prisma.loyaltyOperation.count({ where: { transactionGroupId: forged } })).toBe(0);
  });

  it("rejects it even when the supplied value is undefined or null", async () => {
    for (const value of [undefined, null]) {
      const input = { ...({} as OperationGroupInput), transactionGroupId: value } as unknown as OperationGroupInput;
      Object.assign(input, {
        actor: await ownerActor(fx, OperationSource.DASHBOARD),
        customerCardId: fx.cardId,
        locationId: fx.locationId,
        operations: [{ kind: OperationKind.MANUAL_AWARD, unitType: UnitType.STAMP, quantity: 1 }],
      });
      await expect(appendOperationGroup(input)).rejects.toBeInstanceOf(ValidationError);
    }
  });

  it("two separately executed writes cannot be forced into one group", async () => {
    const a = await award();
    const b = await award();
    const rowsA = await prisma.loyaltyOperation.findMany({ where: { transactionGroupId: a.transactionGroupId } });
    const rowsB = await prisma.loyaltyOperation.findMany({ where: { transactionGroupId: b.transactionGroupId } });
    expect(rowsA).toHaveLength(1);
    expect(rowsB).toHaveLength(1);
    expect(rowsA[0].id).not.toBe(rowsB[0].id);
  });

  it("an idempotent retry returns the original generated id and writes no new rows", async () => {
    const key = `group-${randomUUID()}`;
    const payload = { cardId: fx.cardId, quantity: 3 };
    const actor = await ownerActor(fx, OperationSource.DASHBOARD);

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
              operations: [{ kind: OperationKind.MANUAL_AWARD, unitType: UnitType.STAMP, quantity: 3 }],
            },
            tx,
          );
          return { result: { transactionGroupId: r.transactionGroupId }, transactionGroupId: r.transactionGroupId };
        },
      });

    const first = await run();
    expect(first.replayed).toBe(false);
    const groupId = first.result.transactionGroupId;
    const afterFirst = await prisma.loyaltyOperation.count();

    const second = await run();
    expect(second.replayed).toBe(true);
    expect(second.result.transactionGroupId).toBe(groupId);
    expect(await prisma.loyaltyOperation.count()).toBe(afterFirst);
    expect(await prisma.loyaltyOperation.count({ where: { transactionGroupId: groupId } })).toBe(1);

    const record = await prisma.idempotencyRecord.findUniqueOrThrow({
      where: { businessId_key: { businessId: fx.businessId, key } },
    });
    expect(record.transactionGroupId).toBe(groupId);
  });

  it("a reversal keeps the original reference but gets its own group id", async () => {
    const original = await award(5);
    const actor = await ownerActor(fx, OperationSource.DASHBOARD);
    const reversal = await reverseOperationGroup({
      actor,
      transactionGroupId: original.transactionGroupId,
      reason: "item 2 test",
    });

    expect(reversal.transactionGroupId).toMatch(UUID_V4);
    expect(reversal.transactionGroupId).not.toBe(original.transactionGroupId);

    const originals = await prisma.loyaltyOperation.findMany({ where: { transactionGroupId: original.transactionGroupId } });
    const compensating = await prisma.loyaltyOperation.findMany({ where: { transactionGroupId: reversal.transactionGroupId } });
    expect(compensating).toHaveLength(originals.length);
    // Every compensating row points back at exactly one original row of the reversed group.
    expect(new Set(compensating.map((c) => c.reversalOfOperationId))).toEqual(new Set(originals.map((o) => o.id)));
    // The original group's own rows are untouched and reference nothing.
    expect(originals.every((o) => o.reversalOfOperationId === null)).toBe(true);
  });
});
