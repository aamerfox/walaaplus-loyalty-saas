import { MembershipRole, Permission } from "@prisma/client";
import { beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/db";
import { ForbiddenError, NotFoundError } from "@/server/errors";
import {
  requireBusinessMembership,
  requireLocationAccess,
  requirePermission,
  resolveMembership,
} from "@/server/tenant/context";
import { registerTestOwner, resetDatabase } from "../setup/fixtures";

describe("tenant guards", () => {
  let A: Awaited<ReturnType<typeof registerTestOwner>>;
  let B: Awaited<ReturnType<typeof registerTestOwner>>;

  beforeAll(async () => {
    await resetDatabase();
    A = await registerTestOwner({ businessName: "Business A" });
    B = await registerTestOwner({ businessName: "Business B" });
  });

  it("resolves the owner's membership from the database with full permissions", async () => {
    const ctx = await resolveMembership(prisma, A.userId, A.businessId);
    expect(ctx).not.toBeNull();
    expect(ctx!.role).toBe(MembershipRole.OWNER);
    expect(ctx!.locationIds).toBeNull();
    expect(ctx!.permissions.has(Permission.EDIT_BILLING)).toBe(true);
  });

  it("blocks a user from another business", async () => {
    expect(await resolveMembership(prisma, A.userId, B.businessId)).toBeNull();
    await expect(requireBusinessMembership(prisma, A.userId, B.businessId)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("does not reveal another business's location: foreign id looks like not-found", async () => {
    const ctxA = await requireBusinessMembership(prisma, A.userId, A.businessId);
    await expect(requireLocationAccess(prisma, ctxA, B.locationId)).rejects.toBeInstanceOf(NotFoundError);
    await expect(requireLocationAccess(prisma, ctxA, A.locationId)).resolves.toBeUndefined();
  });

  it("enforces permissions and location assignment for a cashier", async () => {
    const cashierUser = await prisma.user.create({
      data: { email: `cashier-${Date.now()}@example.test`, passwordHash: "x", firstName: "C" },
    });
    const second = await prisma.location.create({ data: { businessId: A.businessId, name: "Branch 2" } });
    await prisma.businessMembership.create({
      data: {
        businessId: A.businessId,
        userId: cashierUser.id,
        role: MembershipRole.CASHIER,
        locations: { create: [{ locationId: second.id }] },
      },
    });

    const ctx = await requireBusinessMembership(prisma, cashierUser.id, A.businessId);
    expect(ctx.role).toBe(MembershipRole.CASHIER);
    expect(ctx.locationIds).toEqual([second.id]);

    expect(() => requirePermission(ctx, Permission.MAKE_ACCRUALS)).not.toThrow();
    expect(() => requirePermission(ctx, Permission.EDIT_TEMPLATES)).toThrow(ForbiddenError);

    await expect(requireLocationAccess(prisma, ctx, second.id)).resolves.toBeUndefined();
    await expect(requireLocationAccess(prisma, ctx, A.locationId)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("returns null for an inactive membership, inactive user, or inactive business", async () => {
    const u = await prisma.user.create({ data: { email: `inact-${Date.now()}@example.test`, passwordHash: "x" } });
    const m = await prisma.businessMembership.create({
      data: { businessId: A.businessId, userId: u.id, role: MembershipRole.MANAGER },
    });
    expect(await resolveMembership(prisma, u.id, A.businessId)).not.toBeNull();

    await prisma.businessMembership.update({ where: { id: m.id }, data: { active: false } });
    expect(await resolveMembership(prisma, u.id, A.businessId)).toBeNull();

    await prisma.businessMembership.update({ where: { id: m.id }, data: { active: true } });
    await prisma.user.update({ where: { id: u.id }, data: { active: false } });
    expect(await resolveMembership(prisma, u.id, A.businessId)).toBeNull();
    await prisma.user.update({ where: { id: u.id }, data: { active: true } });

    await prisma.business.update({ where: { id: A.businessId }, data: { active: false } });
    expect(await resolveMembership(prisma, u.id, A.businessId)).toBeNull();
    await prisma.business.update({ where: { id: A.businessId }, data: { active: true } });
  });
});
