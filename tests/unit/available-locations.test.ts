import { describe, expect, it } from "vitest";
import { NotFoundError, ValidationError } from "@/server/errors";
import { readAvailableLocations, resolveOperationLocationId } from "@/server/program/available-locations";
import type { TenantContext } from "@/server/tenant/context";

/**
 * Where an operation is attributed, decided by the version rather than the caller.
 *
 * The integration suite proves this against a real database and a real membership. This file pins
 * the decision table itself, because it is the part a future change is most likely to "simplify"
 * into a default — and a default here is an award attributed to the wrong branch, discovered weeks
 * later when a manager asks why one counter has all the traffic.
 */

const MAIN = "loc-main";
const BRANCH = "loc-branch";

/** An owner: unrestricted across their own locations, so `requireLocationAccess` always passes. */
const ownerCtx = { businessId: "biz", locationIds: null } as unknown as TenantContext;

/** A database stub that answers "yes, that location is mine and active". */
const db = {
  location: { findFirst: async ({ where }: { where: { id: string } }) => ({ id: where.id }) },
} as never;

const resolve = (mechanics: { availableLocations?: string[] }, requestedLocationId?: string) =>
  resolveOperationLocationId(db, { ctx: ownerCtx, mechanics, requestedLocationId, defaultLocationId: MAIN });

describe("readAvailableLocations", () => {
  it("distinguishes 'not stated' from a list", () => {
    // Null means "this version predates multi-location and must behave exactly as it always has".
    expect(readAvailableLocations({})).toBeNull();
    expect(readAvailableLocations({ availableLocations: [BRANCH] })).toEqual([BRANCH]);
  });
});

describe("a version that lists nothing is Main-only", () => {
  it("attributes to Main when the caller says nothing", async () => {
    await expect(resolve({})).resolves.toBe(MAIN);
  });

  it("refuses a caller-supplied location, which is the Phase 1a rule unchanged", async () => {
    await expect(resolve({}, BRANCH)).rejects.toBeInstanceOf(ValidationError);
  });

  it("refuses even a caller naming Main itself", async () => {
    // Accepting the harmless case would make the field look supported on a program that does not
    // support it, and the next caller would discover the rule at the counter.
    await expect(resolve({}, MAIN)).rejects.toBeInstanceOf(ValidationError);
  });
});

describe("a version that lists its locations", () => {
  it("uses the only one when there is only one", async () => {
    await expect(resolve({ availableLocations: [BRANCH] })).resolves.toBe(BRANCH);
  });

  it("refuses to guess when there are several", async () => {
    // A default would be wrong silently, which is the worst way for this to be wrong.
    await expect(resolve({ availableLocations: [MAIN, BRANCH] })).rejects.toBeInstanceOf(ValidationError);
  });

  it("accepts one of its own", async () => {
    await expect(resolve({ availableLocations: [MAIN, BRANCH] }, BRANCH)).resolves.toBe(BRANCH);
  });

  it("refuses one it does not offer, without saying why", async () => {
    // Not offered, another tenant's, or nonexistent: one answer for all three.
    await expect(resolve({ availableLocations: [MAIN] }, BRANCH)).rejects.toBeInstanceOf(NotFoundError);
  });
});
