import { PromotionState } from "@prisma/client";
import { NextResponse } from "next/server";
import { z } from "zod";
import { ValidationError } from "@/server/errors";
import { errorResponse, readJsonObject } from "@/server/http";
import { createPromotion, setPromotionState, updatePromotion } from "@/server/promotions/promotions";
import { voidRedemption } from "@/server/promotions/redemption";
import { requireScannerContext } from "@/server/tenant/scanner-context";

/**
 * POST /api/staff/promotions — manage promotions, and withdraw a redemption.
 *
 * **Owner and manager only**, enforced in the services. A cashier redeems a code a customer
 * presents, through the scanner route; they never see this one, because a list of live codes on a
 * till screen is a list of codes to hand out.
 *
 * **There is no `redeem` action here.** Redemption happens on the authenticated counter route,
 * against a card, in the same request that looked the customer up — and that is the only place a raw
 * code reaches the server.
 *
 * **There is no `reveal` or `code` action either.** Only a salted digest is stored, so nothing could
 * answer one. A merchant who forgets their own code expires the promotion and makes another; the
 * screen says so when they create it.
 *
 * **And no action carries an amount.** There is no discount, percentage, currency, tax or total
 * anywhere in this phase — a redemption records that a customer is owed something a person will hand
 * over. See `docs/PROMOTIONS-CAPABILITY-MATRIX.md`.
 */

const business = z.string().min(1).optional();
const promotionId = z.string().min(1).max(64);
const name = z.string().trim().min(1).max(80);
const benefit = z.string().trim().min(1).max(200);
/** ISO 8601, parsed here so a service takes a `Date` rather than a string it has to trust. */
const when = z.union([z.iso.datetime(), z.null()]);

const bodySchema = z.discriminatedUnion("action", [
  z.strictObject({
    action: z.literal("create"),
    businessId: business,
    name,
    benefitDescription: benefit,
    /** Read once, hashed with a fresh salt, and never stored or echoed back. */
    code: z.string().trim().min(1).max(64),
    startsAt: z.iso.datetime().optional(),
    endsAt: z.iso.datetime().optional(),
    totalLimit: z.number().int().positive().max(1_000_000).optional(),
    perCustomerLimit: z.number().int().positive().max(1_000).optional(),
  }),
  z.strictObject({
    action: z.literal("update"),
    businessId: business,
    promotionId,
    name: name.optional(),
    benefitDescription: benefit.optional(),
    startsAt: when.optional(),
    endsAt: when.optional(),
    totalLimit: z.union([z.number().int().positive().max(1_000_000), z.null()]).optional(),
    perCustomerLimit: z.union([z.number().int().positive().max(1_000), z.null()]).optional(),
  }),
  z.strictObject({
    action: z.literal("setState"),
    businessId: business,
    promotionId,
    /*
     * The four states, listed literally rather than taken wholesale from Prisma. If a fifth is ever
     * added — a scheduled state, a per-branch state — this route does not silently start accepting
     * it: the phase that adds one has to come here and say so.
     */
    state: z.enum([PromotionState.DRAFT, PromotionState.ACTIVE, PromotionState.PAUSED, PromotionState.EXPIRED]),
  }),
  z.strictObject({
    action: z.literal("voidRedemption"),
    businessId: business,
    redemptionId: z.string().min(1).max(64),
    reason: z.string().trim().min(1).max(280).optional(),
  }),
]);

/** Undefined stays undefined (leave alone); null stays null (clear it); a string becomes a Date. */
function toDate(value: string | null | undefined): Date | null | undefined {
  if (value === undefined || value === null) return value;
  return new Date(value);
}

export async function POST(req: Request) {
  try {
    const parsed = bodySchema.safeParse(await readJsonObject(req));
    if (!parsed.success) throw new ValidationError("Invalid promotion request", parsed.error.issues);
    const input = parsed.data;

    const { ctx } = await requireScannerContext(input.businessId ?? null);

    switch (input.action) {
      case "create":
        return NextResponse.json(
          await createPromotion(ctx, {
            name: input.name,
            benefitDescription: input.benefitDescription,
            code: input.code,
            startsAt: input.startsAt ? new Date(input.startsAt) : undefined,
            endsAt: input.endsAt ? new Date(input.endsAt) : undefined,
            totalLimit: input.totalLimit,
            perCustomerLimit: input.perCustomerLimit,
          }),
          { status: 201 },
        );
      case "update":
        return NextResponse.json(
          await updatePromotion(ctx, input.promotionId, {
            name: input.name,
            benefitDescription: input.benefitDescription,
            startsAt: toDate(input.startsAt),
            endsAt: toDate(input.endsAt),
            totalLimit: input.totalLimit,
            perCustomerLimit: input.perCustomerLimit,
          }),
          { status: 200 },
        );
      case "setState":
        return NextResponse.json(await setPromotionState(ctx, input.promotionId, input.state), { status: 200 });
      case "voidRedemption":
        return NextResponse.json(await voidRedemption(ctx, input.redemptionId, input.reason), { status: 200 });
    }
  } catch (e) {
    return errorResponse(e);
  }
}
