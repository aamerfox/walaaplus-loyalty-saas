import { Permission, Prisma, TemplateStatus } from "@prisma/client";
import { z } from "zod";
import { AuditAction, recordAudit } from "../audit/audit";
import { prisma } from "../db";
import { ConflictCode, ConflictError, NotFoundError, ValidationError } from "../errors";
import { opaqueToken } from "../security/tokens";
import { requirePermission, type TenantContext } from "../tenant/context";
import { DIRECT_SOURCE_NAME, DIRECT_UTM_SOURCE } from "./sources";

/**
 * Named enrolment sources: where a card came from.
 *
 * A merchant wants to know that the Instagram campaign brought 40 customers and the table cards
 * brought 6. `UtmSourceLink` is how: every card carries `utmSourceLinkId`, and every profile keeps
 * the `utmSource/Medium/Campaign` it arrived with, so attribution is a property of the data rather
 * than a report that has to be reconstructed later.
 *
 * ## What this is NOT, and will not be until a decision says so
 *
 * Owner decision **B7 option 3** withdrew public self-service enrolment because a public form that
 * issues a card to a new phone number and nothing to an existing one tells whoever submits it which
 * case they hit. Named links are exactly the kind of thing that would quietly restore it — a link
 * per campaign, each one a public page with a phone field.
 *
 * So the rule this module enforces is: **a named link is a server-side attribution record.** It
 * carries a high-entropy token because the schema requires one and because a future phase will need
 * it, and **nothing here ever returns that token to a caller.** There is no public route that
 * accepts it, no screen that prints it, and no QR that encodes it. When phone-ownership
 * verification is authorized and independently audited, the token becomes usable and the reveal
 * belongs in that change, with that review — not here, ahead of it.
 */

/** A template may carry this many named sources. Bounds the picker and the attribution report. */
export const MAX_SOURCE_LINKS_PER_TEMPLATE = 50;

const createSourceLinkSchema = z.strictObject({
  templateId: z.string().trim().min(1).max(64),
  /** Human-facing, unique per template (`@@unique([templateId, name])`). */
  name: z.string().trim().min(1).max(120),
  /** UTM triple. Several links may share a `utmSource`; `direct` is reserved for the automatic one. */
  utmSource: z.string().trim().min(1).max(60),
  utmMedium: z.string().trim().min(1).max(60).optional(),
  utmCampaign: z.string().trim().min(1).max(120).optional(),
  /**
   * Per-source override of the program's welcome bonus (PRODUCT-SPEC §6.1), in whichever unit the
   * program uses. Absent = the program's own bonus applies.
   */
  welcomeUnitQuantity: z.number().int().min(0).max(1_000_000).optional(),
  welcomeBonusExpiresAfterDays: z.number().int().min(1).max(3_650).optional(),
});
export type CreateSourceLinkInput = z.input<typeof createSourceLinkSchema>;

export interface SourceLinkSummary {
  id: string;
  templateId: string;
  name: string;
  utmSource: string;
  utmMedium: string | null;
  utmCampaign: string | null;
  welcomeUnitQuantity: number | null;
  active: boolean;
  /**
   * The built-in counter source every program is created with.
   *
   * It is what `enrollAtCounter` resolves, so it cannot be renamed, deactivated or removed — and a
   * screen must be able to say so without re-deriving it from a reserved string of its own.
   */
  isDirect: boolean;
  /** Cards attributed to this source. The number a merchant actually asked for. */
  cardCount: number;
  createdAt: Date;
}

/** Load a template inside the caller's tenant, or refuse exactly as if it did not exist. */
async function requireOwnTemplate(ctx: TenantContext, templateId: string) {
  const template = await prisma.programTemplate.findFirst({
    where: { id: templateId, businessId: ctx.businessId },
    select: { id: true, status: true },
  });
  if (!template) throw new NotFoundError("Program not found");
  return template;
}

/**
 * Create a named source for one of this business's programs.
 *
 * Requires EDIT_TEMPLATES — the same permission that creates the program, because a source with a
 * welcome-bonus override changes what a card is worth on issue.
 */
