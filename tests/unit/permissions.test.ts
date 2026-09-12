import { MembershipRole, Permission } from "@prisma/client";
import { describe, expect, it } from "vitest";
import { ALL_PERMISSIONS, effectivePermissions, ROLE_DEFAULT_PERMISSIONS } from "@/server/tenant/permissions";

describe("effectivePermissions", () => {
  it("OWNER always has every permission and ignores explicit grants", () => {
    const p = effectivePermissions(MembershipRole.OWNER, []);
    expect(p.size).toBe(ALL_PERMISSIONS.length);
    expect(p.has(Permission.EDIT_BILLING)).toBe(true);
  });

  it("MANAGER defaults exclude staff and billing edits but explicit grants add them", () => {
    const base = effectivePermissions(MembershipRole.MANAGER, []);
    expect(base.has(Permission.EDIT_TEMPLATES)).toBe(true);
    expect(base.has(Permission.EDIT_STAFF)).toBe(false);
    expect(base.has(Permission.EDIT_BILLING)).toBe(false);

    const granted = effectivePermissions(MembershipRole.MANAGER, [Permission.EDIT_STAFF]);
    expect(granted.has(Permission.EDIT_STAFF)).toBe(true);
    expect(granted.has(Permission.EDIT_BILLING)).toBe(false);
  });

  it("CASHIER is limited to counter actions and read access", () => {
    const p = effectivePermissions(MembershipRole.CASHIER, []);
    // EDIT_CUSTOMERS is the counter enrolment grant from owner decision B7 option 3: with public
    // self-service enrolment withdrawn, the person at the till is the only one who can issue a
    // card. Nothing about the card itself, the business or the staff moves with it.
    expect([...p].sort()).toEqual(
      [
        Permission.EDIT_CUSTOMERS,
        Permission.MAKE_ACCRUALS,
        Permission.MAKE_REDEMPTIONS,
        Permission.VIEW_CUSTOMERS,
        Permission.VIEW_OPERATIONS,
      ].sort(),
    );
    expect(p.has(Permission.EDIT_TEMPLATES)).toBe(false);
    expect(p.has(Permission.EDIT_STAFF)).toBe(false);
    expect(p.has(Permission.VIEW_DASHBOARD)).toBe(false);
  });

  it("role default tables only contain valid Permission values", () => {
    for (const role of Object.values(MembershipRole)) {
      for (const perm of ROLE_DEFAULT_PERMISSIONS[role]) {
        expect(ALL_PERMISSIONS).toContain(perm);
      }
    }
  });
});
