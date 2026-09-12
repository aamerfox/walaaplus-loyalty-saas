import { z } from "zod";
import type { Tx } from "../db";
import { NotFoundError, ValidationError } from "../errors";
import { requireLocationAccess, type TenantContext } from "../tenant/context";

/**
 * Which counters a program version may be operated at.
 *
 * `availableLocations` lives inside the version's immutable `mechanics` (PRODUCT-SPEC §5.1, §5.2),
 * so a card pinned to a version can never have its location rules changed underneath it. That is
 * the whole reason it is not a mutable join table: a merchant who opens a second branch publishes a
 * NEW version, and cards issued before it keep the rules they were sold under.
 *
 * **Absent means Main-only, and absent is what every Phase 1a version says.** No migration
 * backfills anything, no existing card changes behaviour, and a request that names a location
 * against such a version is refused exactly as it was in Phase 1a. Multi-location behaviour begins
 * only when a Phase 1b version deliberately lists its locations.
 *
 * The ids are validated against the business when the version is CREATED and again, under the
 * transaction, every time value moves. Two checks, because they answer different questions: the
 * first asks "is this a location of yours", the second asks "may this member act there, and is it
 * still active". A location deactivated after a program was published must stop accepting awards
 * without anyone having to remember to republish.
 */

/** A version may name at most this many locations. Generous for a chain, small enough to bound the check. */
export const MAX_AVAILABLE_LOCATIONS = 50;

export const availableLocationsSchema = z
  .array(z.string().trim().min(1).max(64))
  .min(1)
  .max(MAX_AVAILABLE_LOCATIONS)
  .refine((ids) => new Set(ids).size === ids.length, { message: "availableLocations must not repeat a location" });

/** Mechanics that may carry the field. Both program contracts satisfy this. */
export interface LocationAwareMechanics {
  availableLocations?: readonly string[];
}

/**
 * The locations this version allows, or `null` for "Main only, the Phase 1a rule".
 *
 * Null and an empty array are deliberately different. Null is "this version predates multi-location
 * and must behave exactly as it always has"; an empty array cannot occur, because the schema
 * refuses it — a version that allowed nowhere could never be used and would be a silent outage.
 */
export function readAvailableLocations(mechanics: LocationAwareMechanics): readonly string[] | null {
  return mechanics.availableLocations ?? null;
}

/**
 * Validate the location ids a new version wants to run at.
 *
 * Tenant-scoped, so a location id belonging to another business is "not found" rather than
 * "forbidden" — the same answer as an id that never existed, which is what keeps a merchant from
 * confirming a competitor's location ids by publishing programs at them.
 */
export async function assertLocationsBelongToBusiness(
  db: Tx,
  businessId: string,
  locationIds: readonly string[],
): Promise<void> {
  const found = await db.location.count({
    where: { id: { in: [...locationIds] }, businessId, active: true },
  });
  if (found !== new Set(locationIds).size) {
    throw new ValidationError("One or more locations do not belong to this business, or are not active");
  }
}

/**
 * Where an ENROLMENT writes its welcome bonus.
 *
 * Enrolment has no counter to name: it is a system write, and Prompt 1 exposes no way for staff to
 * say which branch a customer signed up at. So the rule is the narrowest one that is never wrong:
 *
 *  - a version that lists nothing gets Main, as it always has;
 *  - a version that lists exactly ONE location gets that location, because writing the bonus at Main
 *    would attribute it to a counter the program does not even run at;
 *  - a version that lists several gets Main, and that is a **documented approximation** until the
 *    counter screen carries a location (Prompt 2). It is recorded as a Medium finding rather than
 *    guessed at silently.
 */
export function resolveEnrollmentLocationId(mechanics: LocationAwareMechanics, defaultLocationId: string): string {
  const allowed = readAvailableLocations(mechanics);
  if (allowed !== null && allowed.length === 1) return allowed[0];
  return defaultLocationId;
}

export interface ResolveLocationInput {
  ctx: TenantContext;
  /** The card's PINNED mechanics — never the template's current ones. */
  mechanics: LocationAwareMechanics;
  /** What the caller asked for, if anything. */
  requestedLocationId?: string;
  /** The business's Main location, resolved by the caller inside the same transaction. */
  defaultLocationId: string;
}

/**
 * Decide where an operation is written, and prove the member may write there.
 *
 * | Version says | Caller says | Result |
 * |---|---|---|
 * | nothing (Phase 1a) | nothing | Main |
 * | nothing (Phase 1a) | a location, **Main included** | **refused** — the Phase 1a rule, unchanged |
 * | one location | nothing | that location |
 * | several locations | nothing | **refused**: the caller must choose, because guessing would attribute revenue to the wrong branch |
 * | several locations | one of them | that location, if the member may act there |
 * | several locations | another business's, or one not listed | **refused** |
 *
 * The "several locations, caller silent" refusal is the one worth defending. A default would be
 * wrong silently: every award taken at the branch that happened to sort first, discovered weeks
 * later when a manager asks why one counter has all the traffic.
 */
export async function resolveOperationLocationId(db: Tx, input: ResolveLocationInput): Promise<string> {
  const allowed = readAvailableLocations(input.mechanics);
  const requested = input.requestedLocationId;

  if (allowed === null) {
    /*
     * Phase 1a behaviour, preserved exactly: Main, and a caller may not choose - not even by
     * naming Main. Accepting the "harmless" case would make the field look supported on a program
     * that does not support it, and the first caller to send a different id would discover the
     * rule at the counter rather than in review.
     */
    if (requested !== undefined) {
      throw new ValidationError(
        "This program runs at the business's Main location only; locationId is resolved by the server and cannot be supplied",
      );
    }
    return input.defaultLocationId;
  }

  let locationId: string;
  if (requested === undefined) {
    if (allowed.length !== 1) {
      throw new ValidationError("This program runs at several locations; name the one this operation happened at");
    }
    locationId = allowed[0];
  } else {
    if (!allowed.includes(requested)) {
      // Same answer whether the id is another tenant's, inactive, or simply not offered by this
      // program: a caller learns only that it cannot be used here.
      throw new NotFoundError("Location not available for this program");
    }
    locationId = requested;
  }

  // Still a location of this business, still active, and this member may act there. Checked inside
  // the caller's transaction so a deactivation or an un-assignment applies to the write in flight.
  await requireLocationAccess(db, input.ctx, locationId);
  return locationId;
}
