import { MembershipRole, Permission, Prisma } from "@prisma/client";
import { AuditAction, recordAudit } from "../audit/audit";
import { prisma } from "../db";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../errors";
import { requirePermission, type TenantContext } from "./context";

/**
 * Privileged membership changes. Every mutation is tenant-scoped through `ctx`, requires
 * EDIT_STAFF, is audited, and takes effect on the very next request because contexts are
 * rebuilt from the database each time.
 *
 * Invariants:
 *  - a business always keeps at least one active OWNER;
 *  - only an OWNER may create, promote to, or demote another OWNER.
 */

async function loadMembership(ctx: TenantContext, membershipId: string) {
  const m = await prisma.businessMembership.findFirst({
    where: { id: membershipId, businessId: ctx.businessId },
    select: { id: true, userId: true, role: true, active: true },
  });
  if (!m) throw new NotFoundError("Membership not found");
  return m;
}

async function assertNotLastActiveOwner(businessId: string, membershipId: string) {
  const owners = await prisma.businessMembership.count({
    where: { businessId, role: MembershipRole.OWNER, active: true, NOT: { id: membershipId } },
  });
  if (owners === 0) throw new ConflictError("A business must keep at least one active owner");
}

function assertMayAssignRole(ctx: TenantContext, role: MembershipRole) {
  if (role === MembershipRole.OWNER && ctx.role !== MembershipRole.OWNER) {
    throw new ForbiddenError("Only an owner may grant the owner role");
  }
}

export interface AddMembershipInput {
  userId: string;
  role: MembershipRole;
  permissions?: Permission[];
  locationIds?: string[];
}

export async function addMembership(ctx: TenantContext, input: AddMembershipInput) {
  requirePermission(ctx, Permission.EDIT_STAFF);
  assertMayAssignRole(ctx, input.role);

  const locationIds = input.locationIds ?? [];
  if (locationIds.length > 0) {
    const owned = await prisma.location.count({
      where: { id: { in: locationIds }, businessId: ctx.businessId },
    });
    if (owned !== locationIds.length) throw new ValidationError("One or more locations do not belong to this business");
  }

  try {
    return await prisma.$transaction(async (tx) => {
      const m = await tx.businessMembership.create({
        data: {
          businessId: ctx.businessId,
          userId: input.userId,
          role: input.role,
          permissions: input.permissions ?? [],
          locations: { create: locationIds.map((locationId) => ({ locationId })) },
        },
        select: { id: true },
      });
      await recordAudit(tx, {
        businessId: ctx.businessId,
        actorUserId: ctx.userId,
        action: AuditAction.MEMBERSHIP_CREATED,
        entityType: "BusinessMembership",
        entityId: m.id,
        metadata: { userId: input.userId, role: input.role, locationIds },
      });
      return m;
    });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      throw new ConflictError("User already has a membership in this business");
    }
    throw e;
  }
}

export async function changeMembershipRole(ctx: TenantContext, membershipId: string, role: MembershipRole) {
  requirePermission(ctx, Permission.EDIT_STAFF);
  assertMayAssignRole(ctx, role);
  const m = await loadMembership(ctx, membershipId);
  if (m.role === MembershipRole.OWNER && role !== MembershipRole.OWNER) {
    if (ctx.role !== MembershipRole.OWNER) throw new ForbiddenError("Only an owner may demote an owner");
    await assertNotLastActiveOwner(ctx.businessId, membershipId);
  }
  await prisma.$transaction(async (tx) => {
    await tx.businessMembership.update({ where: { id: membershipId }, data: { role } });
    await recordAudit(tx, {
      businessId: ctx.businessId,
      actorUserId: ctx.userId,
      action: AuditAction.MEMBERSHIP_ROLE_CHANGED,
      entityType: "BusinessMembership",
      entityId: membershipId,
      metadata: { from: m.role, to: role },
    });
  });
}

export async function setMembershipPermissions(ctx: TenantContext, membershipId: string, permissions: Permission[]) {
  requirePermission(ctx, Permission.EDIT_STAFF);
  await loadMembership(ctx, membershipId);
  await prisma.$transaction(async (tx) => {
    await tx.businessMembership.update({ where: { id: membershipId }, data: { permissions } });
    await recordAudit(tx, {
      businessId: ctx.businessId,
      actorUserId: ctx.userId,
      action: AuditAction.MEMBERSHIP_PERMISSIONS_CHANGED,
      entityType: "BusinessMembership",
      entityId: membershipId,
      metadata: { permissions },
    });
  });
}

export async function deactivateMembership(ctx: TenantContext, membershipId: string) {
  requirePermission(ctx, Permission.EDIT_STAFF);
  const m = await loadMembership(ctx, membershipId);
  if (m.role === MembershipRole.OWNER) {
    if (ctx.role !== MembershipRole.OWNER) throw new ForbiddenError("Only an owner may deactivate an owner");
    await assertNotLastActiveOwner(ctx.businessId, membershipId);
  }
  await prisma.$transaction(async (tx) => {
    await tx.businessMembership.update({ where: { id: membershipId }, data: { active: false } });
    await recordAudit(tx, {
      businessId: ctx.businessId,
      actorUserId: ctx.userId,
      action: AuditAction.MEMBERSHIP_DEACTIVATED,
      entityType: "BusinessMembership",
      entityId: membershipId,
    });
  });
}

/** Businesses the user can act in. Used by the shell to pick a current business. */
export async function listUserBusinesses(userId: string) {
  return prisma.businessMembership.findMany({
    where: { userId, active: true, business: { active: true } },
    select: {
      id: true,
      role: true,
      business: { select: { id: true, name: true, defaultLocale: true, currency: true } },
    },
    orderBy: { createdAt: "asc" },
  });
}
