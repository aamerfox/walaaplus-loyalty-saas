import { OperationKind, OperationSource, UnitType } from "@prisma/client";
import { beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/db";
import { ConflictError, LedgerInvariantError, NotFoundError, ValidationError } from "@/server/errors";
import { appendOperationGroup, reverseOperationGroup } from "@/server/ledger/ledger";
import { createBusinessWithCard, ownerActor, resetDatabase, systemActor, type CardFixture } from "../setup/fixtures";

/** Owner acting through the scanner at the fixture's Main location. */
async function asOwner(fx: CardFixture) {
  return { actor: await ownerActor(fx), customerCardId: fx.cardId, locationId: fx.locationId };
}

describe("ledger engine", () => {
  beforeAll(resetDatabase);

  it("appends a group atomically, snapshots balanceAfter per row and refreshes projections", async () => {
    const fx = await createBusinessWithCard();
    const r = await appendOperationGroup({
      ...(await asOwner(fx)),
      operations: [
        { kind: OperationKind.MANUAL_AWARD, unitType: UnitType.STAMP, quantity: 3, comment: "staff" },
        { kind: OperationKind.PURCHASE_AWARD, unitType: UnitType.STAMP, quantity: 2, purchaseAmountMinor: 25_000 },
      ],
    });

    expect(r.operations.map((o) => o.balanceAfter)).toEqual([3, 5]);
    expect(r.operations.every((o) => o.countsAsVisit)).toBe(true);
    expect(r.balances.STAMP).toBe(5);

    const rows = await prisma.loyaltyOperation.findMany({ where: { customerCardId: fx.cardId }, orderBy: { createdAt: "asc" } });
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((o) => o.transactionGroupId)).size).toBe(1);
    expect(rows.every((o) => o.locationId === fx.locationId && o.performedByUserId === fx.userId)).toBe(true);
    expect(rows.every((o) => o.customerId === fx.customerId && o.programVersionId === fx.programVersionId)).toBe(true);
    expect(rows.every((o) => o.source === OperationSource.SCANNER)).toBe(true);
    expect(rows[1].purchaseAmountMinor).toBe(25_000);

    const card = await prisma.customerCard.findUniqueOrThrow({ where: { id: fx.cardId } });
    expect(card.stampBalance).toBe(5);
    expect(card.lastActivityAt).not.toBeNull();
  });

  it("freezes countsAsVisit per kind and honours the version setting for redemptions", async () => {
    const off = await createBusinessWithCard({ mechanics: { countRewardRedemptionAsVisit: false } });
    const on = await createBusinessWithCard({ mechanics: { countRewardRedemptionAsVisit: true } });

    for (const fx of [off, on]) {
      const r = await appendOperationGroup({
        actor: systemActor(fx, OperationSource.ENROLLMENT, "enrollment flow"),
        customerCardId: fx.cardId,
        locationId: fx.locationId,
        operations: [
          { kind: OperationKind.CARD_ISSUED, unitType: UnitType.STAMP, quantity: 1 },
          { kind: OperationKind.WELCOME_BONUS, unitType: UnitType.STAMP, quantity: 2 },
          { kind: OperationKind.REWARD_EARNED, unitType: UnitType.REWARD, quantity: 1 },
        ],
      });
      const byKind = Object.fromEntries(r.operations.map((o) => [o.kind, o.countsAsVisit]));
      expect(byKind.CARD_ISSUED).toBe(false);
      expect(byKind.WELCOME_BONUS).toBe(false);
      expect(byKind.REWARD_EARNED).toBe(false);

      const redeem = await appendOperationGroup({
        ...(await asOwner(fx)),
        operations: [{ kind: OperationKind.REWARD_REDEEMED, unitType: UnitType.REWARD, quantity: -1, redemptionValueMinor: 15_000 }],
      });
      expect(redeem.operations[0].countsAsVisit).toBe(fx === on);

      const rows = await prisma.loyaltyOperation.findMany({ where: { customerCardId: fx.cardId, kind: { in: ["CARD_ISSUED", "WELCOME_BONUS"] } } });
      expect(rows.every((o) => o.performedByUserId === null && o.source === OperationSource.ENROLLMENT)).toBe(true);
    }
  });

  it("rejects a group that would drive any balance negative and writes NOTHING", async () => {
    const fx = await createBusinessWithCard();
    await expect(
      appendOperationGroup({
        ...(await asOwner(fx)),
        operations: [
          { kind: OperationKind.MANUAL_AWARD, unitType: UnitType.STAMP, quantity: 4 }, // valid
          { kind: OperationKind.REWARD_REDEEMED, unitType: UnitType.REWARD, quantity: -1 }, // no rewards yet
        ],
      }),
    ).rejects.toBeInstanceOf(LedgerInvariantError);

    expect(await prisma.loyaltyOperation.count({ where: { customerCardId: fx.cardId } })).toBe(0);
    const card = await prisma.customerCard.findUniqueOrThrow({ where: { id: fx.cardId } });
    expect(card.stampBalance).toBe(0);
  });

  it("is tenant-scoped: another business cannot write to the card, nor use its location", async () => {
    const fx = await createBusinessWithCard();
    const other = await createBusinessWithCard();
    await expect(
      appendOperationGroup({
        actor: await ownerActor(other),
        customerCardId: fx.cardId,
        locationId: other.locationId,
        operations: [{ kind: OperationKind.MANUAL_AWARD, unitType: UnitType.STAMP, quantity: 1 }],
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      appendOperationGroup({
        actor: await ownerActor(fx),
        customerCardId: fx.cardId,
        locationId: other.locationId,
        operations: [{ kind: OperationKind.MANUAL_AWARD, unitType: UnitType.STAMP, quantity: 1 }],
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("validates input before touching the database", async () => {
    const fx = await createBusinessWithCard();
    const base = await asOwner(fx);
    await expect(appendOperationGroup({ ...base, operations: [] })).rejects.toBeInstanceOf(ValidationError);
    await expect(
      appendOperationGroup({ ...base, operations: [{ kind: OperationKind.MANUAL_AWARD, unitType: UnitType.STAMP, quantity: 0 }] }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      appendOperationGroup({ ...base, operations: [{ kind: OperationKind.MANUAL_AWARD, unitType: UnitType.STAMP, quantity: 1.5 }] }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      appendOperationGroup({
        actor: systemActor(fx, OperationSource.IMPORT),
        customerCardId: fx.cardId,
        locationId: fx.locationId,
        operations: [{ kind: OperationKind.IMPORT_ADJUSTMENT, unitType: UnitType.STAMP, quantity: 1 }], // reason missing
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("serialises CONCURRENT appends on the same card: exact balances, no lost updates", async () => {
    const fx = await createBusinessWithCard();
    const base = await asOwner(fx);
    const N = 25;
    await Promise.all(
      Array.from({ length: N }, () =>
        appendOperationGroup({ ...base, operations: [{ kind: OperationKind.VISIT_AWARD, unitType: UnitType.STAMP, quantity: 1 }] }),
      ),
    );
    const card = await prisma.customerCard.findUniqueOrThrow({ where: { id: fx.cardId } });
    expect(card.stampBalance).toBe(N);

    const rows = await prisma.loyaltyOperation.findMany({ where: { customerCardId: fx.cardId } });
    expect(rows).toHaveLength(N);
    // Every balanceAfter is distinct and forms exactly 1..N: proof the row lock serialised them.
    expect([...rows.map((r) => r.balanceAfter)].sort((a, b) => a - b)).toEqual(Array.from({ length: N }, (_, i) => i + 1));
  });

  describe("reversals", () => {
    it("reverses a group with compensating rows and leaves the originals untouched", async () => {
      const fx = await createBusinessWithCard();
      const base = await asOwner(fx);
      const award = await appendOperationGroup({
        ...base,
        operations: [{ kind: OperationKind.PURCHASE_AWARD, unitType: UnitType.STAMP, quantity: 5, purchaseAmountMinor: 50_000 }],
      });

      const rev = await reverseOperationGroup({ actor: base.actor, transactionGroupId: award.transactionGroupId, reason: "cashier tapped twice" });

      expect(rev.transactionGroupId).not.toBe(award.transactionGroupId);
      expect(rev.operations).toHaveLength(1);
      expect(rev.operations[0]).toMatchObject({ kind: OperationKind.REVERSAL, unitType: UnitType.STAMP, quantity: -5, balanceAfter: 0, countsAsVisit: false });

      const revRow = await prisma.loyaltyOperation.findUniqueOrThrow({ where: { id: rev.operations[0].id } });
      expect(revRow.reversalOfOperationId).toBe(award.operations[0].id);
      expect(revRow.reason).toBe("cashier tapped twice");
      expect(revRow.purchaseAmountMinor).toBe(-50_000);
      expect(revRow.performedByUserId).toBe(fx.userId);

      const original = await prisma.loyaltyOperation.findUniqueOrThrow({ where: { id: award.operations[0].id } });
      expect(original.quantity).toBe(5);

      const card = await prisma.customerCard.findUniqueOrThrow({ where: { id: fx.cardId } });
      expect(card.stampBalance).toBe(0);
    });

    it("refuses to reverse twice, or to reverse a reversal", async () => {
      const fx = await createBusinessWithCard();
      const base = await asOwner(fx);
      const award = await appendOperationGroup({ ...base, operations: [{ kind: OperationKind.MANUAL_AWARD, unitType: UnitType.STAMP, quantity: 1 }] });
      const rev = await reverseOperationGroup({ actor: base.actor, transactionGroupId: award.transactionGroupId, reason: "r" });

      await expect(reverseOperationGroup({ actor: base.actor, transactionGroupId: award.transactionGroupId, reason: "again" })).rejects.toBeInstanceOf(ConflictError);
      await expect(reverseOperationGroup({ actor: base.actor, transactionGroupId: rev.transactionGroupId, reason: "undo undo" })).rejects.toBeInstanceOf(ConflictError);
    });

    it("rejects a reversal whose dependent value was already consumed and asks for manual correction", async () => {
      const fx = await createBusinessWithCard();
      const base = await asOwner(fx);
      await appendOperationGroup({ ...base, operations: [{ kind: OperationKind.MANUAL_AWARD, unitType: UnitType.STAMP, quantity: 10 }] });
      const conversion = await appendOperationGroup({
        ...base,
        operations: [
          { kind: OperationKind.STAMP_CONVERTED, unitType: UnitType.STAMP, quantity: -10 },
          { kind: OperationKind.REWARD_EARNED, unitType: UnitType.REWARD, quantity: 1 },
        ],
      });
      await appendOperationGroup({ ...base, operations: [{ kind: OperationKind.REWARD_REDEEMED, unitType: UnitType.REWARD, quantity: -1 }] });

      await expect(reverseOperationGroup({ actor: base.actor, transactionGroupId: conversion.transactionGroupId, reason: "oops" })).rejects.toThrow(/manual correction/i);

      const card = await prisma.customerCard.findUniqueOrThrow({ where: { id: fx.cardId } });
      expect(card).toMatchObject({ stampBalance: 0, rewardBalance: 0 });
      expect(await prisma.loyaltyOperation.count({ where: { customerCardId: fx.cardId, kind: OperationKind.REVERSAL } })).toBe(0);
    });

    it("is tenant-scoped and requires a reason", async () => {
      const fx = await createBusinessWithCard();
      const base = await asOwner(fx);
      const award = await appendOperationGroup({ ...base, operations: [{ kind: OperationKind.MANUAL_AWARD, unitType: UnitType.STAMP, quantity: 1 }] });
      const other = await createBusinessWithCard();
      await expect(reverseOperationGroup({ actor: await ownerActor(other), transactionGroupId: award.transactionGroupId, reason: "x" })).rejects.toBeInstanceOf(NotFoundError);
      await expect(reverseOperationGroup({ actor: base.actor, transactionGroupId: award.transactionGroupId, reason: "  " })).rejects.toBeInstanceOf(ValidationError);
    });
  });
});
