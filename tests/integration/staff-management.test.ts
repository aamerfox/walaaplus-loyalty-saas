import { MembershipRole, Permission } from "@prisma/client";
import { beforeAll, describe, expect, it } from "vitest";
import { AuditAction } from "@/server/audit/audit";
import { prisma } from "@/server/db";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "@/server/errors";
import { requireBusinessMembership } from "@/server/tenant/context";
import {
  addMembership,
  changeMembershipRole,
  deactivateMembership,
  listBusinessStaff,
  reactivateMembership,
  setMembershipLocations,
  setMembershipPermissions,
} from "@/server/tenant/memberships";
import { createLocation, createStaff, createStampCafe, registerTestOwner, resetDatabase, uniqueEmail } from "../setup/fixtures";

/**
 * Staff management, and the two escalation paths Phase 1b opens.
 *
 * Phase 1a could not be escalated because there was nothing to escalate WITH: the only staff
 * mutation was "owner creates a cashier". Phase 1b adds a permission editor, a role changer and
 * location assignment, and each of those is a lever. These tests hold the levers shut.
 */

async function userFor(businessId: string, role: MembershipRole = MembershipRole.CASHIER) {
  const user = await prisma.user.create({ data: { email: uniqueEmail("staff"), passwordHash: "x", firstName: role } });
  return user.id;
}

