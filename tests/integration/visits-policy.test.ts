import { OperationKind, OperationSource, UnitType } from "@prisma/client";
import { beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/db";
import { ValidationError } from "@/server/errors";
import { appendOperationGroup } from "@/server/ledger/ledger";
import { createBusinessWithCard, ownerActor, resetDatabase, systemActor, type CardFixture } from "../setup/fixtures";

/** End-to-end proof that the stored countsAsVisit follows kind × source × version × explicit intent. */
describe("countsAsVisit stored on the ledger (remediation item 5)", () => {
  let fx: CardFixture;
  beforeAll(async () => {
    await resetDatabase();
    fx = await createBusinessWithCard({ mechanics: { countRewardRedemptionAsVisit: false } });
  });

  const stampAward = (extra: Partial<{ countsAsVisit: boolean; kind: OperationKind }> = {}) => [
    { kind: extra.kind ?? OperationKind.MANUAL_AWARD, unitType: UnitType.STAMP, quantity: 1, countsAsVisit: extra.countsAsVisit },
  ];

  it("scanner and dashboard awards are visits; an explicit flag is refused and nothing is written", async () => {
    for (const source of [OperationSource.SCANNER, OperationSource.DASHBOARD] as const) {
      const r = await appendOperationGroup({ actor: await ownerActor(fx, source), customerCardId: fx.cardId, locationId: fx.locationId, operations: stampAward() });
      expect(r.operations[0].countsAsVisit).toBe(true);
      const row = await prisma.loyaltyOperation.findUniqueOrThrow({ where: { id: r.operations[0].id } });
      expect(row.countsAsVisit).toBe(true);
    }
    const before = await prisma.loyaltyOperation.count({ where: { customerCardId: fx.cardId } });
    await expect(
      appendOperationGroup({ actor: await ownerActor(fx), customerCardId: fx.cardId, locationId: fx.locationId, operations: stampAward({ countsAsVisit: false }) }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(await prisma.loyaltyOperation.count({ where: { customerCardId: fx.cardId } })).toBe(before);
  });

  it("API and automation awards must state intent; the stated value is what gets stored", async () => {
    for (const source of [OperationSource.API, OperationSource.AUTOMATION] as const) {
      const actor = systemActor(fx, source, `${source} test`);
      await expect(appendOperationGroup({ actor, customerCardId: fx.cardId, locationId: fx.locationId, operations: stampAward() })).rejects.toThrow(/explicitly/);

      const yes = await appendOperationGroup({ actor, customerCardId: fx.cardId, locationId: fx.locationId, operations: stampAward({ countsAsVisit: true }) });
      const no = await appendOperationGroup({ actor, customerCardId: fx.cardId, locationId: fx.locationId, operations: stampAward({ countsAsVisit: false }) });
      expect((await prisma.loyaltyOperation.findUniqueOrThrow({ where: { id: yes.operations[0].id } })).countsAsVisit).toBe(true);
      expect((await prisma.loyaltyOperation.findUniqueOrThrow({ where: { id: no.operations[0].id } })).countsAsVisit).toBe(false);
    }
  });

  it("integration actions never become visits implicitly", async () => {
    const actor = systemActor(fx, OperationSource.API, "POS webhook");
    await expect(
      appendOperationGroup({ actor, customerCardId: fx.cardId, locationId: fx.locationId, operations: stampAward({ kind: OperationKind.INTEGRATION_AWARD }) }),
    ).rejects.toThrow(/explicitly/);
    const r = await appendOperationGroup({
      actor,
      customerCardId: fx.cardId,
      locationId: fx.locationId,
      operations: [{ kind: OperationKind.INTEGRATION_AWARD, unitType: UnitType.STAMP, quantity: 1, countsAsVisit: true, externalProvider: "pos", externalEventId: `evt-${Date.now()}` }],
    });
    expect(r.operations[0].countsAsVisit).toBe(true);
  });

  it("platform-originated awards (system, import, enrollment) are not visits", async () => {
    for (const source of [OperationSource.SYSTEM, OperationSource.IMPORT, OperationSource.ENROLLMENT] as const) {
      const r = await appendOperationGroup({ actor: systemActor(fx, source), customerCardId: fx.cardId, locationId: fx.locationId, operations: stampAward() });
      expect(r.operations[0].countsAsVisit).toBe(false);
    }
  });

  it("bonuses and conversions are never visits; redemptions follow the pinned version setting", async () => {
    const off = fx;
    const on = await createBusinessWithCard({ mechanics: { countRewardRedemptionAsVisit: true } });
    for (const f of [off, on]) {
      const r = await appendOperationGroup({
        actor: systemActor(f, OperationSource.ENROLLMENT, "enrol"),
        customerCardId: f.cardId,
        locationId: f.locationId,
        operations: [
          { kind: OperationKind.WELCOME_BONUS, unitType: UnitType.STAMP, quantity: 2 },
          { kind: OperationKind.REWARD_EARNED, unitType: UnitType.REWARD, quantity: 1 },
        ],
      });
      expect(r.operations.map((o) => o.countsAsVisit)).toEqual([false, false]);
      const redeem = await appendOperationGroup({
        actor: await ownerActor(f),
        customerCardId: f.cardId,
        locationId: f.locationId,
        operations: [{ kind: OperationKind.REWARD_REDEEMED, unitType: UnitType.REWARD, quantity: -1 }],
      });
      expect(redeem.operations[0].countsAsVisit).toBe(f === on);
    }
    // explicit flag on a redemption is refused
    await expect(
      appendOperationGroup({ actor: await ownerActor(on), customerCardId: on.cardId, locationId: on.locationId, operations: [{ kind: OperationKind.REWARD_REDEEMED, unitType: UnitType.REWARD, quantity: -1, countsAsVisit: false }] }),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});
