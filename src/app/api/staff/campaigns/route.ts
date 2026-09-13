import { CampaignChannel, CampaignState } from "@prisma/client";
import { NextResponse } from "next/server";
import { z } from "zod";
import { approveCampaign, listCampaignDecisions, withdrawApproval } from "@/server/campaigns/approvals";
import {
  createCampaign,
  previewAudience,
  reviseCampaign,
  setCampaignAudience,
  setCampaignState,
} from "@/server/campaigns/campaigns";
import { scanPlaceholders } from "@/server/campaigns/placeholders";
import { ValidationError } from "@/server/errors";
import { errorResponse, readJsonObject } from "@/server/http";
import { requireScannerContext } from "@/server/tenant/scanner-context";

/**
 * POST /api/staff/campaigns — write and review campaign DRAFTS.
 *
 * **Nothing on this route sends anything.** There is no send action, no schedule action and no
 * queue action, because the domain has no state for one to move a row into: `CampaignState` is
 * `DRAFT | READY | ARCHIVED`. No provider client, no outbound HTTP call and no background job
 * exists anywhere behind it.
 *
 * `check` is the only action that does not write. It exists so the editor can tell a merchant that
 * `{{programName}}` is not available BEFORE they save — and it reads no customer and touches no
 * database at all: placeholder validation is a pure function over the text.
 *
 * `preview` returns three integers. It never returns, and the service never reads into its result,
 * a recipient's name, phone, card or id.
 *
 * `approve` and `withdraw` are the decision verbs, and they are the ONLY way `APPROVED` and
 * `WITHDRAWN` are ever written — which is why `setState` below refuses both. Approving takes an
 * immutable audience snapshot and returns its counts; it does not return, and nothing behind it
 * reads out, a single recipient.
 *
 * An approval is not permission to contact anybody. Every response carries a `readiness` object
 * whose `deliverable` is `false` and whose blockers always include `NO_DELIVERY_CHANNEL_EXISTS`.
 */

const business = z.string().min(1).optional();
const campaignId = z.string().min(1).max(64);
const subject = z.string().trim().min(1).max(120);
const body = z.string().trim().min(1).max(1_000);
const note = z.string().trim().min(1).max(280);

const bodySchema = z.discriminatedUnion("action", [
  z.strictObject({
    action: z.literal("create"),
    businessId: business,
    name: z.string().trim().min(1).max(80),
    locale: z.enum(["en", "ar"]),
    channel: z.enum([CampaignChannel.PUSH, CampaignChannel.SMS, CampaignChannel.WHATSAPP, CampaignChannel.EMAIL]),
    segmentId: z.string().min(1).max(64).optional(),
    subject: subject.optional(),
    body,
  }),
  z.strictObject({ action: z.literal("revise"), businessId: business, campaignId, subject: subject.optional(), body }),
  z.strictObject({
    action: z.literal("setAudience"),
    businessId: business,
    campaignId,
    // `null` clears the audience; a string sets it. Both are deliberate choices a merchant makes.
    segmentId: z.union([z.string().min(1).max(64), z.null()]),
  }),
  z.strictObject({
    action: z.literal("setState"),
    businessId: business,
    campaignId,
    /*
     * The three states a merchant drives, listed explicitly rather than taken wholesale from Prisma.
     * Two things follow from writing them out.
     *
     * First, if a delivery state is ever added to `CampaignState`, this route does not silently
     * start accepting it — the phase that adds one has to come here and say so.
     *
     * Second, APPROVED and WITHDRAWN are absent on purpose. They are not states somebody sets; they
     * are what it looks like from outside when a decision row exists. The `approve` and `withdraw`
     * actions below are the only way to reach them.
     */
    state: z.enum([CampaignState.DRAFT, CampaignState.IN_REVIEW, CampaignState.ARCHIVED]),
  }),
  z.strictObject({
    action: z.literal("approve"),
    businessId: business,
    campaignId,
    // The revision the approver actually read. Checked against the server's latest, so an approval
    // cannot land on words that changed while the screen was open.
    revisionNumber: z.number().int().positive(),
    intendedChannel: z.enum([CampaignChannel.PUSH, CampaignChannel.SMS, CampaignChannel.WHATSAPP, CampaignChannel.EMAIL]),
    note: note.optional(),
  }),
  z.strictObject({ action: z.literal("withdraw"), businessId: business, campaignId, note: note.optional() }),
  z.strictObject({ action: z.literal("decisions"), businessId: business, campaignId }),
  z.strictObject({ action: z.literal("preview"), businessId: business, campaignId }),
  z.strictObject({ action: z.literal("check"), businessId: business, subject: subject.optional(), body }),
]);

export async function POST(req: Request) {
  try {
    const parsed = bodySchema.safeParse(await readJsonObject(req));
    if (!parsed.success) throw new ValidationError("Invalid campaign request", parsed.error.issues);
    const input = parsed.data;

    const { ctx } = await requireScannerContext(input.businessId ?? null);

    switch (input.action) {
      case "create":
        return NextResponse.json(
          await createCampaign(ctx, {
            name: input.name,
            locale: input.locale,
            channel: input.channel,
            segmentId: input.segmentId,
            content: { subject: input.subject, body: input.body },
          }),
          { status: 201 },
        );
      case "revise":
        return NextResponse.json(await reviseCampaign(ctx, input.campaignId, { subject: input.subject, body: input.body }), {
          status: 200,
        });
      case "setAudience":
        return NextResponse.json(await setCampaignAudience(ctx, input.campaignId, input.segmentId), { status: 200 });
      case "setState":
        return NextResponse.json(await setCampaignState(ctx, input.campaignId, input.state), { status: 200 });
      case "approve":
        return NextResponse.json(
          await approveCampaign(ctx, input.campaignId, {
            revisionNumber: input.revisionNumber,
            intendedChannel: input.intendedChannel,
            note: input.note,
          }),
          { status: 201 },
        );
      case "withdraw":
        return NextResponse.json(await withdrawApproval(ctx, input.campaignId, input.note), { status: 201 });
      case "decisions":
        return NextResponse.json({ decisions: await listCampaignDecisions(ctx, input.campaignId) }, { status: 200 });
      case "preview":
        return NextResponse.json(await previewAudience(ctx, input.campaignId), { status: 200 });
      case "check": {
        // Pure. No database, no customer, no write — which is what lets the editor call it while
        // somebody is still typing.
        const problems = [
          ...scanPlaceholders(input.subject ?? "").problems.map((p) => ({ ...p, field: "subject" as const })),
          ...scanPlaceholders(input.body).problems.map((p) => ({ ...p, field: "body" as const })),
        ];
        return NextResponse.json({ problems }, { status: 200 });
      }
    }
  } catch (e) {
    return errorResponse(e);
  }
}
