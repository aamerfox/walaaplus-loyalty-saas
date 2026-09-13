import { Permission, ProgramVersionStatus, TemplateStatus } from "@prisma/client";
import { z } from "zod";
import { AuditAction, recordAudit } from "../audit/audit";
import { CONTENDED_TX, prisma, type Tx } from "../db";
import { ConflictCode, ConflictError, NotFoundError, ValidationError } from "../errors";
import { MAX_AVAILABLE_LOCATIONS } from "../program/available-locations";
import { isPointsMechanics, readPointsMechanics } from "../program/points-mechanics";
import { isStampMechanics, readStampMechanics } from "../program/mechanics";
import { requirePermission, type TenantContext } from "./context";

/**
 * The counters a business operates, and their lifecycle.
 *
 * Prompt 1 shipped this module read-only and said so: registration created the one `Main` location
 * and nothing could create a second, which the Prompt 2 evidence recorded as a missing contract
 * rather than papering over with a screen whose buttons reached past the service layer. This is
 * that contract.
 *
 * ## Deactivation, never deletion
 *
 * A location is a column on every ledger row written at it. Deleting one would either orphan
 * history or cascade it away, and the ledger is append-only precisely so that nothing can. So the
 * verb is `active: false`, and it means one thing: **no new value may be written here.** Everything
 * already written stays exactly where it was written, attributed to the counter it happened at,
 * readable in the dashboard's per-location breakdown forever.
 *
 * The enforcement is not in this module, and that is deliberate. `requireLocationAccess` already
 * filters on `active: true` inside the transaction of every scanner write, and
 * `assertLocationsBelongToBusiness` already refuses an inactive location when a program version
 * names one. A deactivation therefore takes effect on writes **in flight**, not at the next
 * deploy, and nothing had to remember to check.
 *
 * ## The three refusals
 *
 * A deactivation that would break the business is refused rather than performed:
 *
 *  1. **Never the default.** `Main` is where every Phase 1a version writes, where enrolment puts a
 *     welcome bonus, and the fallback in `resolveOperationLocationId`. Switching it off would stop
 *     every existing card working, from a screen that looks like it is tidying a list.
 *  2. **Never the last active one.** A business with no active counter cannot take a stamp.
 *  3. **Never the last active counter of a live program.** A version pins its locations in
 *     immutable mechanics; if every location it names is inactive it can never be transacted at
 *     again, and the merchant would find out at the till.
 *
 * Each refusal names what it protected, because "cannot deactivate" with no reason is how a
 * merchant ends up phoning support about a checkbox.
 */

/** A business may operate this many counters. Matches the ceiling a version may name. */
export const MAX_LOCATIONS_PER_BUSINESS = MAX_AVAILABLE_LOCATIONS;

/** A location row as a mutation leaves it. The list adds the two derived counts. */
export interface LocationRecord {
  id: string;
  name: string;
  /** Free text, optional. Never geocoded, never sent anywhere: it is a note for staff. */
  address: string | null;
  isDefault: boolean;
  active: boolean;
}

export interface BusinessLocation extends LocationRecord {
  /** Staff assigned to this location. Counts only, never names, on a list screen. */
  assignedStaffCount: number;
  /** Programs whose ACTIVE version lists this location. Zero means "Main-only programs only". */
  programCount: number;
}

const nameSchema = z.string().trim().min(1).max(80);
const addressSchema = z.string().trim().min(1).max(200);

const createLocationSchema = z.strictObject({
  name: nameSchema,
  address: addressSchema.optional(),
});
export type CreateLocationInput = z.input<typeof createLocationSchema>;

const updateLocationSchema = z
  .strictObject({
    name: nameSchema.optional(),
    /** An empty string clears the note; omitting the field leaves it alone. */
    address: z.union([addressSchema, z.literal("")]).optional(),
  })
  .refine((v) => v.name !== undefined || v.address !== undefined, {
    message: "Nothing to update",
  });
export type UpdateLocationInput = z.input<typeof updateLocationSchema>;

/**
 * Every location of the caller's business, default first.
 *
 * `programCount` is derived by reading each live version's `availableLocations`, because that list
 * lives inside the immutable mechanics rather than in a join table — the same reason a merchant
 * publishes a new version to open a branch instead of editing the old one.
 */
export async function listBusinessLocations(ctx: TenantContext): Promise<BusinessLocation[]> {
  requirePermission(ctx, Permission.VIEW_LOCATIONS);

  const [locations, versions] = await Promise.all([
    prisma.location.findMany({
      where: { businessId: ctx.businessId },
      select: {
        id: true,
        name: true,
        address: true,
        isDefault: true,
        active: true,
        _count: { select: { staff: true } },
      },
      orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }],
    }),
    prisma.programVersion.findMany({
      where: { status: "ACTIVE", template: { businessId: ctx.businessId, status: { in: ["ACTIVE", "PAUSED"] } } },
      select: { mechanics: true },
    }),
  ]);

  const programsPerLocation = new Map<string, number>();
  for (const version of versions) {
    const listed = (version.mechanics as { availableLocations?: unknown }).availableLocations;
    if (!Array.isArray(listed)) continue;
    for (const id of listed) {
      if (typeof id === "string") programsPerLocation.set(id, (programsPerLocation.get(id) ?? 0) + 1);
    }
  }

  return locations.map((l) => ({
    id: l.id,
    name: l.name,
    address: l.address,
    isDefault: l.isDefault,
    active: l.active,
    assignedStaffCount: l._count.staff,
    programCount: programsPerLocation.get(l.id) ?? 0,
  }));
}