export async function createSourceLink(ctx: TenantContext, input: CreateSourceLinkInput): Promise<SourceLinkSummary> {
  requirePermission(ctx, Permission.EDIT_TEMPLATES);
  const parsed = createSourceLinkSchema.safeParse(input);
  if (!parsed.success) throw new ValidationError("Invalid source link", parsed.error.issues);
  const data = parsed.data;

  if (data.utmSource.toLocaleLowerCase() === DIRECT_UTM_SOURCE) {
    throw new ValidationError(`"${DIRECT_UTM_SOURCE}" is reserved for the source every program is created with`);
  }
  if (data.name.toLocaleLowerCase() === DIRECT_SOURCE_NAME.toLocaleLowerCase()) {
    throw new ValidationError(`"${DIRECT_SOURCE_NAME}" is reserved for the source every program is created with`);
  }

  const template = await requireOwnTemplate(ctx, data.templateId);
  if (template.status === TemplateStatus.ARCHIVED) {
    throw new ConflictError("This program is archived and cannot take new sources");
  }

  const existing = await prisma.utmSourceLink.count({ where: { templateId: template.id } });
  if (existing >= MAX_SOURCE_LINKS_PER_TEMPLATE) {
    throw new ConflictError(`A program may have at most ${MAX_SOURCE_LINKS_PER_TEMPLATE} sources`);
  }

  try {
    return await prisma.$transaction(async (tx) => {
      const link = await tx.utmSourceLink.create({
        data: {
          templateId: template.id,
          name: data.name,
          // Minted now so the record is complete and a later phase does not have to backfill one.
          // It is never returned by this module; see the note at the top of the file.
          publicToken: opaqueToken(),
          utmSource: data.utmSource,
          utmMedium: data.utmMedium ?? null,
          utmCampaign: data.utmCampaign ?? null,
          welcomeUnitQuantity: data.welcomeUnitQuantity ?? null,
          welcomeBonusExpiresAfterDays: data.welcomeBonusExpiresAfterDays ?? null,
          active: true,
        },
        select: {
          id: true,
          templateId: true,
          name: true,
          utmSource: true,
          utmMedium: true,
          utmCampaign: true,
          welcomeUnitQuantity: true,
          active: true,
          createdAt: true,
        },
      });

      await recordAudit(tx, {
        businessId: ctx.businessId,
        actorUserId: ctx.userId,
        action: AuditAction.SOURCE_LINK_CREATED,
        entityType: "UtmSourceLink",
        entityId: link.id,
        // The token is a capability and is never written to the audit log.
        metadata: {
          templateId: template.id,
          utmSource: link.utmSource,
          utmMedium: link.utmMedium,
          utmCampaign: link.utmCampaign,
          welcomeUnitQuantity: link.welcomeUnitQuantity,
        },
      });

      return { ...link, isDirect: false, cardCount: 0 };
    });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      throw new ConflictError("This program already has a source with that name", ConflictCode.NAME_TAKEN);
    }
    throw e;
  }
}

/**
 * Every named source for this business, newest program first, with the cards each one brought.
 *
 * Tenant-scoped through the template join, and deliberately token-free: this is the list a
 * reporting screen renders.
 */
export async function listSourceLinks(ctx: TenantContext, templateId?: string): Promise<SourceLinkSummary[]> {
  requirePermission(ctx, Permission.VIEW_TEMPLATES);
  if (templateId) await requireOwnTemplate(ctx, templateId);

  const links = await prisma.utmSourceLink.findMany({
    where: {
      template: { businessId: ctx.businessId },
      ...(templateId ? { templateId } : {}),
    },
    select: {
      id: true,
      templateId: true,
      name: true,
      utmSource: true,
      utmMedium: true,
      utmCampaign: true,
      welcomeUnitQuantity: true,
      active: true,
      createdAt: true,
      _count: { select: { cards: true } },
    },
    orderBy: [{ templateId: "asc" }, { createdAt: "asc" }],
  });

  return links.map(({ _count, ...link }) => ({
    ...link,
    isDirect: link.utmSource === DIRECT_UTM_SOURCE,
    cardCount: _count.cards,
  }));
}

const updateSourceLinkSchema = z
  .strictObject({
    name: z.string().trim().min(1).max(120).optional(),
    utmMedium: z.union([z.string().trim().min(1).max(60), z.literal("")]).optional(),
    utmCampaign: z.union([z.string().trim().min(1).max(120), z.literal("")]).optional(),
  })
  .refine((v) => Object.values(v).some((field) => field !== undefined), { message: "Nothing to update" });
export type UpdateSourceLinkInput = z.input<typeof updateSourceLinkSchema>;

