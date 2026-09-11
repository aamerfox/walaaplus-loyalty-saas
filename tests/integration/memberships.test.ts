import { MembershipRole, Permission } from "@prisma/client";
import { beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/db";
import { ConflictError, ForbiddenError } from "@/server/errors";
import { requireBusinessMembership } from "@/server/tenant/context";
import {
  addMembership,
  changeMembershipRole,
  deactivateMembership,
  setMembershipPermissions,
} from "@/server/tenant/memberships";
import { registerTestOwner, resetDatabase, uniqueEmail } from "../setup/fixtures";

describe("membership changes take effect from database state", () => {
  let owner: Awaited<ReturnType<typeof registerTestOwner>>;
  let managerUserId: string;
  let managerMembershipId: string;

  beforeAll(async () => {
    await resetDatabase();
    owner = await registerTestOwner();
    const u = await prisma.user.create({ data: { email: uniqueEmail("mgr"), passwordHash: "x", firstName: "M" } });
    managerUserId = u.id;
  });

  it("owner adds a manager; the manager's context resolves immediately", async () => {
    const ownerCtx = await requireBusinessMembership(prisma, owner.userId, owner.businessId);
    const m = await addMembership(ownerCtx, { userId: managerUserId, role: MembershipRole.MANAGER });
    managerMembershipId = m.id;

    const ctx = await requireBusinessMembership(prisma, managerUserId, owner.businessId);
    expect(ctx.role).toBe(MembershipRole.MANAGER);
    expect(ctx.permissions.has(Permission.EDIT_STAFF)).toBe(false);
  });

  it("a manager without EDIT_STAFF cannot manage memberships", async () => {
    const ctx = await requireBusinessMembership(prisma, managerUserId, owner.businessId);
    await expect(addMembership(ctx, { userId: owner.userId, role: MembershipRole.CASHIER })).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });

  it("granting EDIT_STAFF explicitly is visible on the very next resolve", async () => {
    const ownerCtx = await requireBusinessMembership(prisma, owner.userId, owner.businessId);
    await setMembershipPermissions(ownerCtx, managerMembershipId, [Permission.EDIT_STAFF]);
    const ctx = await requireBusinessMembership(prisma, managerUserId, owner.businessId);
    expect(ctx.permissions.has(Permission.EDIT_STAFF)).toBe(true);
  });

  it("a manager with EDIT_STAFF still cannot grant OWNER", async () => {
    const ctx = await requireBusinessMembership(prisma, managerUserId, owner.businessId);
    const u = await prisma.user.create({ data: { email: uniqueEmail("x"), passwordHash: "x" } });
    await expect(addMembership(ctx, { userId: u.id, role: MembershipRole.OWNER })).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("role change is reflected on the next request", async () => {
    const ownerCtx = await requireBusinessMembership(prisma, owner.userId, owner.businessId);
    await changeMembershipRole(ownerCtx, managerMembershipId, MembershipRole.CASHIER);
    const ctx = await requireBusinessMembership(prisma, managerUserId, owner.businessId);
    expect(ctx.role).toBe(MembershipRole.CASHIER);
    // explicit EDIT_STAFF grant survives the role change and still applies
    expect(ctx.permissions.has(Permission.EDIT_STAFF)).toBe(true);
    expect(ctx.permissions.has(Permission.EDIT_TEMPLATES)).toBe(false);
  });

  it("the last active owner cannot be demoted or deactivated", async () => {
    const ownerCtx = await requireBusinessMembership(prisma, owner.userId, owner.businessId);
    await expect(changeMembershipRole(ownerCtx, owner.membershipId, MembershipRole.MANAGER)).rejects.toBeInstanceOf(
      ConflictError,
    );
    await expect(deactivateMembership(ownerCtx, owner.membershipId)).rejects.toBeInstanceOf(ConflictError);
  });

  it("deactivation removes access on the next request", async () => {
    const ownerCtx = await requireBusinessMembership(prisma, owner.userId, owner.businessId);
    await deactivateMembership(ownerCtx, managerMembershipId);
    await expect(requireBusinessMembership(prisma, managerUserId, owner.businessId)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("every privileged change was audited", async () => {
    const actions = (
      await prisma.auditLog.findMany({
        where: { businessId: owner.businessId, entityId: managerMembershipId },
        orderBy: { createdAt: "asc" },
      })
    ).map((a) => a.action);
    expect(actions).toEqual([
      "membership.created",
      "membership.permissions_changed",
      "membership.role_changed",
      "membership.deactivated",
    ]);
  });

  it("memberships cannot be managed across tenants", async () => {
    const other = await registerTestOwner();
    const otherCtx = await requireBusinessMembership(prisma, other.userId, other.businessId);
    await expect(changeMembershipRole(otherCtx, owner.membershipId, MembershipRole.CASHIER)).rejects.toThrow(/not found/i);
  });
});
