import { MembershipRole, Permission } from "@prisma/client";

export const ALL_PERMISSIONS: readonly Permission[] = Object.values(Permission);

/**
 * Baseline permissions granted by role. A membership's explicit `permissions` column ADDS to
 * these; OWNER always holds every permission and cannot be restricted.
 *
 * Cashier: scanner actions only. Customer and operation visibility is further narrowed by the
 * services that serve those views (own location, scanned customer) in later phases.
 */
export const ROLE_DEFAULT_PERMISSIONS: Readonly<Record<MembershipRole, readonly Permission[]>> = {
  OWNER: ALL_PERMISSIONS,
  MANAGER: [
    Permission.VIEW_DASHBOARD,
    Permission.VIEW_TEMPLATES,
    Permission.EDIT_TEMPLATES,
    Permission.VIEW_CUSTOMERS,
    Permission.EDIT_CUSTOMERS,
    Permission.VIEW_OPERATIONS,
    Permission.MAKE_ACCRUALS,
    Permission.MAKE_REDEMPTIONS,
    Permission.VIEW_LOCATIONS,
    Permission.EDIT_LOCATIONS,
    Permission.VIEW_STAFF,
    Permission.VIEW_PUSHES,
    Permission.EDIT_PUSHES,
    Permission.VIEW_SEGMENTS,
    Permission.EDIT_SEGMENTS,
    Permission.VIEW_INTEGRATIONS,
  ],
  CASHIER: [
    Permission.MAKE_ACCRUALS,
    Permission.MAKE_REDEMPTIONS,
    Permission.VIEW_CUSTOMERS,
    /*
     * Added when enrolment moved to the counter (owner decision B7, option 3). A cashier is the
     * person who now signs a customer up, so creating a customer record is part of the job.
     *
     * Nothing else in Phase 1a guards EDIT_CUSTOMERS, so this grant opens exactly one capability
     * today: `enrollAtCounter`. Anything guarded on it later must check that a cashier should
     * have it too, rather than assume the bit means what it meant before this line.
     */
    Permission.EDIT_CUSTOMERS,
    Permission.VIEW_OPERATIONS,
  ],
};

/** Effective permission set for a membership: role defaults ∪ explicit grants; OWNER = everything. */
export function effectivePermissions(
  role: MembershipRole,
  explicit: readonly Permission[],
): ReadonlySet<Permission> {
  if (role === MembershipRole.OWNER) return new Set(ALL_PERMISSIONS);
  return new Set([...ROLE_DEFAULT_PERMISSIONS[role], ...explicit]);
}
