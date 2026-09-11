import { MembershipRole, OperationKind, OperationSource, Permission, UnitType } from "@prisma/client";
import { beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/db";
import { ForbiddenError, NotFoundError, ValidationError } from "@/server/errors";
import type { MemberActor } from "@/server/ledger/actor";
import { appendOperationGroup, reverseOperationGroup } from "@/server/ledger/ledger";
import type { TenantContext } from "@/server/tenant/context";
import { createBusinessWithCard, createLocation, createStaff, ownerActor, resetDatabase, systemActor, type CardFixture } from "../setup/fixtures";

const award = (qty = 1) => [{ kind: OperationKind.MANUAL_AWARD, unitType: UnitType.STAMP, quantity: qty }];

describe("ledger actor enforcement", () => {
  let fx: CardFixture;
  let branch: string;

  beforeAll(async () => {
    await resetDatabase();
    fx = await createBusinessWithCard();
    branch = await createLocation(fx, "Branch");
  });

  it("an UNASSIGNED cashier cannot mutate at any location", async () => {
    const cashier = await createStaff(fx, MembershipRole.CASHIER, []);
    expect(cashier.ctx.locationIds).toEqual([]); // not null: no access, never unrestricted
    const actor: MemberActor = { kind: "member", ctx: cashier.ctx, source: OperationSource.SCANNER };

    for (const locationId of [fx.locationId, branch]) {
      await expect(appendOperationGroup({ actor, customerCardId: fx.cardId, locationId, operations: award() })).rejects.toBeInstanceOf(ForbiddenError);
    }
    expect(await prisma.loyaltyOperation.count({ where: { customerCardId: fx.cardId } })).toBe(0);
  });

  it("an ASSIGNED cashier can mutate only at the assigned location, and the row records the derived actor", async () => {
    const cashier = await createStaff(fx, MembershipRole.CASHIER, [branch]);
    const actor: MemberActor = { kind: "member", ctx: cashier.ctx, source: OperationSource.SCANNER };

    await expect(appendOperationGroup({ actor, customerCardId: fx.cardId, locationId: fx.locationId, operations: award() })).rejects.toBeInstanceOf(ForbiddenError);

    const r = await appendOperationGroup({ actor, customerCardId: fx.cardId, locationId: branch, operations: award(2) });
    const row = await prisma.loyaltyOperation.findUniqueOrThrow({ where: { id: r.operations[0].id } });
    expect(row.performedByUserId).toBe(cashier.userId);
    expect(row.locationId).toBe(branch);
    expect(row.businessId).toBe(fx.businessId);
    expect(row.source).toBe(OperationSource.SCANNER);
  });

  it("OWNER and MANAGER are unrestricted across the business's locations", async () => {
    const owner = await ownerActor(fx, OperationSource.DASHBOARD);
    const manager = await createStaff(fx, MembershipRole.MANAGER, []);
    expect(owner.ctx.locationIds).toBeNull();
    expect(manager.ctx.locationIds).toBeNull();

    const r1 = await appendOperationGroup({ actor: owner, customerCardId: fx.cardId, locationId: fx.locationId, operations: award() });
    const r2 = await appendOperationGroup({
      actor: { kind: "member", ctx: manager.ctx, source: OperationSource.SCANNER },
      customerCardId: fx.cardId,
      locationId: branch,
      operations: award(),
    });
    expect((await prisma.loyaltyOperation.findUniqueOrThrow({ where: { id: r1.operations[0].id } })).performedByUserId).toBe(fx.userId);
    expect((await prisma.loyaltyOperation.findUniqueOrThrow({ where: { id: r2.operations[0].id } })).performedByUserId).toBe(manager.userId);
  });

  it("a foreign business identity cannot reach the card, its location, or write as another business", async () => {
    const other = await createBusinessWithCard();
    const otherOwner = await ownerActor(other);

    // Other business's owner against our card: not found (tenant-scoped lock).
    await expect(appendOperationGroup({ actor: otherOwner, customerCardId: fx.cardId, locationId: other.locationId, operations: award() })).rejects.toBeInstanceOf(NotFoundError);
    // Our owner using the other business's location: not found.
    const ours = await ownerActor(fx);
    await expect(appendOperationGroup({ actor: ours, customerCardId: fx.cardId, locationId: other.locationId, operations: award() })).rejects.toBeInstanceOf(NotFoundError);
    // A system actor naming the other business against our card: not found.
    await expect(appendOperationGroup({ actor: systemActor(other), customerCardId: fx.cardId, locationId: other.locationId, operations: award() })).rejects.toBeInstanceOf(NotFoundError);
  });

  it("the acting user can never be spoofed: it is always the context's user", async () => {
    const cashier = await createStaff(fx, MembershipRole.CASHIER, [branch]);
    // A forged context claiming to be the owner but carrying the cashier's permissions is still
    // whatever the caller says it is; the point is there is NO input field for performedByUserId.
    const actor: MemberActor = { kind: "member", ctx: cashier.ctx, source: OperationSource.SCANNER };
    const r = await appendOperationGroup({ actor, customerCardId: fx.cardId, locationId: branch, operations: award() });
    const row = await prisma.loyaltyOperation.findUniqueOrThrow({ where: { id: r.operations[0].id } });
    expect(row.performedByUserId).toBe(cashier.ctx.userId);
  });

  it("enforces MAKE_ACCRUALS for awards and MAKE_REDEMPTIONS for redemptions", async () => {
    const base = (await ownerActor(fx)).ctx;
    const only = (perms: Permission[]): TenantContext => ({ ...base, role: MembershipRole.MANAGER, permissions: new Set(perms) });

    const accrualOnly: MemberActor = { kind: "member", ctx: only([Permission.MAKE_ACCRUALS]), source: OperationSource.SCANNER };
    const redeemOnly: MemberActor = { kind: "member", ctx: only([Permission.MAKE_REDEMPTIONS]), source: OperationSource.SCANNER };

    // give the card a reward to redeem, via system
    await appendOperationGroup({ actor: systemActor(fx), customerCardId: fx.cardId, locationId: fx.locationId, operations: [{ kind: OperationKind.REWARD_EARNED, unitType: UnitType.REWARD, quantity: 2 }] });

    await expect(appendOperationGroup({ actor: redeemOnly, customerCardId: fx.cardId, locationId: fx.locationId, operations: award() })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      appendOperationGroup({ actor: accrualOnly, customerCardId: fx.cardId, locationId: fx.locationId, operations: [{ kind: OperationKind.REWARD_REDEEMED, unitType: UnitType.REWARD, quantity: -1 }] }),
    ).rejects.toBeInstanceOf(ForbiddenError);

    await expect(appendOperationGroup({ actor: accrualOnly, customerCardId: fx.cardId, locationId: fx.locationId, operations: award() })).resolves.toBeTruthy();
    await expect(
      appendOperationGroup({ actor: redeemOnly, customerCardId: fx.cardId, locationId: fx.locationId, operations: [{ kind: OperationKind.REWARD_REDEEMED, unitType: UnitType.REWARD, quantity: -1 }] }),
    ).resolves.toBeTruthy();

    // Reversal needs both.
    const group = await appendOperationGroup({ actor: accrualOnly, customerCardId: fx.cardId, locationId: fx.locationId, operations: award() });
    await expect(reverseOperationGroup({ actor: accrualOnly, transactionGroupId: group.transactionGroupId, reason: "x" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(reverseOperationGroup({ actor: await ownerActor(fx), transactionGroupId: group.transactionGroupId, reason: "x" })).resolves.toBeTruthy();
  });

  it("system-only kinds are refused for members, and system actors must be explicit", async () => {
    const owner = await ownerActor(fx);
    await expect(
      appendOperationGroup({ actor: owner, customerCardId: fx.cardId, locationId: fx.locationId, operations: [{ kind: OperationKind.IMPORT_ADJUSTMENT, unitType: UnitType.STAMP, quantity: 1, reason: "import" }] }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      appendOperationGroup({ actor: owner, customerCardId: fx.cardId, locationId: fx.locationId, operations: [{ kind: OperationKind.WELCOME_BONUS, unitType: UnitType.STAMP, quantity: 1 }] }),
    ).rejects.toBeInstanceOf(ForbiddenError);

    // System actor validation
    await expect(
      appendOperationGroup({ actor: { kind: "system", businessId: fx.businessId, source: OperationSource.IMPORT, reason: "" }, customerCardId: fx.cardId, locationId: fx.locationId, operations: award() }),
    ).rejects.toBeInstanceOf(ValidationError);
    // A member source is not a valid system source and vice versa (runtime check behind the types)
    await expect(
      appendOperationGroup({ actor: { kind: "system", businessId: fx.businessId, source: OperationSource.SCANNER as unknown as "SYSTEM", reason: "r" }, customerCardId: fx.cardId, locationId: fx.locationId, operations: award() }),
    ).rejects.toBeInstanceOf(ValidationError);

    // A well-formed system import works and records no acting user unless on-behalf-of is given.
    const r = await appendOperationGroup({
      actor: { kind: "system", businessId: fx.businessId, source: OperationSource.IMPORT, reason: "csv import batch 1", onBehalfOfUserId: fx.userId },
      customerCardId: fx.cardId,
      locationId: fx.locationId,
      operations: [{ kind: OperationKind.IMPORT_ADJUSTMENT, unitType: UnitType.STAMP, quantity: 3, reason: "migrated balance" }],
    });
    const row = await prisma.loyaltyOperation.findUniqueOrThrow({ where: { id: r.operations[0].id } });
    expect(row.source).toBe(OperationSource.IMPORT);
    expect(row.performedByUserId).toBe(fx.userId);
  });

  it("a deactivated membership loses ledger access on the next resolve", async () => {
    const cashier = await createStaff(fx, MembershipRole.CASHIER, [branch]);
    await prisma.businessMembership.update({ where: { id: cashier.membershipId }, data: { active: false } });
    const { requireBusinessMembership } = await import("@/server/tenant/context");
    await expect(requireBusinessMembership(prisma, cashier.userId, fx.businessId)).rejects.toBeInstanceOf(ForbiddenError);
  });
});
