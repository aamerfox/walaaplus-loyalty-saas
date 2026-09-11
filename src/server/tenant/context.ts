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
  /**
   * Location scope.
   *  - `null`  → unrestricted: every active location of the business (OWNER, MANAGER).
   *  - `[]`    → NO location access (a CASHIER with nothing assigned). Never treated as unrestricted.
   *  - `[...]` → exactly these locations (assigned CASHIER).
   */
  readonly locationIds: readonly string[] | null;
}

/** Roles that may operate at any business location without explicit assignment. */
const UNRESTRICTED_LOCATION_ROLES: ReadonlySet<MembershipRole> = new Set<MembershipRole>(["OWNER", "MANAGER"]);

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
    locationIds: UNRESTRICTED_LOCATION_ROLES.has(m.role) ? null : m.locations.map((l) => l.locationId),
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
  if (ctx.locationIds === null) return; // OWNER / MANAGER
  if (ctx.locationIds.length === 0) throw new ForbiddenError("No locations assigned to this member");
  if (!ctx.locationIds.includes(locationId)) throw new ForbiddenError("Not assigned to this location");
}

/** Convenience: the tenant filter every business-scoped query must include. */
export function tenantWhere(ctx: TenantContext): { businessId: string } {
  return { businessId: ctx.businessId };
}
