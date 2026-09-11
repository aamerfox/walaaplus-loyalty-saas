import type { MembershipRole, Permission } from "@prisma/client";
import type { DbClient } from "../db";
import { ForbiddenError, NotFoundError } from "../errors";
import { effectivePermissions } from "./permissions";

/**
 * Tenant context for one request. Built from the DATABASE on every request — never from a
 * role cached in a session token — so revocations and role changes apply immediately.
 */
export interface TenantContext {
  readonly userId: string;
  readonly businessId: string;
  readonly membershipId: string;
  readonly role: MembershipRole;
  readonly permissions: ReadonlySet<Permission>;
  /** Location ids this member may operate at. `null` = unrestricted (owners, managers). */
  readonly locationIds: readonly string[] | null;
}

/**
 * Resolve the caller's ACTIVE membership in a business. Returns null when the user has no
 * active membership, is deactivated, or the business is inactive.
 */
export async function resolveMembership(
  db: DbClient,
  userId: string,
  businessId: string,
): Promise<TenantContext | null> {
  const m = await db.businessMembership.findFirst({
    where: {
      userId,
      businessId,
      active: true,
      user: { active: true },
      business: { active: true },
    },
    select: {
      id: true,
      role: true,
      permissions: true,
      locations: { select: { locationId: true } },
    },
  });
  if (!m) return null;
  return {
    userId,
    businessId,
    membershipId: m.id,
    role: m.role,
    permissions: effectivePermissions(m.role, m.permissions),
    locationIds: m.locations.length === 0 ? null : m.locations.map((l) => l.locationId),
  };
}

/** Guard: the caller must hold an active membership in `businessId`. 403 otherwise. */
export async function requireBusinessMembership(
  db: DbClient,
  userId: string,
  businessId: string,
): Promise<TenantContext> {
  const ctx = await resolveMembership(db, userId, businessId);
  if (!ctx) throw new ForbiddenError("No active membership in this business");
  return ctx;
}

/** Guard: the context must hold `permission`. */
export function requirePermission(ctx: TenantContext, permission: Permission): void {
  if (!ctx.permissions.has(permission)) {
    throw new ForbiddenError(`Missing permission ${permission}`);
  }
}

/**
 * Guard: the location must belong to the context's business AND the member must be allowed to
 * operate there. Lookup is tenant-scoped, so a foreign location id is indistinguishable from a
 * nonexistent one.
 */
export async function requireLocationAccess(
  db: DbClient,
  ctx: TenantContext,
  locationId: string,
): Promise<void> {
  const location = await db.location.findFirst({
    where: { id: locationId, businessId: ctx.businessId, active: true },
    select: { id: true },
  });
  if (!location) throw new NotFoundError("Location not found");
  if (ctx.locationIds !== null && !ctx.locationIds.includes(locationId)) {
    throw new ForbiddenError("Not assigned to this location");
  }
}

/** Convenience: the tenant filter every business-scoped query must include. */
export function tenantWhere(ctx: TenantContext): { businessId: string } {
  return { businessId: ctx.businessId };
}
