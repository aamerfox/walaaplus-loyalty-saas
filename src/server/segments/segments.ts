import { Permission, Prisma } from "@prisma/client";
import { z } from "zod";
import { AuditAction, recordAudit } from "../audit/audit";
import { prisma } from "../db";
import { ConflictCode, ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../errors";
import { requirePermission, type TenantContext } from "../tenant/context";
import {
  parseDefinition,
  readDefinition,
  SEGMENT_DEFINITION_VERSION,
  toProfileWhere,
  type SegmentCondition,
  type SegmentDefinition,
} from "./definition";

/**
 * Saved customer segments.
 *
 * A segment is a **definition a merchant saved**, re-evaluated against live data every time anyone
 * asks. It is not a stored list of people: a copied list goes stale the moment a customer earns a
 * stamp, and it is a second place personal data lives, with its own retention question and its own
 * leak. Nothing in this module writes a customer row anywhere.
 *
 * ## Who may see a count, and why it is not narrowed per viewer
 *
 * Reading segments needs `VIEW_SEGMENTS`; writing them needs `EDIT_SEGMENTS`. Both already exist in
 * the permission enum and are held by an owner and a manager.
 *
 * Counting one additionally requires a membership with **no branch restriction**. That is a
 * deliberate refusal rather than a narrowing, and the reason is what a count is FOR: a later phase
 * will send a campaign to the people a segment matches, and a count that quietly shrank to the
 * viewer's own branch would show one number to a manager, another to a branch-scoped colleague, and
 * send to a third set. A segment either means the same thing to everyone who can see it, or it is
 * not safe to build on. A restricted member is refused, which tells them something they can act on;
 * they are never shown a smaller number with no explanation.
 *
 * Since only an OWNER or MANAGER is unrestricted today, this is the same bar as browsing the
 * customer directory — which is the capability a segment is, made reusable.
 *
 * ## Archived, never deleted
 *
 * `archivedAt` hides a segment from the working list and keeps the row. A campaign in a later phase
 * will reference a segment by id, and a row that vanished would take the record of who was targeted
 * with it.
 */

/** A business may keep this many live segments. Enough for real use, bounded for the picker. */
export const MAX_SEGMENTS_PER_BUSINESS = 50;

/** Counting is bounded: a segment that matched everybody is still one `COUNT`, but the PREVIEW is not. */
export const MAX_PREVIEW = 20;

const nameSchema = z.string().trim().min(1).max(80);

/** "VIP", "vip" and "  VIP  " are one name. Stored alongside the display name and unique per business. */
export function normalizeSegmentName(name: string): string {
  return name.trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

export interface SegmentSummary {
  id: string;
  name: string;
  definition: SegmentDefinition | null;
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateSegmentInput {
  name: string;
  definition: unknown;
}

/**
 * Every id inside a definition must belong to the caller's business.
 *
 * Checked before the definition is SAVED, not only when it is evaluated. `toProfileWhere` scopes
 * every clause by `businessId` as well, so a foreign id would match nothing — but a segment that
 * silently matches nobody is a merchant staring at a zero with no idea why, and it would also mean
 * another business's program id sitting in this business's stored definition.
 */
async function assertDefinitionIsOwned(ctx: TenantContext, definition: SegmentDefinition): Promise<void> {
  const templateIds = new Set<string>();
  const locationIds = new Set<string>();
  const sourceNames = new Set<string>();
  for (const condition of definition.conditions as SegmentCondition[]) {
    if (condition.field === "program" || condition.field === "programVersion") templateIds.add(condition.templateId);
    if (condition.field === "servedAtLocation") locationIds.add(condition.locationId);
    if (condition.field === "source") sourceNames.add(condition.name);
  }

  const [templates, locations, sources] = await Promise.all([
    templateIds.size === 0
      ? []
      : prisma.programTemplate.findMany({
          where: { id: { in: [...templateIds] }, businessId: ctx.businessId },
          select: { id: true },
        }),
    locationIds.size === 0
      ? []
      : prisma.location.findMany({ where: { id: { in: [...locationIds] }, businessId: ctx.businessId }, select: { id: true } }),
    sourceNames.size === 0
      ? []
      : prisma.utmSourceLink.findMany({
          where: { name: { in: [...sourceNames] }, template: { businessId: ctx.businessId } },
          select: { name: true },
        }),
  ]);

  // "Does not belong to this business" and "does not exist" are the same message on purpose: a
  // merchant must not be able to probe a competitor's program ids by saving segments against them.
  if (templates.length !== templateIds.size) throw new ValidationError("A program in this segment is not one of yours");
  if (locations.length !== locationIds.size) throw new ValidationError("A branch in this segment is not one of yours");
  if (new Set(sources.map((s) => s.name)).size !== sourceNames.size) {
    throw new ValidationError("A source in this segment is not one of yours");
  }
}

function toSummary(row: {
  id: string;
  name: string;
  definition: Prisma.JsonValue;
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}): SegmentSummary {
  return { ...row, definition: readDefinition(row.definition) };
}

/** Every segment of this business, live ones first. */
export async function listSegments(ctx: TenantContext, opts: { includeArchived?: boolean } = {}): Promise<SegmentSummary[]> {
  requirePermission(ctx, Permission.VIEW_SEGMENTS);
  const rows = await prisma.customerSegment.findMany({
    where: { businessId: ctx.businessId, ...(opts.includeArchived ? {} : { archivedAt: null }) },
    select: { id: true, name: true, definition: true, archivedAt: true, createdAt: true, updatedAt: true },
    orderBy: [{ archivedAt: "asc" }, { createdAt: "desc" }],
    take: MAX_SEGMENTS_PER_BUSINESS * 2,
  });
  return rows.map(toSummary);
}

/** Load one segment inside the caller's tenant, or refuse exactly as if it did not exist. */
async function requireOwnSegment(ctx: TenantContext, segmentId: string) {
  const segment = await prisma.customerSegment.findFirst({
    where: { id: segmentId, businessId: ctx.businessId },
    select: { id: true, name: true, definition: true, archivedAt: true, createdAt: true, updatedAt: true },
  });
  if (!segment) throw new NotFoundError("Segment not found");
  return segment;
}

export async function getSegment(ctx: TenantContext, segmentId: string): Promise<SegmentSummary> {
  requirePermission(ctx, Permission.VIEW_SEGMENTS);
  return toSummary(await requireOwnSegment(ctx, segmentId));
}

export async function createSegment(ctx: TenantContext, input: CreateSegmentInput): Promise<SegmentSummary> {
  requirePermission(ctx, Permission.EDIT_SEGMENTS);
  const name = nameSchema.parse(input.name);
  const definition = parseDefinition(input.definition);
  await assertDefinitionIsOwned(ctx, definition);

  const live = await prisma.customerSegment.count({ where: { businessId: ctx.businessId, archivedAt: null } });
  if (live >= MAX_SEGMENTS_PER_BUSINESS) {
    throw new ConflictError(`A business may keep at most ${MAX_SEGMENTS_PER_BUSINESS} segments`);
  }

  try {
    return await prisma.$transaction(async (tx) => {
      const created = await tx.customerSegment.create({
        data: {
          businessId: ctx.businessId,
          name,
          normalizedName: normalizeSegmentName(name),
          definition: definition as unknown as Prisma.InputJsonObject,
          definitionVersion: SEGMENT_DEFINITION_VERSION,
          createdByUserId: ctx.userId,
        },
        select: { id: true, name: true, definition: true, archivedAt: true, createdAt: true, updatedAt: true },
      });
      await recordAudit(tx, {
        businessId: ctx.businessId,
        actorUserId: ctx.userId,
        action: AuditAction.SEGMENT_CREATED,
        entityType: "CustomerSegment",
        entityId: created.id,
        // The definition, never the people it matches: an audit row is read by more people and kept
        // far longer than the screen that legitimately shows a count.
        metadata: { name, definition: definition as unknown as Prisma.InputJsonObject },
      });
      return toSummary(created);
    });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      throw new ConflictError("This business already has a segment with that name", ConflictCode.NAME_TAKEN);
    }
    throw e;
  }
}

export interface UpdateSegmentInput {
  name?: string;
  definition?: unknown;
}

/** Rename a segment, change what it means, or both. An archived segment is edited only after it is restored. */
export async function updateSegment(ctx: TenantContext, segmentId: string, input: UpdateSegmentInput): Promise<SegmentSummary> {
  requirePermission(ctx, Permission.EDIT_SEGMENTS);
  if (input.name === undefined && input.definition === undefined) throw new ValidationError("Nothing to update");

  const existing = await requireOwnSegment(ctx, segmentId);
  if (existing.archivedAt !== null) throw new ConflictError("This segment is archived; restore it before editing");

  const name = input.name === undefined ? undefined : nameSchema.parse(input.name);
  let definition: SegmentDefinition | undefined;
  if (input.definition !== undefined) {
    definition = parseDefinition(input.definition);
    await assertDefinitionIsOwned(ctx, definition);
  }

  try {
    return await prisma.$transaction(async (tx) => {
      const updated = await tx.customerSegment.update({
        where: { id: existing.id },
        data: {
          ...(name !== undefined ? { name, normalizedName: normalizeSegmentName(name) } : {}),
          ...(definition !== undefined
            ? { definition: definition as unknown as Prisma.InputJsonObject, definitionVersion: SEGMENT_DEFINITION_VERSION }
            : {}),
        },
        select: { id: true, name: true, definition: true, archivedAt: true, createdAt: true, updatedAt: true },
      });
      await recordAudit(tx, {
        businessId: ctx.businessId,
        actorUserId: ctx.userId,
        action: AuditAction.SEGMENT_UPDATED,
        entityType: "CustomerSegment",
        entityId: existing.id,
        metadata: {
          name: updated.name,
          definitionChanged: definition !== undefined,
          ...(definition ? { definition: definition as unknown as Prisma.InputJsonObject } : {}),
        },
      });
      return toSummary(updated);
    });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      throw new ConflictError("This business already has a segment with that name", ConflictCode.NAME_TAKEN);
    }
    throw e;
  }
}

/**
 * Archive a segment, or restore one.
 *
 * There is no delete. A later phase's campaigns will reference a segment by id, and "who did we
 * send this to" is a question a merchant is entitled to be able to answer afterwards.
 *
 * A restore re-checks the name, because another segment may have taken it while this one was away.
 */
export async function setSegmentArchived(ctx: TenantContext, segmentId: string, archived: boolean): Promise<SegmentSummary> {
  requirePermission(ctx, Permission.EDIT_SEGMENTS);
  const existing = await requireOwnSegment(ctx, segmentId);
  if ((existing.archivedAt !== null) === archived) return toSummary(existing);

  try {
    return await prisma.$transaction(async (tx) => {
      const updated = await tx.customerSegment.update({
        where: { id: existing.id },
        data: { archivedAt: archived ? new Date() : null },
        select: { id: true, name: true, definition: true, archivedAt: true, createdAt: true, updatedAt: true },
      });
      await recordAudit(tx, {
        businessId: ctx.businessId,
        actorUserId: ctx.userId,
        action: archived ? AuditAction.SEGMENT_ARCHIVED : AuditAction.SEGMENT_RESTORED,
        entityType: "CustomerSegment",
        entityId: existing.id,
        metadata: { name: updated.name },
      });
      return toSummary(updated);
    });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      throw new ConflictError("Another segment has taken that name; rename this one before restoring it", ConflictCode.NAME_TAKEN);
    }
    throw e;
  }
}