/**
 * Rename a source, or correct its campaign fields.
 *
 * **`utmSource` is deliberately not editable, and neither is the welcome bonus.** Both are baked
 * into cards that have already been issued: a card carries `utmSourceLinkId`, and the profile
 * behind it carries the `utmSource` it arrived with. Editing either would rewrite the meaning of
 * history — last month's forty cards would silently be reported as having come from somewhere they
 * did not — and the welcome bonus a customer was given cannot be changed after they were given it.
 * A merchant who wants different terms creates a new source; the old one is deactivated and keeps
 * its cards.
 *
 * A rename is safe for the same reason a location rename is: nothing joins on the name.
 */
export async function updateSourceLink(
  ctx: TenantContext,
  sourceLinkId: string,
  input: UpdateSourceLinkInput,
): Promise<SourceLinkSummary> {
  requirePermission(ctx, Permission.EDIT_TEMPLATES);
  const parsed = updateSourceLinkSchema.safeParse(input);
  if (!parsed.success) throw new ValidationError("Invalid source", parsed.error.issues);
  const data = parsed.data;

  const link = await prisma.utmSourceLink.findFirst({
    where: { id: sourceLinkId, template: { businessId: ctx.businessId } },
    select: { id: true, templateId: true, utmSource: true },
  });
  if (!link) throw new NotFoundError("Source not found");
  if (link.utmSource === DIRECT_UTM_SOURCE) {
    throw new ConflictError("The counter source is built in and cannot be renamed", ConflictCode.SOURCE_PROTECTED);
  }
  if (data.name !== undefined && data.name.toLocaleLowerCase() === DIRECT_SOURCE_NAME.toLocaleLowerCase()) {
    throw new ValidationError(`"${DIRECT_SOURCE_NAME}" is reserved for the source every program is created with`);
  }

  try {
    return await prisma.$transaction(async (tx) => {
      const updated = await tx.utmSourceLink.update({
        where: { id: link.id },
        data: {
          ...(data.name !== undefined ? { name: data.name } : {}),
          ...(data.utmMedium !== undefined ? { utmMedium: data.utmMedium === "" ? null : data.utmMedium } : {}),
          ...(data.utmCampaign !== undefined ? { utmCampaign: data.utmCampaign === "" ? null : data.utmCampaign } : {}),
        },
        select: {
          id: true,
          templateId: true,
          name: true,
          utmSource: true,
          utmMedium: true,
          utmCampaign: true,
          welcomeUnitQuantity: true,
          active: true,
          createdAt: true,
          _count: { select: { cards: true } },
        },
      });

      await recordAudit(tx, {
        businessId: ctx.businessId,
        actorUserId: ctx.userId,
        action: AuditAction.SOURCE_LINK_UPDATED,
        entityType: "UtmSourceLink",
        entityId: link.id,
        // The token is a capability and is never written to the audit log.
        metadata: { templateId: link.templateId, name: updated.name, utmMedium: updated.utmMedium, utmCampaign: updated.utmCampaign },
      });

      const { _count, ...rest } = updated;
      return { ...rest, isDirect: false, cardCount: _count.cards };
    });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      throw new ConflictError("This program already has a source with that name", ConflictCode.NAME_TAKEN);
    }
    throw e;
  }
}

/**
 * Turn a named source on or off.
 *
 * `active: false` means "stop attributing new cards to this", which is what a merchant means when a
 * campaign ends. It does not touch the cards already attributed to it: attribution is history, and
 * history does not change because a campaign finished.
 *
 * The `direct` source cannot be deactivated. It is the source counter enrolment resolves, so
 * switching it off would stop staff being able to issue a card at all — a program-wide outage from
 * a screen that looks like it is tidying up a list.
 */
export async function setSourceLinkActive(ctx: TenantContext, sourceLinkId: string, active: boolean): Promise<void> {
  requirePermission(ctx, Permission.EDIT_TEMPLATES);
  const link = await prisma.utmSourceLink.findFirst({
    where: { id: sourceLinkId, template: { businessId: ctx.businessId } },
    select: { id: true, utmSource: true, active: true },
  });
  if (!link) throw new NotFoundError("Source not found");
  if (link.utmSource === DIRECT_UTM_SOURCE && !active) {
    throw new ConflictError(
      "The direct source is how staff enrol customers and cannot be deactivated",
      ConflictCode.SOURCE_PROTECTED,
    );
  }
  if (link.active === active) return;

  await prisma.$transaction(async (tx) => {
    await tx.utmSourceLink.update({ where: { id: link.id }, data: { active } });
    await recordAudit(tx, {
      businessId: ctx.businessId,
      actorUserId: ctx.userId,
      action: AuditAction.SOURCE_LINK_ACTIVATION_CHANGED,
      entityType: "UtmSourceLink",
      entityId: link.id,
      metadata: { active },
    });
  });
}
