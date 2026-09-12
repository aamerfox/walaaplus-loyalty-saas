import { MembershipRole, Permission, Prisma } from "@prisma/client";
import { AuditAction, recordAudit } from "../audit/audit";
import { prisma } from "../db";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../errors";
import { requirePermission, type TenantContext } from "./context";
import { effectivePermissions } from "./permissions";

/**
 * Privileged membership changes. Every mutation is tenant-scoped through `ctx`, requires
 * EDIT_STAFF, is audited, and takes effect on the very next request because contexts are
 * rebuilt from the database each time.
 *
 * Invariants:
 *  - a business always keeps at least one active OWNER;
 *  - only an OWNER may create, promote to, or demote another OWNER;
 *  - **nobody edits their own membership** (§`assertNotSelf`);
 *  - **nobody grants what they do not hold** (§`assertMayGrantPermissions`).
 *
 * The last two are the Phase 1b least-privilege rules, and they exist because Phase 1b is the phase
 * that makes them reachable. Phase 1a had no permission editor: the only staff mutation was "owner
 * creates a cashier", so a cashier could not escalate because there was no lever to pull. The
 * moment `setMembershipPermissions` is exposed to anyone but an owner, two levers appear:
 *
 *  1. **Self-escalation.** A manager holding EDIT_STAFF could add EDIT_BILLING to their own
 *     membership. `requirePermission` would then pass on the very next request, because contexts are
 *     rebuilt from the database each time - the same property that makes revocation instant makes
 *     self-promotion instant.
 *  2. **Escalation by proxy.** The same manager could grant EDIT_BILLING to a cashier they control,
 *     or to a second account of their own, and act through it.
 *
 * Both are closed here rather than in a route, because a route is one caller among several and the
 * rule belongs to the domain. An OWNER is exempt from the ceiling by construction: they hold every
 * permission, so "cannot grant what you do not hold" grants them everything.
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

/**
 * Nobody administers themselves.
 *
 * Not even an owner - and that is deliberate, because the alternative is an owner who removes their
 * own last permission or deactivates their own membership and locks the business out of its own
 * account. A second owner does it, or support does. The check is on the MEMBERSHIP, not the user:
 * the same person may hold memberships in several businesses, and this rule is about one of them.
 */
function assertNotSelf(ctx: TenantContext, membershipId: string) {
  if (membershipId === ctx.membershipId) {
    throw new ForbiddenError("A member may not change their own role, permissions, locations or status");
  }
}

/**
 * The grant ceiling: a member may only hand out permissions they hold themselves.
 *
 * Without it, EDIT_STAFF is the only permission anyone needs - it is the permission that mints
 * permissions. With it, EDIT_STAFF means "may delegate a subset of my own access", which is what a
 * manager's staff screen is actually for.
 */
function assertMayGrantPermissions(ctx: TenantContext, permissions: readonly Permission[]) {
  const beyond = permissions.filter((p) => !ctx.permissions.has(p));
  if (beyond.length > 0) {
    // Sorted so the message is stable, and it names only permission constants - no staff details.
    throw new ForbiddenError(`Cannot grant permissions you do not hold: ${[...new Set(beyond)].sort().join(", ")}`);
  }
}

/**
 * The locations a member may be assigned to must belong to this business and be active.
 *
 * Tenant-scoped, so another business's location id is refused the same way a nonexistent one is.
 */
