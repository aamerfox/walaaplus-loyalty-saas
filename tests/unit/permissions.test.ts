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

  it("CASHIER is limited to scanner actions and read access", () => {
    const p = effectivePermissions(MembershipRole.CASHIER, []);
    expect([...p].sort()).toEqual(
      [Permission.MAKE_ACCRUALS, Permission.MAKE_REDEMPTIONS, Permission.VIEW_CUSTOMERS, Permission.VIEW_OPERATIONS].sort(),
    );
    expect(p.has(Permission.EDIT_TEMPLATES)).toBe(false);
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
