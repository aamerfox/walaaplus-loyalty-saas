import { describe, expect, it } from "vitest";
// Plain .mjs helper shared with scripts/db-roles.mjs, so the script and this test cannot drift.
import { decideMembershipAction as decide } from "../../scripts/lib/db-role-membership.mjs";

/**
 * Prompt 0.3 item 5. `db-roles.mjs` may need membership in the runtime role to transfer ownership
 * of the pgboss schema. Membership is privilege — a member can SET ROLE into the runtime role — so
 * it must never outlive the transfer, and a membership an administrator created must never be
 * destroyed by a deployment script.
 */
describe("db-roles membership decision", () => {
  it("a superuser migrator borrows nothing", () => {
    expect(decide({ isSuperuser: true, hadPreExistingMembership: false })).toEqual({
      grant: false,
      revokeAfter: false,
      notice: null,
    });
  });

  it("a non-superuser migrator borrows membership and always hands it back", () => {
    expect(decide({ isSuperuser: false, hadPreExistingMembership: false })).toEqual({
      grant: true,
      revokeAfter: true,
      notice: null,
    });
  });

  it("a pre-existing membership is left untouched and reported, whatever our privilege", () => {
    for (const isSuperuser of [true, false]) {
      expect(decide({ isSuperuser, hadPreExistingMembership: true })).toEqual({
        grant: false,
        revokeAfter: false,
        notice: "pre-existing-membership",
      });
    }
  });

  it("never revokes without having granted", () => {
    for (const isSuperuser of [true, false]) {
      for (const hadPreExistingMembership of [true, false]) {
        const d = decide({ isSuperuser, hadPreExistingMembership });
        if (d.revokeAfter) expect(d.grant).toBe(true);
        // A membership we did not create is never removed.
        if (hadPreExistingMembership) expect(d.revokeAfter).toBe(false);
      }
    }
  });
});
