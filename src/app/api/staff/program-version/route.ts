import { TemplateStatus } from "@prisma/client";
import { NextResponse } from "next/server";
import { z } from "zod";
import { ValidationError } from "@/server/errors";
import { errorResponse, readJsonObject } from "@/server/http";
import { MAX_REWARD_TIERS } from "@/server/program/programs";
import {
  createDraftVersion,
  discardDraftVersion,
  publishDraftVersion,
  setTemplateStatus,
  updateDraftVersion,
} from "@/server/program/versions";
import { requireScannerContext } from "@/server/tenant/scanner-context";

/**
 * POST /api/staff/program-version — the draft → review → publish lifecycle.
 *
 * The endpoint a merchant reaches when they need to change a live program. Nothing here edits a
 * live version, because nothing can: the database refuses it. What this does is create a draft from
 * the live one, let it be edited, and swap the two atomically.
 *
 * **The mechanics schema below is a boundary, not the authority.** It refuses a body carrying a
 * stray field before any service runs; `parseStampMechanics` and `parsePointsMechanics` then parse
 * the same object again inside the publish transaction and decide what the rules actually are.
 * Two checks that agree are cheap; one check a caller can route around is not.
 *
 * A `programVersionId` is never accepted from a caller. The draft is resolved from the template,
 * and `expectedVersionNumber` is the draft NUMBER the merchant reviewed — which is how a publish
 * made stale by someone else's publish is refused instead of going through unread.
 */

const templateId = z.string().min(1).max(64);
const business = z.string().min(1).optional();

const tierSchema = z.strictObject({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().min(1).max(500).optional(),
  requiredPoints: z.number().int().min(1).max(1_000_000),
  rewardValueMinor: z.number().int().min(0).max(2_147_483_647).optional(),
  usageLimit: z.number().int().min(1).max(1_000).optional(),
  sortOrder: z.number().int().min(0).max(1_000).optional(),
});

const pointsMechanics = z.strictObject({
  kind: z.literal("POINTS"),
  contractVersion: z.literal(1),
  pointsLabel: z.string().trim().min(1).max(40).optional(),
  earnMode: z.enum(["MANUAL", "PER_VISIT", "SPEND_BLOCK"]),
  pointsPerVisit: z.number().int().min(1).max(100_000).optional(),
  spendAmountPerBlockMinor: z.number().int().min(1).max(2_147_483_647).optional(),
  pointsPerBlock: z.number().int().min(1).max(100_000).optional(),
  maxPointsPerManualAward: z.number().int().min(1).max(1_000_000).optional(),
  requirePurchaseAmount: z.boolean().optional(),
  dailyAwardLimit: z.number().int().min(1).max(1_000).optional(),
  countRewardRedemptionAsVisit: z.boolean().optional(),
  welcomePoints: z.number().int().min(1).max(1_000_000).optional(),
  availableLocations: z.array(z.string().min(1).max(64)).min(1).max(50).optional(),
});

const stampMechanics = z.strictObject({
  kind: z.literal("STAMP"),
  contractVersion: z.literal(1),
  stampsRequiredPerReward: z.number().int().min(1).max(1_000),
  rewardName: z.string().trim().min(1).max(120),
  rewardDescription: z.string().trim().min(1).max(500).optional(),
  rewardValueMinor: z.number().int().min(0).max(2_147_483_647).optional(),
  earnMode: z.enum(["MANUAL", "PER_VISIT", "SPEND_BLOCK"]),
  spendAmountPerBlockMinor: z.number().int().min(1).max(2_147_483_647).optional(),
  stampsPerBlock: z.number().int().min(1).max(1_000).optional(),
  requirePurchaseAmount: z.boolean().optional(),
  dailyAwardLimit: z.number().int().min(1).max(1_000).optional(),
  countRewardRedemptionAsVisit: z.boolean().optional(),
  welcomeStamps: z.number().int().min(1).max(1_000).optional(),
  availableLocations: z.array(z.string().min(1).max(64)).min(1).max(50).optional(),
});

const bodySchema = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("createDraft"), businessId: business, templateId }),
  z.strictObject({
    action: z.literal("updateDraft"),
    businessId: business,
    templateId,
    mechanics: z.discriminatedUnion("kind", [pointsMechanics, stampMechanics]),
    /** POINTS only; a stamp program's single reward is derived from its mechanics. */
    tiers: z.array(tierSchema).min(1).max(MAX_REWARD_TIERS).optional(),
  }),
  z.strictObject({ action: z.literal("discardDraft"), businessId: business, templateId }),
  z.strictObject({
    action: z.literal("publish"),
    businessId: business,
    templateId,
    /** The draft number the merchant reviewed. A mismatch means someone else published first. */
    expectedVersionNumber: z.number().int().min(1).max(10_000),
  }),
  z.strictObject({
    action: z.literal("setStatus"),
    businessId: business,
    templateId,
    status: z.enum([TemplateStatus.ACTIVE, TemplateStatus.PAUSED]),
  }),
]);

export async function POST(req: Request) {
  try {
    // No `allowLocation`: this body names counters as `availableLocations`, which the nested guard
    // does not match, and it has no business carrying a `locationId` at all.
    const parsed = bodySchema.safeParse(await readJsonObject(req));
    if (!parsed.success) throw new ValidationError("Invalid program change", parsed.error.issues);
    const input = parsed.data;

    const { ctx } = await requireScannerContext(input.businessId ?? null);

    switch (input.action) {
      case "createDraft": {
        const created = await createDraftVersion(ctx, input.templateId);
        return NextResponse.json(created, { status: created.existed ? 200 : 201 });
      }
      case "updateDraft":
        await updateDraftVersion(ctx, input.templateId, { mechanics: input.mechanics, tiers: input.tiers });
        return NextResponse.json({ ok: true }, { status: 200 });
      case "discardDraft":
        await discardDraftVersion(ctx, input.templateId);
        return NextResponse.json({ ok: true }, { status: 200 });
      case "publish":
        return NextResponse.json(await publishDraftVersion(ctx, input.templateId, input.expectedVersionNumber), {
          status: 200,
        });
      case "setStatus":
        return NextResponse.json(await setTemplateStatus(ctx, input.templateId, input.status), { status: 200 });
    }
  } catch (e) {
    return errorResponse(e);
  }
}
