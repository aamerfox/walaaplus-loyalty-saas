/**
 * Decides whether `scripts/db-roles.mjs` must borrow membership in the runtime role, and whether
 * it must hand that membership back.
 *
 * Why this is its own module: the decision is the security-relevant part of the ownership
 * transfer, and it must be provable for every combination of migrator privilege and pre-existing
 * state. The script itself can only be exercised against a live database with a non-superuser
 * migrator; this function can be unit-tested directly (tests/unit/db-role-membership.test.ts).
 *
 * Rules:
 *  - A SUPERUSER migrator can change ownership without membership. Never grant, never revoke.
 *  - A non-superuser migrator needs membership in the target role to create or transfer objects
 *    owned by it. Grant it, then revoke it in the same transaction: membership is privilege
 *    (a member can SET ROLE into the runtime role), so it must not outlive the transfer.
 *  - Membership an administrator established BEFORE this run is not ours to remove. Leave it and
 *    report it, so the situation is visible rather than silently accepted or silently destroyed.
 */

/**
 * @param {{ isSuperuser: boolean, hadPreExistingMembership: boolean }} state
 * @returns {{ grant: boolean, revokeAfter: boolean, notice: "pre-existing-membership" | null }}
 */
export function decideMembershipAction(state) {
  const { isSuperuser, hadPreExistingMembership } = state;
  if (hadPreExistingMembership) {
    // Never revoke what we did not grant, whatever our own privilege level is.
    return { grant: false, revokeAfter: false, notice: "pre-existing-membership" };
  }
  if (isSuperuser) {
    return { grant: false, revokeAfter: false, notice: null };
  }
  return { grant: true, revokeAfter: true, notice: null };
}
