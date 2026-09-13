import { RateLimitedError } from "../errors";
import type { TenantContext } from "../tenant/context";
import { consumeStaffActionLimit, type StaffAction } from "./rate-limit";

/**
 * The per-actor counter limit, at the HTTP boundary (finding M-11).
 *
 * ## Why here and not in the services
 *
 * A limit is a property of a request, not of a domain verb. `awardStamps` called twice by a test
 * fixture building a scenario is not abuse; the same verb called four hundred times an hour through
 * an authenticated route is the thing worth bounding. Putting the window in the route keeps the
 * services callable — by the seed script, by fixtures, by a future job runner — without either
 * giving them a bypass or making every caller carry a limiter it does not need.
 *
 * It runs AFTER the tenant context is resolved and BEFORE the service, which is the only order that
 * works: the window is keyed on the membership, so there is nothing to key on until the membership
 * has been verified, and counting an attempt that the service would have refused anyway is the
 * point — a script probing with invalid input must not get unlimited attempts.
 *
 * ## What a refused request is told
 *
 * A 429 with the seconds to wait, and nothing else. Not which limit, not how many are left, not
 * whether the customer exists. A cashier who has genuinely hit it is told to wait a moment; a
 * script learns the same thing.
 */
export async function enforceStaffLimit(ctx: TenantContext, action: StaffAction): Promise<void> {
  const decision = await consumeStaffActionLimit(
    { membershipId: ctx.membershipId, businessId: ctx.businessId, userId: ctx.userId },
    action,
  );
  if (!decision.allowed) throw new RateLimitedError(decision.retryAfterSeconds);
}