/** Load one location inside the caller's tenant, or refuse exactly as if it did not exist. */
async function requireOwnLocation(db: Tx, businessId: string, locationId: string) {
  const location = await db.location.findFirst({
    where: { id: locationId, businessId },
    select: { id: true, name: true, address: true, isDefault: true, active: true },
  });
  if (!location) throw new NotFoundError("Location not found");
  return location;
}

/**
 * Two counters a merchant cannot tell apart are a reporting problem, not a naming preference.
 *
 * Case- and space-insensitive, and scoped to ACTIVE locations only: a name freed by deactivating a
 * branch can be used again, which is what a merchant who closed "Branch" and opened a new one in
 * the next street actually wants.
 */
async function assertNameFree(db: Tx, businessId: string, name: string, exceptId?: string): Promise<void> {
  const wanted = name.trim().toLocaleLowerCase();
  // Folded in JS rather than with Prisma's `mode: "insensitive"`, which is a case-insensitive LIKE
  // and would still treat "Main  Street" and "Main Street" as different names. The set is bounded
  // by MAX_LOCATIONS_PER_BUSINESS, so reading it is cheaper than the comparison is subtle.
  const active = await db.location.findMany({
    where: { businessId, active: true, ...(exceptId ? { id: { not: exceptId } } : {}) },
    select: { name: true },
  });
  if (active.some((l) => l.name.trim().toLocaleLowerCase() === wanted)) {
    throw new ConflictError("This business already has an active location with that name", ConflictCode.NAME_TAKEN);
  }
}

/**
 * Open a counter.
 *
 * The new location is active and never the default — `Location_one_default_per_business` makes the
 * default permanent, and moving it would silently change where every Phase 1a version writes.
 *
 * It is created with **no staff assigned and no program running at it**, which is the safe default
 * in both directions: nobody can transact there until a manager assigns them, and no existing card
 * changes behaviour because existing versions are immutable and do not name it. To run a program
 * there the merchant publishes a new version — which is the lifecycle in `program/versions.ts`.
 */
export async function createLocation(ctx: TenantContext, input: CreateLocationInput): Promise<LocationRecord> {
  requirePermission(ctx, Permission.EDIT_LOCATIONS);
  const parsed = createLocationSchema.safeParse(input);
  if (!parsed.success) throw new ValidationError("Invalid location", parsed.error.issues);
  const data = parsed.data;

  return prisma.$transaction(async (tx) => {
    // Serialise on the business row, exactly as program creation does: two managers clicking at
    // once would otherwise both pass the ceiling and the name check.
    await tx.$executeRaw`SELECT id FROM "Business" WHERE id = ${ctx.businessId} FOR UPDATE`;

    const existing = await tx.location.count({ where: { businessId: ctx.businessId, active: true } });
    if (existing >= MAX_LOCATIONS_PER_BUSINESS) {
      throw new ConflictError(`A business may operate at most ${MAX_LOCATIONS_PER_BUSINESS} active locations`);
    }
    await assertNameFree(tx, ctx.businessId, data.name);

    const created = await tx.location.create({
      data: {
        businessId: ctx.businessId,
        name: data.name,
        address: data.address ?? null,
        isDefault: false,
        active: true,
      },
      select: { id: true, name: true, address: true, isDefault: true, active: true },
    });

    await recordAudit(tx, {
      businessId: ctx.businessId,
      actorUserId: ctx.userId,
      action: AuditAction.LOCATION_CREATED,
      entityType: "Location",
      entityId: created.id,
      // The name is the merchant's own label for their counter, and it is what makes an audit row
      // answerable months later. No address: a street is closer to personal data than a label is,
      // and the audit question is "which counter", not "where".
      metadata: { name: created.name, isDefault: false },
    });

    return created;
  }, CONTENDED_TX);
}

/**
 * Rename a counter, or change the note staff read on it.
 *
 * Renaming is safe by construction: nothing references a location by name. Every ledger row, every
 * staff assignment and every version's `availableLocations` holds the **id**, so a rename changes
 * what a screen says and nothing about what happened.
 */