describe("least privilege", () => {
  beforeAll(async () => {
    await resetDatabase();
  });

  it("refuses a member editing their own membership, whatever their role", async () => {
    const cafe = await createStampCafe();
    const manager = await createStaff(cafe, MembershipRole.MANAGER, []);
    await setMembershipPermissions(cafe.ctx, manager.membershipId, [Permission.EDIT_STAFF]);
    const managerCtx = await requireBusinessMembership(prisma, manager.userId, cafe.businessId);

    for (const attempt of [
      () => setMembershipPermissions(managerCtx, manager.membershipId, [Permission.EDIT_STAFF, Permission.VIEW_BILLING]),
      () => changeMembershipRole(managerCtx, manager.membershipId, MembershipRole.OWNER),
      () => setMembershipLocations(managerCtx, manager.membershipId, [cafe.locationId]),
      () => deactivateMembership(managerCtx, manager.membershipId),
    ]) {
      await expect(attempt()).rejects.toBeInstanceOf(ForbiddenError);
    }

    // And the owner may not edit their own either: an owner who removes their own last permission
    // locks the business out of its own account.
    const ownerMembership = await prisma.businessMembership.findFirstOrThrow({
      where: { businessId: cafe.businessId, userId: cafe.userId },
      select: { id: true },
    });
    await expect(deactivateMembership(cafe.ctx, ownerMembership.id)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("refuses granting a permission the granter does not hold", async () => {
    const cafe = await createStampCafe();
    const manager = await createStaff(cafe, MembershipRole.MANAGER, []);
    await setMembershipPermissions(cafe.ctx, manager.membershipId, [Permission.EDIT_STAFF]);
    const managerCtx = await requireBusinessMembership(prisma, manager.userId, cafe.businessId);
    expect(managerCtx.permissions.has(Permission.EDIT_BILLING)).toBe(false);

    const cashier = await createStaff(cafe, MembershipRole.CASHIER, [cafe.locationId]);

    // Escalation by proxy: give it to someone else and act through them.
    const failed = await setMembershipPermissions(managerCtx, cashier.membershipId, [Permission.EDIT_BILLING]).catch(
      (e: unknown) => e,
    );
    expect(failed).toBeInstanceOf(ForbiddenError);
    expect((failed as ForbiddenError).message).toContain("EDIT_BILLING");

    // What they DO hold, they may delegate.
    await setMembershipPermissions(managerCtx, cashier.membershipId, [Permission.VIEW_TEMPLATES]);
    const updated = await requireBusinessMembership(prisma, cashier.userId, cafe.businessId);
    expect(updated.permissions.has(Permission.VIEW_TEMPLATES)).toBe(true);
    expect(updated.permissions.has(Permission.EDIT_BILLING)).toBe(false);
  });

  it("refuses a role whose defaults exceed the granter's own access", async () => {
    const cafe = await createStampCafe();
    const manager = await createStaff(cafe, MembershipRole.MANAGER, []);
    await setMembershipPermissions(cafe.ctx, manager.membershipId, [Permission.EDIT_STAFF]);
    const managerCtx = await requireBusinessMembership(prisma, manager.userId, cafe.businessId);
    const cashier = await createStaff(cafe, MembershipRole.CASHIER, [cafe.locationId]);

    // OWNER is refused by the explicit owner rule...
    await expect(changeMembershipRole(managerCtx, cashier.membershipId, MembershipRole.OWNER)).rejects.toBeInstanceOf(
      ForbiddenError,
    );

    // ...and creating a membership whose ROLE would carry permissions the manager lacks is refused
    // too, so the ceiling cannot be stepped over by choosing a role instead of a permission list.
    await expect(
      addMembership(managerCtx, { userId: await userFor(cafe.businessId), role: MembershipRole.OWNER }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("refuses a cashier every staff-management verb", async () => {
    const cafe = await createStampCafe();
    const cashier = await createStaff(cafe, MembershipRole.CASHIER, [cafe.locationId]);
    const victim = await createStaff(cafe, MembershipRole.CASHIER, [cafe.locationId]);

    for (const attempt of [
      () => addMembership(cashier.ctx, { userId: victim.userId, role: MembershipRole.CASHIER }),
      () => changeMembershipRole(cashier.ctx, victim.membershipId, MembershipRole.MANAGER),
      () => setMembershipPermissions(cashier.ctx, victim.membershipId, [Permission.VIEW_DASHBOARD]),
      () => setMembershipLocations(cashier.ctx, victim.membershipId, [cafe.locationId]),
      () => deactivateMembership(cashier.ctx, victim.membershipId),
      () => reactivateMembership(cashier.ctx, victim.membershipId),
      () => listBusinessStaff(cashier.ctx),
    ]) {
      await expect(attempt()).rejects.toBeInstanceOf(ForbiddenError);
    }
  });

  it("refuses to restrict an owner's permissions", async () => {
    const cafe = await createStampCafe();
    const second = await createStaff(cafe, MembershipRole.OWNER, []);
    await expect(setMembershipPermissions(cafe.ctx, second.membershipId, [Permission.VIEW_DASHBOARD])).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });

  it("keeps at least one active owner", async () => {
    const cafe = await createStampCafe();
    const second = await createStaff(cafe, MembershipRole.OWNER, []);
    const ownerMembership = await prisma.businessMembership.findFirstOrThrow({
      where: { businessId: cafe.businessId, userId: cafe.userId },
      select: { id: true },
    });

    // Two owners, so one may go.
    await deactivateMembership(cafe.ctx, second.membershipId);

    // Now the last one cannot be removed - and the self rule stops them doing it to themselves.
    const secondCtx = await requireBusinessMembership(prisma, second.userId, cafe.businessId).catch(() => null);
    expect(secondCtx).toBeNull();
    await expect(deactivateMembership(cafe.ctx, ownerMembership.id)).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("location assignment", () => {
  beforeAll(async () => {
    await resetDatabase();
  });

  it("replaces the whole set, and an empty set is a denial", async () => {
    const cafe = await createStampCafe();
    const branch = await createLocation(cafe, "Branch");
    const cashier = await createStaff(cafe, MembershipRole.CASHIER, [cafe.locationId]);

    await setMembershipLocations(cafe.ctx, cashier.membershipId, [branch]);
    const moved = await requireBusinessMembership(prisma, cashier.userId, cafe.businessId);
    // Replaced, not added to: Main is gone.
    expect(moved.locationIds).toEqual([branch]);

    await setMembershipLocations(cafe.ctx, cashier.membershipId, []);
    const cleared = await requireBusinessMembership(prisma, cashier.userId, cafe.businessId);
    expect(cleared.locationIds).toEqual([]);
    // Empty is NOT "unrestricted": a cashier with nothing assigned may work nowhere.
    expect(cleared.locationIds).not.toBeNull();
  });

  it("refuses another business's location", async () => {
    const cafe = await createStampCafe();
    const rival = await createStampCafe({ name: "Rival" });
    const cashier = await createStaff(cafe, MembershipRole.CASHIER, [cafe.locationId]);

    await expect(setMembershipLocations(cafe.ctx, cashier.membershipId, [rival.locationId])).rejects.toBeInstanceOf(
      ValidationError,
    );
    const unchanged = await requireBusinessMembership(prisma, cashier.userId, cafe.businessId);
    expect(unchanged.locationIds).toEqual([cafe.locationId]);
  });

  it("refuses a membership from another business entirely", async () => {
    const cafe = await createStampCafe();
    const rival = await createStampCafe({ name: "Rival" });
    const theirs = await createStaff(rival, MembershipRole.CASHIER, [rival.locationId]);

    // Tenant-scoped: a membership id from another business is "not found", never "forbidden".
    await expect(setMembershipLocations(cafe.ctx, theirs.membershipId, [cafe.locationId])).rejects.toBeInstanceOf(
      NotFoundError,
    );
    await expect(changeMembershipRole(cafe.ctx, theirs.membershipId, MembershipRole.MANAGER)).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it("audits the change without staff details", async () => {
    const cafe = await createStampCafe();
    const branch = await createLocation(cafe, "Branch");
    const cashier = await createStaff(cafe, MembershipRole.CASHIER, [cafe.locationId]);

    await setMembershipLocations(cafe.ctx, cashier.membershipId, [branch]);

    const entry = await prisma.auditLog.findFirstOrThrow({
      where: { businessId: cafe.businessId, action: AuditAction.MEMBERSHIP_LOCATIONS_CHANGED },
      select: { entityId: true, actorUserId: true, metadata: true },
    });
    expect(entry.entityId).toBe(cashier.membershipId);
    expect(entry.actorUserId).toBe(cafe.userId);

    const serialized = JSON.stringify(entry.metadata);
    expect(serialized).toContain(branch);
    // Ids and a count. No email, no name, no password hash, no token.
    const user = await prisma.user.findUniqueOrThrow({ where: { id: cashier.userId }, select: { email: true } });
    expect(serialized).not.toContain(user.email);
    expect(serialized.toLowerCase()).not.toContain("passwordhash");
  });
});

describe("active and inactive membership", () => {
  beforeAll(async () => {
    await resetDatabase();
  });

  it("takes effect on the next request, both ways", async () => {
    const cafe = await createStampCafe();
    const cashier = await createStaff(cafe, MembershipRole.CASHIER, [cafe.locationId]);

    await deactivateMembership(cafe.ctx, cashier.membershipId);
    await expect(requireBusinessMembership(prisma, cashier.userId, cafe.businessId)).rejects.toBeInstanceOf(ForbiddenError);

    await reactivateMembership(cafe.ctx, cashier.membershipId);
    const back = await requireBusinessMembership(prisma, cashier.userId, cafe.businessId);
    expect(back.role).toBe(MembershipRole.CASHIER);
    // Coming back from leave re-grants nothing: the assignments are exactly what they were.
    expect(back.locationIds).toEqual([cafe.locationId]);

    const entries = await prisma.auditLog.findMany({
      where: { businessId: cafe.businessId, entityId: cashier.membershipId },
      select: { action: true },
    });
    expect(entries.map((e) => e.action)).toEqual(
      expect.arrayContaining([AuditAction.MEMBERSHIP_DEACTIVATED, AuditAction.MEMBERSHIP_REACTIVATED]),
    );
  });

  it("lists staff with their access, and hides the inactive unless asked", async () => {
    const cafe = await createStampCafe();
    const branch = await createLocation(cafe, "Branch");
    const cashier = await createStaff(cafe, MembershipRole.CASHIER, [branch]);
    const gone = await createStaff(cafe, MembershipRole.CASHIER, []);
    await deactivateMembership(cafe.ctx, gone.membershipId);

    const active = await listBusinessStaff(cafe.ctx);
    expect(active.map((s) => s.id)).not.toContain(gone.membershipId);
    const listed = active.find((s) => s.id === cashier.membershipId);
    expect(listed?.locationIds).toEqual([branch]);
    expect(listed?.unrestrictedLocations).toBe(false);
    expect(active.find((s) => s.role === MembershipRole.OWNER)?.unrestrictedLocations).toBe(true);

    const all = await listBusinessStaff(cafe.ctx, { includeInactive: true });
    expect(all.map((s) => s.id)).toContain(gone.membershipId);
    expect(all.find((s) => s.id === gone.membershipId)?.active).toBe(false);

    // The list never carries a credential.
    expect(JSON.stringify(all).toLowerCase()).not.toContain("passwordhash");
  });

  it("refuses a duplicate membership for the same user in the same business", async () => {
    const reg = await registerTestOwner();
    const ctx = await requireBusinessMembership(prisma, reg.userId, reg.businessId);
    const userId = await userFor(reg.businessId);

    await addMembership(ctx, { userId, role: MembershipRole.CASHIER, locationIds: [reg.locationId] });
    await expect(addMembership(ctx, { userId, role: MembershipRole.CASHIER })).rejects.toBeInstanceOf(ConflictError);
  });
});
