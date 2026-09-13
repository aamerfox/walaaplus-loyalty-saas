import { CampaignChannel, CampaignDecision, CampaignState, ConsentState, Permission, Prisma } from "@prisma/client";
import { z } from "zod";
import { AuditAction, recordAudit } from "../audit/audit";
import { observeMarketingConsent } from "../consent/consent";
import { prisma, type DbClient } from "../db";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../errors";
import { readDefinition, toProfileWhere } from "../segments/definition";
import { requirePermission, type TenantContext } from "../tenant/context";

/**
 * Campaign approval, and the audience snapshot that stands behind one.
 *
 * ## What an approval is
 *
 * An append-only row that names a person, a moment, **one exact revision**, one declared intended
 * channel, and one immutable audience snapshot. It is not a label on a campaign and it is not
 * inferred from a state: `CampaignState.APPROVED` is a *consequence* of the row existing, which is
 * why nothing outside this module writes that state.
 *
 * Approval covers the words somebody actually read. Edit the draft afterwards and the approval
 * stays — pointing at the revision it was about — while the campaign drops back to `DRAFT` and has
 * to be approved again. That is the whole reason revisions are append-only.
 *
 * ## What an approval is NOT
 *
 * **It is not permission to contact anybody.** See `delivery.ts`. A snapshot records who could have
 * been contacted at the instant of a decision; consent moves afterwards, and any future delivery
 * must re-read current consent per recipient rather than trusting a stored list.
 *
 * ## The approval policy, stated rather than implied
 *
 * One approver. `EDIT_PUSHES` — the product's existing engagement permission, held by an owner and
 * a manager — plus a membership with no branch restriction, because a snapshot is business-wide and
 * a branch-scoped view of it would be a different number for every approver.
 *
 * A mandatory second approver is deliberately NOT invented here. A pilot merchant is one person;
 * requiring two would mean requiring them to create a second account to approve their own campaign,
 * which is theatre rather than control. Recorded as **D12** for the moment a business has staff who
 * are not its owner.
 */

/** An approval note is a sentence for colleagues, not a document. */
const MAX_NOTE = 280;

const noteSchema = z.string().trim().min(1).max(MAX_NOTE).optional();

/**
 * A snapshot can be this large before approval refuses.
 *
 * Not a performance limit — it is a review limit. A person cannot meaningfully approve a message to
 * more people than this in one decision, and a product that lets them is a product that turns an
 * approval into a formality. If a real merchant's list passes it, that is a conversation, not a
 * constant somebody quietly raises.
 */
export const MAX_SNAPSHOT_MEMBERS = 50_000;

export interface AudienceSnapshotView {
  id: string;
  segmentName: string;
  takenAt: Date;
  matchedCount: number;
  eligibleCount: number;
  /** Excluded because nothing can say when or to what wording they agreed. */
  unknownCount: number;
  /** Excluded because they said no. */
  withdrawnCount: number;
}

export interface CampaignDecisionView {
  id: string;
  decision: CampaignDecision;
  revisionNumber: number;
  intendedChannel: CampaignChannel;
  decidedAt: Date;
  /** A name, never an email and never a user id. */
  decidedByName: string | null;
  note: string | null;
  snapshot: AudienceSnapshotView | null;
}

const SNAPSHOT_SELECT = {
  id: true,
  segmentName: true,
  takenAt: true,
  matchedCount: true,
  eligibleCount: true,
  unknownCount: true,
  withdrawnCount: true,
} satisfies Prisma.CampaignAudienceSnapshotSelect;

const DECISION_SELECT = {
  id: true,
  decision: true,
  revisionNumber: true,
  intendedChannel: true,
  decidedAt: true,
  note: true,
  decidedBy: { select: { firstName: true, lastName: true } },
  snapshot: { select: SNAPSHOT_SELECT },
} satisfies Prisma.CampaignApprovalSelect;

function toDecision(row: Prisma.CampaignApprovalGetPayload<{ select: typeof DECISION_SELECT }>): CampaignDecisionView {
  return {
    id: row.id,
    decision: row.decision,
    revisionNumber: row.revisionNumber,
    intendedChannel: row.intendedChannel,
    decidedAt: row.decidedAt,
    decidedByName: [row.decidedBy?.firstName, row.decidedBy?.lastName].filter(Boolean).join(" ") || null,
    note: row.note,
    snapshot: row.snapshot,
  };
}

/**
 * The approval bar, in one place so every caller passes the same one.
 *
 * The branch rule is not decoration. A snapshot is taken over the whole business, so an approver
 * who can only see one branch would be signing off on a number they cannot verify — and the future
 * delivery it authorises would reach people outside anything they can see.
 */