async function assertLocationsAssignable(businessId: string, locationIds: readonly string[]) {
  if (locationIds.length === 0) return;
  const unique = [...new Set(locationIds)];
  const owned = await prisma.location.count({ where: { id: { in: unique }, businessId, active: true } });
  if (owned !== unique.length) {
    throw new ValidationError("One or more locations do not belong to this business, or are not active");
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

  const explicit = input.permissions ?? [];
  assertMayGrantPermissions(ctx, explicit);
  /*
   * The ROLE carries permissions too, and a role is a grant like any other: a manager who may not
   * touch billing must not be able to create a membership whose role defaults include it. So the
   * ceiling is applied to the whole effective set the new member would hold, not only to the
   * explicit list the caller typed.
   */
  assertMayGrantPermissions(ctx, [...effectivePermissions(input.role, explicit)]);

  const locationIds = [...new Set(input.locationIds ?? [])];
  await assertLocationsAssignable(ctx.businessId, locationIds);

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
  assertNotSelf(ctx, membershipId);
  assertMayAssignRole(ctx, role);
  assertMayGrantPermissions(ctx, [...effectivePermissions(role, [])]);
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
  assertNotSelf(ctx, membershipId);
  assertMayGrantPermissions(ctx, permissions);
  const target = await loadMembership(ctx, membershipId);
  if (target.role === MembershipRole.OWNER) {
    // An owner holds everything by construction (`effectivePermissions`), so an explicit list on an
    // owner's membership is at best a no-op and at worst a reader's false belief that it restricts
    // them. Refuse it rather than store something that does not mean what it looks like.
    throw new ForbiddenError("An owner's permissions cannot be restricted");
  }
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
  assertNotSelf(ctx, membershipId);
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

/**
 * Put a deactivated member back to work.
 *
 * Separate from `deactivateMembership` rather than a boolean setter, because the two are different
 * decisions with different blast radius, and a single `setActive(false)` invites a UI that flips it
 * by accident. Permissions and locations are left exactly as they were: coming back from leave is
 * not a reason to re-grant anything, and a membership that should return with less access is
 * changed explicitly afterwards.
 */
export async function reactivateMembership(ctx: TenantContext, membershipId: string) {
  requirePermission(ctx, Permission.EDIT_STAFF);
  assertNotSelf(ctx, membershipId);
  const m = await loadMembership(ctx, membershipId);
  if (m.role === MembershipRole.OWNER && ctx.role !== MembershipRole.OWNER) {
    throw new ForbiddenError("Only an owner may reactivate an owner");
  }
  if (m.active) return;

  await prisma.$transaction(async (tx) => {
    await tx.businessMembership.update({ where: { id: membershipId }, data: { active: true } });
    await recordAudit(tx, {
      businessId: ctx.businessId,
      actorUserId: ctx.userId,
      action: AuditAction.MEMBERSHIP_REACTIVATED,
      entityType: "BusinessMembership",
      entityId: membershipId,
    });
  });
}

/**
 * Replace a member's location assignments.
 *
 * The whole set is replaced rather than added to, so the caller's intent is the end state and there
 * is no "remove" verb to forget. Two things make this a privileged operation rather than a
 * preference:
 *
 *  - an assignment is what `requireLocationAccess` reads, so this is the lever that decides where a
 *    cashier may move loyalty value;
 *  - **an empty set is a denial, never "unrestricted"** (`TenantContext.locationIds`). Clearing a
 *    cashier's locations stops them working, which is a legitimate thing to do and must not be
 *    confused with giving them everything.
 *
 * OWNER and MANAGER are unrestricted by role, so assignments on them are recorded but do not narrow
 * anything - the service says so rather than pretending otherwise.
 */
export async function setMembershipLocations(ctx: TenantContext, membershipId: string, locationIds: string[]) {
  requirePermission(ctx, Permission.EDIT_STAFF);
  assertNotSelf(ctx, membershipId);
  const m = await loadMembership(ctx, membershipId);
  if (m.role === MembershipRole.OWNER && ctx.role !== MembershipRole.OWNER) {
    throw new ForbiddenError("Only an owner may change an owner's locations");
  }
  const unique = [...new Set(locationIds)];
  await assertLocationsAssignable(ctx.businessId, unique);

  await prisma.$transaction(async (tx) => {
    await tx.staffLocation.deleteMany({ where: { membershipId } });
    if (unique.length > 0) {
      await tx.staffLocation.createMany({ data: unique.map((locationId) => ({ membershipId, locationId })) });
    }
    await recordAudit(tx, {
      businessId: ctx.businessId,
      actorUserId: ctx.userId,
      action: AuditAction.MEMBERSHIP_LOCATIONS_CHANGED,
      entityType: "BusinessMembership",
      entityId: membershipId,
      // Location ids and a count. No email, no name, no phone: an audit row answers "who changed
      // what access", and the staff directory answers who that is.
      metadata: { locationIds: unique, locationCount: unique.length },
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

/**
 * The business's active staff, for the Phase 1a team screen.
 *
 * Read-only and deliberately thin: names, emails and roles. No password hash, no permission array
 * to imply an editor that does not exist, and no other business. `VIEW_STAFF` gates it, which an
 * owner and a manager hold and a cashier does not.
 */
export async function listBusinessStaff(ctx: TenantContext, options: { includeInactive?: boolean } = {}) {
  requirePermission(ctx, Permission.VIEW_STAFF);
  const rows = await prisma.businessMembership.findMany({
    where: { businessId: ctx.businessId, ...(options.includeInactive === true ? {} : { active: true }) },
    select: {
      id: true,
      role: true,
      active: true,
      permissions: true,
      locations: { select: { locationId: true } },
      user: { select: { email: true, firstName: true, lastName: true } },
    },
    orderBy: { createdAt: "asc" },
  });

  return rows.map((m) => ({
    id: m.id,
    role: m.role,
    active: m.active,
    user: m.user,
    /** Explicit grants only - what an editor would show as ticked beyond the role's own defaults. */
    permissions: m.permissions,
    locationIds: m.locations.map((l) => l.locationId),
    /** True when the role is unrestricted across the business, so assignments do not narrow it. */
    unrestrictedLocations: m.role !== MembershipRole.CASHIER,
  }));
}
