import { MembershipRole, Permission } from "@prisma/client";
import { NextResponse } from "next/server";
import { z } from "zod";
import { ValidationError } from "@/server/errors";
import { errorResponse, readJsonObject } from "@/server/http";
import {
  changeMembershipRole,
  deactivateMembership,
  reactivateMembership,
  setMembershipLocations,
  setMembershipPermissions,
} from "@/server/tenant/memberships";
import { requireScannerContext } from "@/server/tenant/scanner-context";

/**
 * POST /api/staff/membership — change one staff member's access.
 *
 * Five verbs behind one discriminated union, because they are one screen's actions and they share
 * one authorization story. Each carries exactly its own fields: a `role` change cannot smuggle a
 * permission list, and a location assignment cannot smuggle a role.
 *
 * **Every rule that matters lives in the service, not here.** `EDIT_STAFF`, "only an owner may act
 * on an owner", "nobody edits their own membership", "nobody grants what they do not hold" and the
 * last-active-owner guard are all enforced by `src/server/tenant/memberships.ts`, inside its own
 * transaction, against a membership loaded under the caller's tenant. This route parses and
 * delegates. A browser may hide a button; it never decides whether the write is allowed.
 *
 * The response is deliberately empty. A management screen reloads its list from the server after a
 * change, so returning the new state here would be a second copy of the truth that can disagree with
 * the first — and the membership row is exactly the thing that must not be read from a stale cache.
 */

const membershipId = z.string().min(1).max(64);

const bodySchema = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("role"), membershipId, role: z.enum([MembershipRole.MANAGER, MembershipRole.CASHIER]) }),
  z.strictObject({ action: z.literal("permissions"), membershipId, permissions: z.array(z.enum(Permission)).max(40) }),
  z.strictObject({ action: z.literal("locations"), membershipId, locationIds: z.array(z.string().min(1).max(64)).max(50) }),
  z.strictObject({ action: z.literal("deactivate"), membershipId }),
  z.strictObject({ action: z.literal("reactivate"), membershipId }),
]);

export async function POST(req: Request) {
  try {
    /*
     * `allowLocation` is not set: a location assignment travels as `locationIds`, which is a
     * different field with a different meaning from the `locationId` that names where an operation
     * happened. The nested guard therefore still applies to this body in full.
     */
    const parsed = bodySchema.safeParse(await readJsonObject(req));
    if (!parsed.success) throw new ValidationError("Invalid staff change", parsed.error.issues);
    const input = parsed.data;

    const { ctx } = await requireScannerContext(null);

    switch (input.action) {
      case "role":
        // OWNER is absent from the schema on purpose: promoting someone to owner is not a staff
        // screen's job, and the service refuses it for anyone who is not already an owner anyway.
        await changeMembershipRole(ctx, input.membershipId, input.role);
        break;
      case "permissions":
        await setMembershipPermissions(ctx, input.membershipId, input.permissions);
        break;
      case "locations":
        await setMembershipLocations(ctx, input.membershipId, input.locationIds);
        break;
      case "deactivate":
        await deactivateMembership(ctx, input.membershipId);
        break;
      case "reactivate":
        await reactivateMembership(ctx, input.membershipId);
        break;
    }

    return NextResponse.json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}
