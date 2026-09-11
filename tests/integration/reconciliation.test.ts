import { OperationKind, OperationSource, UnitType } from "@prisma/client";
import { beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/db";
import { appendOperationGroup } from "@/server/ledger/ledger";
import { reconcileCardBalances } from "@/server/ledger/reconciliation";
import { createBusinessWithCard, resetDatabase } from "../setup/fixtures";

describe("reconcileCardBalances", () => {
  beforeAll(resetDatabase);

  it("reports no mismatch for a healthy card and for a card with no operations", async () => {
    const fx = await createBusinessWithCard();
    await appendOperationGroup({
      businessId: fx.businessId,
      customerCardId: fx.cardId,
      locationId: fx.locationId,
      performedByUserId: fx.userId,
      source: OperationSource.SCANNER,
      operations: [
        { kind: OperationKind.MANUAL_AWARD, unitType: UnitType.STAMP, quantity: 4 },
        { kind: OperationKind.REWARD_EARNED, unitType: UnitType.REWARD, quantity: 1 },
      ],
    });
    const empty = await createBusinessWithCard();

    const report = await reconcileCardBalances();
    expect(report.checkedCards).toBeGreaterThanOrEqual(2);
    expect(report.mismatches).toEqual([]);

    const single = await reconcileCardBalances({ customerCardId: empty.cardId });
    expect(single.checkedCards).toBe(1);
    expect(single.mismatches).toEqual([]);
  });

  it("detects a deliberately corrupted projection and names the unit, card and business", async () => {
    const fx = await createBusinessWithCard();
    await appendOperationGroup({
      businessId: fx.businessId,
      customerCardId: fx.cardId,
      locationId: fx.locationId,
      performedByUserId: fx.userId,
      source: OperationSource.SCANNER,
      operations: [{ kind: OperationKind.MANUAL_AWARD, unitType: UnitType.STAMP, quantity: 7 }],
    });

    // Corrupt the projection directly. The ledger cannot be corrupted (trigger), only the cache can.
    await prisma.customerCard.update({ where: { id: fx.cardId }, data: { stampBalance: 999, rewardBalance: 2 } });

    const report = await reconcileCardBalances({ businessId: fx.businessId });
    expect(report.checkedCards).toBe(1);
    expect(report.mismatches).toEqual(
      expect.arrayContaining([
        { customerCardId: fx.cardId, businessId: fx.businessId, unitType: UnitType.STAMP, projected: 999, ledger: 7 },
        { customerCardId: fx.cardId, businessId: fx.businessId, unitType: UnitType.REWARD, projected: 2, ledger: 0 },
      ]),
    );
    expect(report.mismatches).toHaveLength(2);

    // Scoped to a different business: the corruption is not visible.
    const otherFx = await createBusinessWithCard();
    expect((await reconcileCardBalances({ businessId: otherFx.businessId })).mismatches).toEqual([]);
  });
});