export async function updateLocation(
  ctx: TenantContext,
  locationId: string,
  input: UpdateLocationInput,
): Promise<LocationRecord> {
  requirePermission(ctx, Permission.EDIT_LOCATIONS);
  const parsed = updateLocationSchema.safeParse(input);
  if (!parsed.success) throw new ValidationError("Invalid location", parsed.error.issues);
  const data = parsed.data;

  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT id FROM "Business" WHERE id = ${ctx.businessId} FOR UPDATE`;
    const location = await requireOwnLocation(tx, ctx.businessId, locationId);
    if (data.name !== undefined) await assertNameFree(tx, ctx.businessId, data.name, location.id);

    const updated = await tx.location.update({
      where: { id: location.id },
      data: {
        ...(data.name !== undefined ? { name: data.name } : {}),
        ...(data.address !== undefined ? { address: data.address === "" ? null : data.address } : {}),
      },
      select: { id: true, name: true, address: true, isDefault: true, active: true },
    });

    await recordAudit(tx, {
      businessId: ctx.businessId,
      actorUserId: ctx.userId,
      action: AuditAction.LOCATION_UPDATED,
      entityType: "Location",
      entityId: location.id,
      // What changed, and the new label. The previous name is in the earlier audit row; repeating
      // it here would not add an answer and would double how much of a merchant's data this table
      // carries.
      metadata: { name: updated.name, addressChanged: data.address !== undefined },
    });

    return updated;
  }, CONTENDED_TX);
}

/** A live program that would be left with nowhere to trade. */
interface StrandedProgram {
  templateId: string;
  name: string;
}

/**
 * Which live programs would have no active counter left if `locationId` went inactive.
 *
 * A version that names nothing runs at the default location, which this function never has to
 * consider because deactivating the default is refused outright. A version that names locations is
 * checked against the set that would remain active.
 */
async function strandedPrograms(db: Tx, businessId: string, locationId: string): Promise<StrandedProgram[]> {
  const [remainingActive, versions] = await Promise.all([
    db.location.findMany({
      where: { businessId, active: true, id: { not: locationId } },
      select: { id: true },
    }),
    db.programVersion.findMany({
      where: {
        status: ProgramVersionStatus.ACTIVE,
        template: { businessId, status: { in: [TemplateStatus.ACTIVE, TemplateStatus.PAUSED] } },
      },
      select: { mechanics: true, template: { select: { id: true, name: true } } },
    }),
  ]);
  const stillActive = new Set(remainingActive.map((l) => l.id));

  const stranded: StrandedProgram[] = [];
  for (const version of versions) {
    // Read through the contracts rather than off the raw JSON, for the same reason the program list
    // does: a row that parses as neither contract is corrupt, and treating it as "Main only" is the
    // reading that cannot strand anything.
    const listed = isPointsMechanics(version.mechanics)
      ? readPointsMechanics(version.mechanics).availableLocations
      : isStampMechanics(version.mechanics)
        ? readStampMechanics(version.mechanics).availableLocations
        : undefined;
    if (listed === undefined) continue; // Main-only; Main is never deactivated.
    if (!listed.includes(locationId)) continue;
    if (!listed.some((id) => stillActive.has(id))) {
      stranded.push({ templateId: version.template.id, name: version.template.name });
    }
  }
  return stranded;
}

/**
 * Close a counter, or open it again.
 *
 * Reactivation is deliberately as ordinary as deactivation: a branch that reopens is the same
 * counter, with the same id, so its history joins back up rather than starting again under a new
 * row. The only check on the way back in is the name, because another location may have taken it.
 */
export async function setLocationActive(ctx: TenantContext, locationId: string, active: boolean): Promise<LocationRecord> {
  requirePermission(ctx, Permission.EDIT_LOCATIONS);

  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT id FROM "Business" WHERE id = ${ctx.businessId} FOR UPDATE`;
    const location = await requireOwnLocation(tx, ctx.businessId, locationId);

    if (location.active !== active) {
      if (!active) {
        if (location.isDefault) {
          throw new ConflictError(
            "The main location is where enrolment and every main-only program writes, and cannot be closed",
            ConflictCode.LOCATION_IS_MAIN,
          );
        }
        const remaining = await tx.location.count({
          where: { businessId: ctx.businessId, active: true, id: { not: location.id } },
        });
        if (remaining === 0) {
          throw new ConflictError("A business must keep at least one active location", ConflictCode.LOCATION_LAST_ACTIVE);
        }
        const stranded = await strandedPrograms(tx, ctx.businessId, location.id);
        if (stranded.length > 0) {
          throw new ConflictError(
            `This is the only active counter for ${stranded.map((p) => p.name).join(", ")}; publish a new version of ${
              stranded.length === 1 ? "that program" : "those programs"
            } first`,
            ConflictCode.LOCATION_STRANDS_PROGRAM,
          );
        }
      } else {
        await assertNameFree(tx, ctx.businessId, location.name, location.id);
      }

      await tx.location.update({ where: { id: location.id }, data: { active } });
      await recordAudit(tx, {
        businessId: ctx.businessId,
        actorUserId: ctx.userId,
        action: active ? AuditAction.LOCATION_REACTIVATED : AuditAction.LOCATION_DEACTIVATED,
        entityType: "Location",
        entityId: location.id,
        metadata: { name: location.name },
      });
    }

    return tx.location.findFirstOrThrow({
      where: { id: location.id },
      select: { id: true, name: true, address: true, isDefault: true, active: true },
    });
  }, CONTENDED_TX);
}
