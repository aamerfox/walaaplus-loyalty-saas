import { CampaignChannel, CampaignState, Permission, Prisma } from "@prisma/client";
import { z } from "zod";
import { AuditAction, recordAudit } from "../audit/audit";
import { marketingEligibleProfileIds } from "../consent/consent";
import { invalidateApprovalForEdit } from "./approvals";
import { readinessOf, type DeliveryReadiness } from "./delivery";
import { prisma } from "../db";
import { ConflictCode, ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../errors";
import { readDefinition, toProfileWhere } from "../segments/definition";
import { requirePermission, type TenantContext } from "../tenant/context";
import { assertPlaceholdersValid, type PlaceholderName } from "./placeholders";

/**
 * Campaign drafts. Nothing here sends anything.
 *
 * ## What "cannot send" means structurally, not as a promise
 *
 * `CampaignState` has five values — `DRAFT`, `IN_REVIEW`, `APPROVED`, `WITHDRAWN`, `ARCHIVED` — and
 * there is no `SENT`, `SCHEDULED`, `QUEUED` or `SENDING` for a service to move a row into. There is
 * no provider client, no queue, no worker job and no outbound HTTP call anywhere in this module or
 * reachable from it. `src/server/campaigns/delivery.ts` is the only thing shaped like a delivery
 * port, and its sole implementation throws on its first line.
 *
 * ## Who writes which state
 *
 * This module owns the three a merchant drives: `DRAFT`, `IN_REVIEW` and `ARCHIVED`. `APPROVED` and
 * `WITHDRAWN` are written **only** by `approvals.ts`, as a consequence of an append-only decision
 * row existing. That split is the point: an approval is a record, not a label somebody can set.
 *
 * The reserved delivery model from Phase 0 — `PushMessage` and `PushMessageStatus`, which does have
 * a `SENT` — is untouched and separate. A later phase joins the two; this one does not.
 *
 * ## Content is revisioned, not edited
 *
 * Every save writes a new `CampaignRevision`, and the table rejects `UPDATE` and `DELETE` by
 * trigger. "What did this draft say last Tuesday" therefore has an answer, which matters for a
 * message a merchant intends to send to their customers.
 *
 * ## The audience is a reference, never a list
 *
 * A campaign points at a saved segment by id. The people it matches are re-derived from the live
 * definition every time anybody asks, and **no recipient identity is returned, stored, or rendered
 * anywhere** — the preview is three integers and nothing else. That is not a limitation of this
 * prompt, it is the design: a stored recipient list is a copy of customer data that goes stale and
 * has its own retention question.
 *
 * ## Permissions
 *
 * `VIEW_PUSHES` reads, `EDIT_PUSHES` writes. Both already exist in the `Permission` enum and are
 * held by an owner and a manager — they are the product's engagement permissions, and inventing a
 * parallel one would be a second authorization model for the same thing.
 *
 * Previewing an audience additionally requires a membership with no branch restriction, for exactly
 * the reason counting a segment does: a number that shrank to the viewer's own branch would be a
 * different number on every screen.
 */

/** A business may keep this many live drafts. Bounded for the list, generous for real use. */
export const MAX_CAMPAIGNS_PER_BUSINESS = 100;

/** A subject and a body are a message, not a document. */
const MAX_SUBJECT = 120;
const MAX_BODY = 1_000;

const nameSchema = z.string().trim().min(1).max(80);

/** "Autumn", "autumn" and "  Autumn " are one name, as they are for segments. */
export function normalizeCampaignName(name: string): string {
  return name.trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

export interface CampaignRevisionView {
  revisionNumber: number;
  subject: string | null;
  body: string;
  authorName: string | null;
  createdAt: Date;
}

export interface CampaignSummary {
  id: string;
  name: string;
  locale: string;
  channel: CampaignChannel;
  state: CampaignState;
  segmentId: string | null;
  segmentName: string | null;
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  /** The newest revision, which is what the editor opens. */
  latestRevision: CampaignRevisionView | null;
  revisionCount: number;
  /** The revision a standing approval covers, or null. Never assume it is the latest one. */
  approvedRevisionNumber: number | null;
  approvedAt: Date | null;
  /** How many people the snapshot behind that approval recorded as contactable. */
  approvedAudienceSize: number | null;
  /**
   * Why this still cannot be delivered. Always present, always `deliverable: false`, so a screen
   * cannot render an approved campaign without also rendering what approval did not buy.
   */
  readiness: DeliveryReadiness;
}

const CAMPAIGN_SELECT = {
  id: true,
  name: true,
  locale: true,
  channel: true,
  state: true,
  segmentId: true,
  archivedAt: true,
  createdAt: true,
  updatedAt: true,
  approvedRevisionNumber: true,
  approvedAt: true,
  segment: { select: { name: true } },
  // The COUNT behind a standing approval, never its membership. There is no select anywhere in
  // this codebase that reads CampaignAudienceMember rows out to a caller.
  approvedSnapshot: { select: { eligibleCount: true } },
  _count: { select: { revisions: true } },
  revisions: {
    orderBy: { revisionNumber: "desc" as const },
    take: 1,
    select: {
      revisionNumber: true,
      subject: true,
      body: true,
      createdAt: true,
      createdBy: { select: { firstName: true, lastName: true } },
    },
  },
} satisfies Prisma.CampaignSelect;

type CampaignRow = Prisma.CampaignGetPayload<{ select: typeof CAMPAIGN_SELECT }>;

function toSummary(row: CampaignRow): CampaignSummary {
  const revision = row.revisions[0];
  return {
    id: row.id,
    name: row.name,
    locale: row.locale,
    channel: row.channel,
    state: row.state,
    segmentId: row.segmentId,
    segmentName: row.segment?.name ?? null,
    archivedAt: row.archivedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    latestRevision: revision
      ? {
          revisionNumber: revision.revisionNumber,
          subject: revision.subject,
          body: revision.body,
          // A name, never an email: a draft list is read by everyone who can open the screen.
          authorName: [revision.createdBy?.firstName, revision.createdBy?.lastName].filter(Boolean).join(" ") || null,
          createdAt: revision.createdAt,
        }
      : null,
    revisionCount: row._count.revisions,
    approvedRevisionNumber: row.approvedRevisionNumber,
    approvedAt: row.approvedAt,
    approvedAudienceSize: row.approvedSnapshot?.eligibleCount ?? null,
    readiness: readinessOf({
      state: row.state,
      approvedRevisionNumber: row.approvedRevisionNumber,
      approvedAudienceSize: row.approvedSnapshot?.eligibleCount ?? null,
    }),
  };
}

/** Load a draft inside the caller's tenant, or refuse exactly as if it did not exist. */
async function requireOwnCampaign(ctx: TenantContext, campaignId: string): Promise<CampaignRow> {
  const campaign = await prisma.campaign.findFirst({
    where: { id: campaignId, businessId: ctx.businessId },
    select: CAMPAIGN_SELECT,
  });
  if (!campaign) throw new NotFoundError("Campaign not found");
  return campaign;
}

/** A segment id, verified against the caller's tenant, or null. */
async function resolveSegment(ctx: TenantContext, segmentId: string | null | undefined): Promise<string | null> {
  if (!segmentId) return null;
  const segment = await prisma.customerSegment.findFirst({
    where: { id: segmentId, businessId: ctx.businessId },
    select: { id: true, archivedAt: true },
  });
  // Another business's segment id and one that does not exist get the same answer.
  if (!segment) throw new ValidationError("That segment is not one of yours");
  if (segment.archivedAt !== null) throw new ConflictError("That segment is archived; restore it or choose another");
  return segment.id;
}

export async function listCampaigns(
  ctx: TenantContext,
  opts: { includeArchived?: boolean } = {},
): Promise<CampaignSummary[]> {
  requirePermission(ctx, Permission.VIEW_PUSHES);
  const rows = await prisma.campaign.findMany({
    where: { businessId: ctx.businessId, ...(opts.includeArchived ? {} : { archivedAt: null }) },
    select: CAMPAIGN_SELECT,
    orderBy: [{ archivedAt: "asc" }, { updatedAt: "desc" }],
    take: MAX_CAMPAIGNS_PER_BUSINESS * 2,
  });
  return rows.map(toSummary);
}

export async function getCampaign(ctx: TenantContext, campaignId: string): Promise<CampaignSummary> {
  requirePermission(ctx, Permission.VIEW_PUSHES);
  return toSummary(await requireOwnCampaign(ctx, campaignId));
}

/** The whole revision history of one draft, newest first. */
export async function listCampaignRevisions(ctx: TenantContext, campaignId: string): Promise<CampaignRevisionView[]> {
  requirePermission(ctx, Permission.VIEW_PUSHES);
  await requireOwnCampaign(ctx, campaignId);
  const revisions = await prisma.campaignRevision.findMany({
    where: { campaignId },
    orderBy: { revisionNumber: "desc" },
    take: 50,
    select: {
      revisionNumber: true,
      subject: true,
      body: true,
      createdAt: true,
      createdBy: { select: { firstName: true, lastName: true } },
    },
  });
  return revisions.map((revision) => ({
    revisionNumber: revision.revisionNumber,
    subject: revision.subject,
    body: revision.body,
    authorName: [revision.createdBy?.firstName, revision.createdBy?.lastName].filter(Boolean).join(" ") || null,
    createdAt: revision.createdAt,
  }));
}

const contentSchema = z.strictObject({
  subject: z.string().trim().min(1).max(MAX_SUBJECT).optional(),
  body: z.string().trim().min(1).max(MAX_BODY),
});

const createSchema = z.strictObject({
  name: nameSchema,
  locale: z.enum(["en", "ar"]),
  channel: z.enum([CampaignChannel.PUSH, CampaignChannel.SMS, CampaignChannel.WHATSAPP, CampaignChannel.EMAIL]),
  segmentId: z.string().min(1).max(64).optional(),
  content: contentSchema,
});
export type CreateCampaignInput = z.input<typeof createSchema>;

/** Every placeholder in a draft, validated before it is written. */
function validateContent(content: { subject?: string; body: string }): PlaceholderName[] {
  const used = new Set<PlaceholderName>();
  if (content.subject !== undefined) for (const name of assertPlaceholdersValid(content.subject, "subject")) used.add(name);
  for (const name of assertPlaceholdersValid(content.body, "body")) used.add(name);
  return [...used];
}

export async function createCampaign(ctx: TenantContext, input: CreateCampaignInput): Promise<CampaignSummary> {
  requirePermission(ctx, Permission.EDIT_PUSHES);
  const parsed = createSchema.safeParse(input);
  if (!parsed.success) throw new ValidationError("Invalid campaign", parsed.error.issues);
  const data = parsed.data;

  validateContent(data.content);
  const segmentId = await resolveSegment(ctx, data.segmentId);

  const live = await prisma.campaign.count({ where: { businessId: ctx.businessId, archivedAt: null } });
  if (live >= MAX_CAMPAIGNS_PER_BUSINESS) {
    throw new ConflictError(`A business may keep at most ${MAX_CAMPAIGNS_PER_BUSINESS} campaigns`);
  }

  try {
    return await prisma.$transaction(async (tx) => {
      const campaign = await tx.campaign.create({
        data: {
          businessId: ctx.businessId,
          name: data.name,
          normalizedName: normalizeCampaignName(data.name),
          locale: data.locale,
          channel: data.channel,
          // The only state a campaign is ever created in, and the only one this build can reach
          // besides READY and ARCHIVED.
          state: CampaignState.DRAFT,
          segmentId,
          createdByUserId: ctx.userId,
          revisions: {
            create: { revisionNumber: 1, subject: data.content.subject ?? null, body: data.content.body, createdByUserId: ctx.userId },
          },
        },
        select: CAMPAIGN_SELECT,
      });

      await recordAudit(tx, {
        businessId: ctx.businessId,
        actorUserId: ctx.userId,
        action: AuditAction.CAMPAIGN_CREATED,
        entityType: "Campaign",
        entityId: campaign.id,
        // The draft's CONTENT is not copied here: it lives in a revision row that cannot be edited,
        // and an audit log is not the place for a second copy of a message about customers.
        metadata: { name: data.name, locale: data.locale, channel: data.channel, hasSegment: segmentId !== null },
      });

      return toSummary(campaign);
    });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      throw new ConflictError("This business already has a campaign with that name", ConflictCode.NAME_TAKEN);
    }
    throw e;
  }
}

export interface ReviseCampaignInput {
  subject?: string;
  body: string;
}

/**
 * Write the next revision of a draft.
 *
 * Never an update: `CampaignRevision` rejects one at the database. The revision number is allocated
 * under the campaign's row lock, so two people saving at once produce two revisions rather than one
 * lost edit or one constraint error.
 */
export async function reviseCampaign(
  ctx: TenantContext,
  campaignId: string,
  input: ReviseCampaignInput,
): Promise<CampaignSummary> {
  requirePermission(ctx, Permission.EDIT_PUSHES);
  const parsed = contentSchema.safeParse(input);
  if (!parsed.success) throw new ValidationError("Invalid campaign content", parsed.error.issues);
  validateContent(parsed.data);

  const existing = await requireOwnCampaign(ctx, campaignId);
  if (existing.archivedAt !== null) throw new ConflictError("This campaign is archived; restore it before editing");

  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT id FROM "Campaign" WHERE id = ${existing.id} FOR UPDATE`;
    /*
     * An approved campaign is editable — refusing the edit would be worse, because a merchant who
     * spots a typo after approval needs a way to fix it that is not "make a second campaign". What
     * an edit must never do is carry the approval along with it, so the new revision is written and
     * the campaign drops back to DRAFT in the same transaction. The approval row is untouched: it
     * remains a true statement about the revision it named.
     */
    const last = await tx.campaignRevision.findFirst({
      where: { campaignId: existing.id },
      orderBy: { revisionNumber: "desc" },
      select: { revisionNumber: true },
    });
    const revisionNumber = (last?.revisionNumber ?? 0) + 1;

    await tx.campaignRevision.create({
      data: {
        campaignId: existing.id,
        revisionNumber,
        subject: parsed.data.subject ?? null,
        body: parsed.data.body,
        createdByUserId: ctx.userId,
      },
    });
    await invalidateApprovalForEdit(tx, ctx, existing, revisionNumber);

    // Touches `updatedAt` so the list orders by recent work. The content is not on this row.
    const campaign = await tx.campaign.update({
      where: { id: existing.id },
      data: { updatedAt: new Date() },
      select: CAMPAIGN_SELECT,
    });

    await recordAudit(tx, {
      businessId: ctx.businessId,
      actorUserId: ctx.userId,
      action: AuditAction.CAMPAIGN_REVISED,
      entityType: "Campaign",
      entityId: existing.id,
      metadata: { revisionNumber },
    });

    return toSummary(campaign);
  });
}

/** Point a draft at a saved segment, or at none. */
export async function setCampaignAudience(
  ctx: TenantContext,
  campaignId: string,
  segmentId: string | null,
): Promise<CampaignSummary> {
  requirePermission(ctx, Permission.EDIT_PUSHES);
  const existing = await requireOwnCampaign(ctx, campaignId);
  if (existing.archivedAt !== null) throw new ConflictError("This campaign is archived; restore it before editing");
  if (existing.state === CampaignState.APPROVED) {
    /*
     * Refused rather than silently invalidated, unlike a content edit. The snapshot behind an
     * approval was taken over THIS segment; swapping the segment underneath it would leave an
     * approval whose audience came from a group nobody approved. Withdrawing first makes that a
     * decision somebody takes, with a row to show for it.
     */
    throw new ConflictError("Withdraw the approval before changing who this campaign is for");
  }
  const resolved = await resolveSegment(ctx, segmentId);

  return prisma.$transaction(async (tx) => {
    const campaign = await tx.campaign.update({
      where: { id: existing.id },
      data: { segmentId: resolved },
      select: CAMPAIGN_SELECT,
    });
    await recordAudit(tx, {
      businessId: ctx.businessId,
      actorUserId: ctx.userId,
      action: AuditAction.CAMPAIGN_AUDIENCE_SET,
      entityType: "Campaign",
      entityId: existing.id,
      // The segment id, not its membership. Nothing anywhere stores who a campaign would reach.
      metadata: { segmentId: resolved },
    });
    return toSummary(campaign);
  });
}

/**
 * The states a MERCHANT drives, and the moves between them.
 *
 * `APPROVED` and `WITHDRAWN` are deliberately absent from every value of this table: they are
 * written only by `approvals.ts`, as the consequence of a decision row. A product where somebody
 * can set a campaign to "approved" has a label, not an approval.
 *
 *   DRAFT     → IN_REVIEW   submit for a decision
 *   DRAFT     → ARCHIVED    put away
 *   IN_REVIEW → DRAFT       pull it back to keep writing
 *   IN_REVIEW → ARCHIVED    put away
 *   APPROVED  → ARCHIVED    refused: withdraw first, so the decision is taken back on the record
 *   WITHDRAWN → DRAFT       start again; approving again writes a new decision and a new snapshot
 *   WITHDRAWN → ARCHIVED    put away
 *   ARCHIVED  → DRAFT       restore
 */
const MERCHANT_TRANSITIONS: Readonly<Record<CampaignState, readonly CampaignState[]>> = {
  [CampaignState.DRAFT]: [CampaignState.IN_REVIEW, CampaignState.ARCHIVED],
  [CampaignState.IN_REVIEW]: [CampaignState.DRAFT, CampaignState.ARCHIVED],
  [CampaignState.APPROVED]: [],
  [CampaignState.WITHDRAWN]: [CampaignState.DRAFT, CampaignState.ARCHIVED],
  [CampaignState.ARCHIVED]: [CampaignState.DRAFT],
};

export async function setCampaignState(
  ctx: TenantContext,
  campaignId: string,
  state: CampaignState,
): Promise<CampaignSummary> {
  requirePermission(ctx, Permission.EDIT_PUSHES);
  const existing = await requireOwnCampaign(ctx, campaignId);
  if (existing.state === state) return toSummary(existing);

  if (!MERCHANT_TRANSITIONS[existing.state].includes(state)) {
    if (existing.state === CampaignState.APPROVED) {
      throw new ConflictError("Withdraw the approval before changing this campaign");
    }
    throw new ConflictError(`A campaign cannot go from ${existing.state} to ${state}`);
  }

  if (state === CampaignState.IN_REVIEW && existing.revisions.length === 0) {
    throw new ConflictError("A campaign needs content before it can go for review");
  }

  try {
    return await prisma.$transaction(async (tx) => {
      const campaign = await tx.campaign.update({
        where: { id: existing.id },
        data: {
          state,
          // Archiving and restoring are state changes, so the timestamp follows the state rather
          // than being a second switch that can disagree with it.
          archivedAt: state === CampaignState.ARCHIVED ? new Date() : null,
        },
        select: CAMPAIGN_SELECT,
      });
      await recordAudit(tx, {
        businessId: ctx.businessId,
        actorUserId: ctx.userId,
        action: AuditAction.CAMPAIGN_STATE_CHANGED,
        entityType: "Campaign",
        entityId: existing.id,
        metadata: { from: existing.state, to: state },
      });
      return toSummary(campaign);
    });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      throw new ConflictError("Another campaign has taken that name", ConflictCode.NAME_TAKEN);
    }
    throw e;
  }
}

export interface AudiencePreview {
  /** Customers the segment matches right now. */
  matched: number;
  /**
   * Of those, how many have an explicit, dated, versioned marketing permission.
   *
   * The difference between the two numbers is the point of showing both: a merchant looking at
   * "412 matched, 96 may be contacted" learns something true about their own records that no
   * single number would tell them.
   */
  marketingEligible: number;
  /** Matched minus eligible: withdrawn, never asked, or asked in a way nothing can date. */
  notEligible: number;
  segmentName: string;
}

/**
 * How many people a draft would reach, if this product could send anything.
 *
 * Three integers. **No name, no phone, no card, no id of any recipient** is read into the result,
 * returned, rendered or stored — the count is taken with an aggregate and the eligibility check
 * reads profile ids inside this function and discards them. There is no preview of who.
 *
 * The segment is re-evaluated live from its stored definition, so a preview is never a cached
 * audience and a campaign can never carry a stale one.
 */
export async function previewAudience(ctx: TenantContext, campaignId: string): Promise<AudiencePreview> {
  requirePermission(ctx, Permission.VIEW_PUSHES);
  if (ctx.locationIds !== null) {
    // The same rule as counting a segment: a number narrowed to the viewer's branch would be a
    // different number on every screen, and a later send would reach a set nobody saw.
    throw new ForbiddenError("Previewing an audience needs access to every branch of the business");
  }

  const campaign = await requireOwnCampaign(ctx, campaignId);
  if (!campaign.segmentId) throw new ValidationError("This campaign has no audience selected");

  const segment = await prisma.customerSegment.findFirst({
    where: { id: campaign.segmentId, businessId: ctx.businessId },
    select: { name: true, definition: true },
  });
  if (!segment) throw new NotFoundError("Segment not found");

  const definition = readDefinition(segment.definition);
  if (!definition) {
    // A stored definition this build cannot read is never evaluated as "everybody": that is the one
    // wrong answer that could later send a campaign to a whole customer base.
    throw new ValidationError("This segment was saved in a form this version cannot read");
  }

  const where = toProfileWhere(definition, ctx.businessId);
  const [matched, profiles] = await Promise.all([
    prisma.customerBusinessProfile.count({ where }),
    // Ids only, and they never leave this function: they are the input to the consent check and
    // are discarded with the array.
    prisma.customerBusinessProfile.findMany({ where, select: { id: true } }),
  ]);
  const eligible = await marketingEligibleProfileIds(ctx, profiles.map((profile) => profile.id));

  return {
    matched,
    marketingEligible: eligible.size,
    notEligible: matched - eligible.size,
    segmentName: segment.name,
  };
}