function requireApprover(ctx: TenantContext): void {
  requirePermission(ctx, Permission.EDIT_PUSHES);
  if (ctx.locationIds !== null) {
    throw new ForbiddenError("Approving a campaign needs access to every branch of the business");
  }
}

/** The campaign, inside the caller's tenant, with what a decision needs. Or a 404. */
async function requireOwnCampaign(db: DbClient, ctx: TenantContext, campaignId: string) {
  const campaign = await db.campaign.findFirst({
    // businessId is in the WHERE, not checked afterwards: a cross-tenant id finds no row at all.
    where: { id: campaignId, businessId: ctx.businessId },
    select: {
      id: true,
      state: true,
      channel: true,
      segmentId: true,
      archivedAt: true,
      approvedRevisionNumber: true,
      revisions: { orderBy: { revisionNumber: "desc" as const }, take: 1, select: { id: true, revisionNumber: true } },
    },
  });
  if (!campaign) throw new NotFoundError("Campaign not found");
  return campaign;
}

/**
 * Take the audience snapshot.
 *
 * Runs inside the approving transaction, so the counts a merchant is shown and the rows written are
 * the same evaluation — not two reads with a gap between them that a concurrent enrolment can fall
 * into.
 *
 * **Only eligible customers get a row.** The excluded are counted, never listed: somebody who never
 * agreed to be contacted has not agreed to appear in a marketing artefact either, and no future
 * delivery needs them. The two exclusion counts are on the header, which is what the screen shows.
 */
async function takeSnapshot(
  tx: DbClient,
  ctx: TenantContext,
  campaign: { id: string; segmentId: string | null },
  revisionId: string,
): Promise<AudienceSnapshotView> {
  if (!campaign.segmentId) throw new ValidationError("This campaign has no audience selected");

  const segment = await tx.customerSegment.findFirst({
    where: { id: campaign.segmentId, businessId: ctx.businessId },
    select: { id: true, name: true, definition: true, archivedAt: true },
  });
  if (!segment) throw new NotFoundError("Segment not found");
  if (segment.archivedAt !== null) {
    throw new ConflictError("That segment is archived; restore it or choose another before approving");
  }

  const definition = readDefinition(segment.definition);
  if (!definition) {
    // Never evaluated as "everybody". An unreadable definition producing an empty `where` is the one
    // wrong answer here, because the resulting snapshot would authorise a whole customer base.
    throw new ValidationError("This segment was saved in a form this version cannot read");
  }

  const where = toProfileWhere(definition, ctx.businessId);
  const matched = await tx.customerBusinessProfile.findMany({ where, select: { id: true } });
  if (matched.length > MAX_SNAPSHOT_MEMBERS) {
    throw new ConflictError(
      `This audience is larger than ${MAX_SNAPSHOT_MEMBERS} customers, which is more than one decision should cover`,
    );
  }

  const observed = await observeMarketingConsent(ctx, matched.map((profile) => profile.id));

  const eligible: { profileId: string; state: ConsentState; consentRecordId: string | null }[] = [];
  let unknown = 0;
  let withdrawn = 0;
  for (const profile of matched) {
    const observation = observed.get(profile.id);
    if (!observation) continue;
    if (observation.marketingEligible) {
      eligible.push({
        profileId: profile.id,
        state: observation.state,
        consentRecordId: observation.consentRecordId,
      });
    } else if (observation.state === ConsentState.WITHDRAWN) withdrawn += 1;
    else unknown += 1;
  }

  const takenAt = new Date();
  const snapshot = await tx.campaignAudienceSnapshot.create({
    data: {
      businessId: ctx.businessId,
      campaignId: campaign.id,
      campaignRevisionId: revisionId,
      segmentId: segment.id,
      // The name as it is now. A later rename does not rewrite the history of this decision.
      segmentName: segment.name,
      takenAt,
      matchedCount: matched.length,
      eligibleCount: eligible.length,
      unknownCount: unknown,
      withdrawnCount: withdrawn,
      takenByUserId: ctx.userId,
    },
    select: SNAPSHOT_SELECT,
  });

  if (eligible.length > 0) {
    await tx.campaignAudienceMember.createMany({
      data: eligible.map((member) => ({
        snapshotId: snapshot.id,
        customerBusinessProfileId: member.profileId,
        consentState: member.state,
        consentRecordId: member.consentRecordId,
      })),
    });
  }

  return snapshot;
}

export interface ApproveCampaignInput {
  /**
   * The revision the approver is deciding about, sent by the client and checked against the server's
   * idea of the latest one.
   *
   * This is the concurrency guard, and it is the reason approval takes an argument at all: if a
   * colleague saved an edit while the approval screen was open, the number no longer matches and the
   * approval is refused rather than silently applied to words nobody read.
   */
  revisionNumber: number;
  /** Declared at the decision, not read from the draft afterwards. */
  intendedChannel: CampaignChannel;
  note?: string;
}