export interface SegmentCount {
  /** Customers this definition matches right now. Derived on every read, never stored. */
  customers: number;
  /** A handful of matches, for a merchant to sanity-check what they just described. */
  preview: { customerBusinessProfileId: string; firstName: string | null; lastName: string | null }[];
}

/**
 * How many customers a definition matches, and a few of them.
 *
 * The definition may be an unsaved one — that is how the editor previews a selection before it is
 * saved — so it is validated and tenant-checked here exactly as it would be on save.
 *
 * The preview carries a name and an id. No phone number, no card, no token: a merchant checking
 * "did I mean this?" needs to recognise a few people, not to be handed a contact list, and the
 * customer record is one click away with its own authorization.
 */
export async function countSegment(ctx: TenantContext, input: unknown): Promise<SegmentCount> {
  requirePermission(ctx, Permission.VIEW_SEGMENTS);
  if (ctx.locationIds !== null) {
    // See the note at the top of this file: a count narrowed per viewer is a different number on
    // every screen, and a campaign built on it would target a set nobody saw.
    throw new ForbiddenError("Counting a segment needs access to every branch of the business");
  }

  const definition = parseDefinition(input);
  await assertDefinitionIsOwned(ctx, definition);
  const where = toProfileWhere(definition, ctx.businessId);

  const [customers, preview] = await Promise.all([
    prisma.customerBusinessProfile.count({ where }),
    prisma.customerBusinessProfile.findMany({
      where,
      select: { id: true, firstName: true, lastName: true },
      orderBy: { id: "asc" },
      take: MAX_PREVIEW,
    }),
  ]);

  return {
    customers,
    preview: preview.map((p) => ({ customerBusinessProfileId: p.id, firstName: p.firstName, lastName: p.lastName })),
  };
}
