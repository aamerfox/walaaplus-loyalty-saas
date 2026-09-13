import { OperationSource } from "@prisma/client";
import { NextResponse } from "next/server";
import { z } from "zod";
import { ValidationError } from "@/server/errors";
import { errorResponse, readJsonObject } from "@/server/http";
import { awardManualPoints, awardPurchasePoints, awardVisitPoints, redeemRewardTier } from "@/server/points/engine";
import { enforceStaffLimit } from "@/server/security/staff-limit";
import { requireScannerContext } from "@/server/tenant/scanner-context";

/**
 * POST /api/scanner/points — earn and spend points at the counter.
 *
 * One route, four verbs, chosen by a discriminated union so each verb carries exactly the fields it
 * needs and nothing else. The schema is **strict**: a body naming a business it does not belong to
 * is verified rather than trusted, and a body naming a `sourceToken`, a balance, a `rewardTierId`
 * on an award, or any other field is refused outright rather than ignored.
 *
 * What this route deliberately does NOT do: build a ledger row, read a balance, decide whether a
 * tier is affordable, or resolve a location. The engine does all of it, under the card lock, inside
 * one transaction, having re-read the rules pinned to the card.
 *
 * `locationId` is accepted here and nowhere public. It is meaningful only when the card's pinned
 * version lists `availableLocations`; a Phase 1a version refuses it, and the engine checks both the
 * program's list and this member's own assignment before anything is written.
 */

const base = {
  /** Present only when the caller belongs to several businesses; verified, never trusted. */
  businessId: z.string().min(1).optional(),
  customerCardId: z.string().min(1),
  idempotencyKey: z.string().min(8),
  locationId: z.string().min(1).optional(),
  comment: z.string().trim().max(500).optional(),
};

const bodySchema = z.discriminatedUnion("mode", [
  z.strictObject({ ...base, mode: z.literal("manual"), quantity: z.number().int().min(1), purchaseAmountMinor: z.number().int().min(0).optional() }),
  z.strictObject({ ...base, mode: z.literal("visit"), purchaseAmountMinor: z.number().int().min(0).optional() }),
  z.strictObject({ ...base, mode: z.literal("purchase"), purchaseAmountMinor: z.number().int().min(0) }),
  z.strictObject({ ...base, mode: z.literal("redeem"), rewardTierId: z.string().min(1) }),
]);

export async function POST(req: Request) {
  try {
    const parsed = bodySchema.safeParse(await readJsonObject(req, { allowLocation: true }));
    if (!parsed.success) throw new ValidationError("Invalid points operation", parsed.error.issues);
    const input = parsed.data;

    const { ctx } = await requireScannerContext(input.businessId ?? null);
    // Finding M-11: one member of staff, one window. Counted after the membership is verified
    // (there is nothing to key on before that) and before the service runs.
    await enforceStaffLimit(ctx, "write");
    const common = {
      customerCardId: input.customerCardId,
      idempotencyKey: input.idempotencyKey,
      source: OperationSource.SCANNER,
      locationId: input.locationId,
      comment: input.comment?.trim() || undefined,
    };

    switch (input.mode) {
      case "manual":
        return NextResponse.json(
          await awardManualPoints(ctx, { ...common, quantity: input.quantity, purchaseAmountMinor: input.purchaseAmountMinor }),
        );
      case "visit":
        return NextResponse.json(await awardVisitPoints(ctx, { ...common, purchaseAmountMinor: input.purchaseAmountMinor }));
      case "purchase":
        return NextResponse.json(await awardPurchasePoints(ctx, { ...common, purchaseAmountMinor: input.purchaseAmountMinor }));
      case "redeem":
        return NextResponse.json(await redeemRewardTier(ctx, { ...common, rewardTierId: input.rewardTierId }));
    }
  } catch (e) {
    return errorResponse(e);
  }
}