const approveSchema = z.strictObject({
  revisionNumber: z.number().int().positive(),
  intendedChannel: z.enum([CampaignChannel.PUSH, CampaignChannel.SMS, CampaignChannel.WHATSAPP, CampaignChannel.EMAIL]),
  note: noteSchema,
});

/**
 * Approve one exact revision, taking an audience snapshot in the same transaction.
 *
 * Refuses: an archived campaign, a campaign with no content, a campaign with no audience, a
 * revision number that is not the current one, and a campaign that is already approved at that
 * revision (approving twice is not an error worth a second snapshot).
 */
export async function approveCampaign(
  ctx: TenantContext,
  campaignId: string,
  input: ApproveCampaignInput,
): Promise<CampaignDecisionView> {
  requireApprover(ctx);
  const parsed = approveSchema.safeParse(input);
  if (!parsed.success) throw new ValidationError("Invalid approval", parsed.error.issues);
  const data = parsed.data;

  return prisma.$transaction(async (tx) => {
    const campaign = await requireOwnCampaign(tx, ctx, campaignId);
    if (campaign.archivedAt !== null || campaign.state === CampaignState.ARCHIVED) {
      throw new ConflictError("An archived campaign cannot be approved; restore it first");
    }

    // Serialise approvals of one campaign, so two approvers cannot each write a snapshot.
    await tx.$executeRaw`SELECT id FROM "Campaign" WHERE id = ${campaign.id} FOR UPDATE`;

    const latest = campaign.revisions[0];
    if (!latest) throw new ConflictError("A campaign needs content before it can be approved");
    if (latest.revisionNumber !== data.revisionNumber) {
      throw new ConflictError(
        `This campaign has moved on to revision ${latest.revisionNumber}; read it again before approving`,
      );
    }
    if (campaign.state === CampaignState.APPROVED && campaign.approvedRevisionNumber === latest.revisionNumber) {
      throw new ConflictError("This revision is already approved");
    }

    const snapshot = await takeSnapshot(tx, ctx, campaign, latest.id);

    const approval = await tx.campaignApproval.create({
      data: {
        businessId: ctx.businessId,
        campaignId: campaign.id,
        campaignRevisionId: latest.id,
        revisionNumber: latest.revisionNumber,
        decision: CampaignDecision.APPROVED,
        intendedChannel: data.intendedChannel,
        audienceSnapshotId: snapshot.id,
        decidedByUserId: ctx.userId,
        decidedAt: new Date(),
        note: data.note ?? null,
      },
      select: DECISION_SELECT,
    });

    await tx.campaign.update({
      where: { id: campaign.id },
      data: {
        state: CampaignState.APPROVED,
        approvedRevisionNumber: latest.revisionNumber,
        approvedSnapshotId: snapshot.id,
        approvedAt: approval.decidedAt,
      },
    });

    await recordAudit(tx, {
      businessId: ctx.businessId,
      actorUserId: ctx.userId,
      action: AuditAction.CAMPAIGN_APPROVED,
      entityType: "Campaign",
      entityId: campaign.id,
      /*
       * Counts, a revision number and a channel. No recipient id, no segment membership and not the
       * approver's note — an audit row is read by more people and kept longer than the box that note
       * was typed into.
       */
      metadata: {
        revisionNumber: latest.revisionNumber,
        intendedChannel: data.intendedChannel,
        snapshotId: snapshot.id,
        matchedCount: snapshot.matchedCount,
        eligibleCount: snapshot.eligibleCount,
        unknownCount: snapshot.unknownCount,
        withdrawnCount: snapshot.withdrawnCount,
      },
    });

    return toDecision(approval);
  });
}

/**
 * Take an approval back.
 *
 * Explicit, audited, and irreversible as *history*: the approval row stays exactly where it was and
 * a second row records the withdrawal beside it. Both are append-only. What a merchant can do
 * afterwards is send the campaign back to draft and approve it again — which writes a third row and
 * a new snapshot, because it is a new decision.
 */
