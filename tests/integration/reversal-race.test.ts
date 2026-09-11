import { OperationKind, OperationSource, UnitType } from "@prisma/client";
import { beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/db";
import { ConflictError } from "@/server/errors";
import { appendOperationGroup, reverseOperationGroup } from "@/server/ledger/ledger";
import { createBusinessWithCard, ownerActor, resetDatabase } from "../setup/fixtures";

describe("reversal race (remediation item 3)", () => {
  beforeAll(resetDatabase);

  it("CONCURRENT reversals of one group: exactly one succeeds, one compensating group exists, balances correct", async () => {
    const fx = await createBusinessWithCard();
    const actor = await ownerActor(fx);

    // A multi-row group so the "one reversal per original" property is exercised on several rows.
    const award = await appendOperationGroup({
      actor,
      customerCardId: fx.cardId,
      locationId: fx.locationId,
      operations: [
        { kind: OperationKind.MANUAL_AWARD, unitType: UnitType.STAMP, quantity: 3 },
        { kind: OperationKind.PURCHASE_AWARD, unitType: UnitType.STAMP, quantity: 2, purchaseAmountMinor: 20_000 },
      ],
    });
    // Independent later activity, so the card is not at zero and a duplicate reversal would NOT be
    // caught by the negative-balance rule. Only the lock + unique index can stop it.
    await appendOperationGroup({ actor, customerCardId: fx.cardId, locationId: fx.locationId, operations: [{ kind: OperationKind.MANUAL_AWARD, unitType: UnitType.STAMP, quantity: 10 }] });

    const N = 6;
    const results = await Promise.allSettled(
      Array.from({ length: N }, (_, i) =>
        reverseOperationGroup({ actor, transactionGroupId: award.transactionGroupId, reason: `race attempt ${i}` }),
      ),
    );

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(N - 1);
    for (const r of rejected) expect(r.reason).toBeInstanceOf(ConflictError);

    // Exactly one compensating group, containing exactly one row per original.
    const reversalRows = await prisma.loyaltyOperation.findMany({ where: { customerCardId: fx.cardId, kind: OperationKind.REVERSAL } });
    expect(reversalRows).toHaveLength(award.operations.length);
    expect(new Set(reversalRows.map((r) => r.transactionGroupId)).size).toBe(1);

    // Every original has AT MOST one reversal.
    const perOriginal = new Map<string, number>();
    for (const r of reversalRows) perOriginal.set(r.reversalOfOperationId!, (perOriginal.get(r.reversalOfOperationId!) ?? 0) + 1);
    for (const o of award.operations) expect(perOriginal.get(o.id)).toBe(1);

    // Projection = ledger: 5 awarded, 10 awarded, 5 reversed → 10.
    const card = await prisma.customerCard.findUniqueOrThrow({ where: { id: fx.cardId } });
    expect(card.stampBalance).toBe(10);
    const sum = await prisma.loyaltyOperation.aggregate({ where: { customerCardId: fx.cardId, unitType: UnitType.STAMP }, _sum: { quantity: true } });
    expect(sum._sum.quantity).toBe(10);
  });

  it("the database refuses a second reversal row for the same original even when written directly", async () => {
    const fx = await createBusinessWithCard();
    const actor = await ownerActor(fx);
    const award = await appendOperationGroup({ actor, customerCardId: fx.cardId, locationId: fx.locationId, operations: [{ kind: OperationKind.MANUAL_AWARD, unitType: UnitType.STAMP, quantity: 1 }] });
    await reverseOperationGroup({ actor, transactionGroupId: award.transactionGroupId, reason: "first" });

    const original = await prisma.loyaltyOperation.findUniqueOrThrow({ where: { id: award.operations[0].id } });
    // Bypass the service: attempt a raw duplicate compensating row. The partial unique index blocks it.
    await expect(
      prisma.loyaltyOperation.create({
        data: {
          transactionGroupId: "forged-group",
          businessId: original.businessId,
          locationId: original.locationId,
          customerId: original.customerId,
          customerBusinessProfileId: original.customerBusinessProfileId,
          customerCardId: original.customerCardId,
          templateId: original.templateId,
          programVersionId: original.programVersionId,
          kind: OperationKind.REVERSAL,
          unitType: UnitType.STAMP,
          quantity: -1,
          balanceAfter: 0,
          countsAsVisit: false,
          source: OperationSource.DASHBOARD,
          reason: "forged",
          reversalOfOperationId: original.id,
        },
      }),
    ).rejects.toThrow(/unique|reversalOfOperationId/i);
  });

  it("a reversal that would go negative is still rejected with manual-correction guidance (behaviour preserved)", async () => {
    const fx = await createBusinessWithCard();
    const actor = await ownerActor(fx);
    await appendOperationGroup({ actor, customerCardId: fx.cardId, locationId: fx.locationId, operations: [{ kind: OperationKind.MANUAL_AWARD, unitType: UnitType.STAMP, quantity: 10 }] });
    const conversion = await appendOperationGroup({
      actor,
      customerCardId: fx.cardId,
      locationId: fx.locationId,
      operations: [
        { kind: OperationKind.STAMP_CONVERTED, unitType: UnitType.STAMP, quantity: -10 },
        { kind: OperationKind.REWARD_EARNED, unitType: UnitType.REWARD, quantity: 1 },
      ],
    });
    await appendOperationGroup({ actor, customerCardId: fx.cardId, locationId: fx.locationId, operations: [{ kind: OperationKind.REWARD_REDEEMED, unitType: UnitType.REWARD, quantity: -1 }] });
    await expect(reverseOperationGroup({ actor, transactionGroupId: conversion.transactionGroupId, reason: "oops" })).rejects.toThrow(/manual correction/i);
  });
});
