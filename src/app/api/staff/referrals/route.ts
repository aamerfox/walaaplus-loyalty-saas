import { NextResponse } from "next/server";
import { z } from "zod";
import { ValidationError } from "@/server/errors";
import { errorResponse, readJsonObject } from "@/server/http";
import { voidReferralAttribution } from "@/server/share/referrals";
import { requireScannerContext } from "@/server/tenant/scanner-context";

/**
 * POST /api/staff/referrals — withdraw a referral record.
 *
 * **One action, and the absences are the design.**
 *
 * There is no `record`: an attribution is written by the counter enrolment route, in the same
 * request that issued the card, and nowhere else. A standalone recording endpoint would be a way to
 * attribute a card after the fact, which is retrospective attribution — the thing this phase refuses
 * to invent.
 *
 * There is no `list`: nothing in this product enumerates attributions, ranks referrers or counts
 * them per customer. That report is a list of customers ordered by how many friends they brought,
 * which belongs to a reward programme that does not exist (D15).
 *
 * There is no `resolve` and nothing that accepts a capability. The only route in the product that
 * may see one is the authenticated counter enrolment, in a body.
 *
 * Voiding is owner or manager only, enforced in the service. Recording happens at a till and is a
 * cashier's job; deciding that a record of what happened was wrong is a correction to the business's
 * own history, which is a different kind of decision.
 */

const bodySchema = z.strictObject({
  action: z.literal("void"),
  businessId: z.string().min(1).optional(),
  attributionId: z.string().min(1).max(64),
  reason: z.string().trim().min(1).max(280).optional(),
});

export async function POST(req: Request) {
  try {
    const parsed = bodySchema.safeParse(await readJsonObject(req));
    if (!parsed.success) throw new ValidationError("Invalid referral request", parsed.error.issues);
    const input = parsed.data;

    const { ctx } = await requireScannerContext(input.businessId ?? null);
    return NextResponse.json(await voidReferralAttribution(ctx, input.attributionId, input.reason), { status: 200 });
  } catch (e) {
    return errorResponse(e);
  }
}