export async function withdrawApproval(
  ctx: TenantContext,
  campaignId: string,
  note?: string,
): Promise<CampaignDecisionView> {
  requireApprover(ctx);
  const parsedNote = noteSchema.safeParse(note);
  if (!parsedNote.success) throw new ValidationError("Invalid withdrawal note", parsedNote.error.issues);

  return prisma.$transaction(async (tx) => {
    const campaign = await requireOwnCampaign(tx, ctx, campaignId);
    if (campaign.state !== CampaignState.APPROVED) {
      throw new ConflictError("Only an approved campaign can be withdrawn");
    }
    await tx.$executeRaw`SELECT id FROM "Campaign" WHERE id = ${campaign.id} FOR UPDATE`;

    const standing = await tx.campaignApproval.findFirst({
      where: { campaignId: campaign.id, decision: CampaignDecision.APPROVED },
      orderBy: [{ decidedAt: "desc" }, { createdAt: "desc" }],
      select: { id: true, campaignRevisionId: true, revisionNumber: true, intendedChannel: true },
    });
    if (!standing) throw new ConflictError("This campaign has no approval to withdraw");

    const withdrawal = await tx.campaignApproval.create({
      data: {
        businessId: ctx.businessId,
        campaignId: campaign.id,
        campaignRevisionId: standing.campaignRevisionId,
        revisionNumber: standing.revisionNumber,
        decision: CampaignDecision.WITHDRAWN,
        // The channel the withdrawn approval declared, so one row reads as a complete account.
        intendedChannel: standing.intendedChannel,
        // A withdrawal takes nothing new; it points at what it took back.
        audienceSnapshotId: null,
        withdrawsApprovalId: standing.id,
        decidedByUserId: ctx.userId,
        decidedAt: new Date(),
        note: parsedNote.data ?? null,
      },
      select: DECISION_SELECT,
    });

    await tx.campaign.update({
      where: { id: campaign.id },
      data: {
        state: CampaignState.WITHDRAWN,
        // The pointers go, the rows stay. Nothing stands approved any more.
        approvedRevisionNumber: null,
        approvedSnapshotId: null,
        approvedAt: null,
      },
    });

    await recordAudit(tx, {
      businessId: ctx.businessId,
      actorUserId: ctx.userId,
      action: AuditAction.CAMPAIGN_WITHDRAWN,
      entityType: "Campaign",
      entityId: campaign.id,
      metadata: { revisionNumber: standing.revisionNumber, withdrewApprovalId: standing.id },
    });

    return toDecision(withdrawal);
  });
}

/**
 * Clear a standing approval because the content it covered is no longer the content on screen.
 *
 * Called from inside the revising transaction, never on its own. The approval ROW is untouched — it
 * is append-only and it remains a true statement about the revision it named. What changes is the
 * campaign: it drops to `DRAFT`, because what a merchant is now looking at has not been approved by
 * anybody.
 */
export async function invalidateApprovalForEdit(
  tx: DbClient,
  ctx: TenantContext,
  campaign: { id: string; state: CampaignState; approvedRevisionNumber: number | null },
  newRevisionNumber: number,
): Promise<void> {
  if (campaign.state !== CampaignState.APPROVED && campaign.approvedRevisionNumber === null) return;

  await tx.campaign.update({
    where: { id: campaign.id },
    data: {
      state: CampaignState.DRAFT,
      approvedRevisionNumber: null,
      approvedSnapshotId: null,
      approvedAt: null,
    },
  });

  await recordAudit(tx, {
    businessId: ctx.businessId,
    actorUserId: ctx.userId,
    action: AuditAction.CAMPAIGN_APPROVAL_INVALIDATED,
    entityType: "Campaign",
    entityId: campaign.id,
    metadata: {
      approvedRevisionNumber: campaign.approvedRevisionNumber,
      newRevisionNumber,
      reason: "CONTENT_EDITED",
    },
  });
}

/** Every decision ever made about one campaign, newest first. */
export async function listCampaignDecisions(
  ctx: TenantContext,
  campaignId: string,
): Promise<CampaignDecisionView[]> {
  requirePermission(ctx, Permission.VIEW_PUSHES);
  const campaign = await prisma.campaign.findFirst({
    where: { id: campaignId, businessId: ctx.businessId },
    select: { id: true },
  });
  if (!campaign) throw new NotFoundError("Campaign not found");

  const rows = await prisma.campaignApproval.findMany({
    where: { campaignId: campaign.id, businessId: ctx.businessId },
    orderBy: [{ decidedAt: "desc" }, { createdAt: "desc" }],
    take: 50,
    select: DECISION_SELECT,
  });
  return rows.map(toDecision);
}

/**
 * The snapshot behind a campaign's standing approval, as counts.
 *
 * Returns the header and nothing else. There is deliberately no function anywhere that reads
 * `CampaignAudienceMember` rows out to a caller: the only thing that could legitimately want them
 * is delivery, and delivery refuses (see `delivery.ts`).
 */
export async function getApprovedSnapshot(
  ctx: TenantContext,
  campaignId: string,
): Promise<AudienceSnapshotView | null> {
  requirePermission(ctx, Permission.VIEW_PUSHES);
  const campaign = await prisma.campaign.findFirst({
    where: { id: campaignId, businessId: ctx.businessId },
    select: { approvedSnapshot: { select: SNAPSHOT_SELECT } },
  });
  if (!campaign) throw new NotFoundError("Campaign not found");
  return campaign.approvedSnapshot;
}
