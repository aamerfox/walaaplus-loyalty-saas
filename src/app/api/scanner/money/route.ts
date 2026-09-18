import { OperationSource } from "@prisma/client";
import { NextResponse } from "next/server";
import { z } from "zod";
import { ValidationError } from "@/server/errors";
import { errorResponse, readJsonObject } from "@/server/http";
import {
  applyDiscount,
  earnCashback,
  redeemCashback,
  reverseMonetaryOperation,
} from "@/server/monetary/engine";
import { requireScannerContext } from "@/server/tenant/scanner-context";

/**
 * POST /api/scanner/money — the counter for a cashback or discount programme.
 *
 * Four verbs, one route, because they are one conversation at a till: the staff member types the
 * bill, and the answer is what to collect.
 *
 * **Every amount is minor units as a STRING.** A JSON number is a double; a bill of 8.20 typed into
 * a float becomes 819.9999999999999 minor units, and a rounding step downstream would hide it. The
 * engine parses these strings into `bigint` and never leaves integer arithmetic afterwards.
 *
 * **`grossAmountMinor` is a staff assertion, not a verified figure.** Nothing here is a payment, a
 * settlement, a receipt, a POS sale, or revenue: this product records what a member of staff said
 * the bill was, and what the programme therefore gives back. The screens say so; the API must not
 * imply otherwise by naming it `total` or `amountPaid`.
 *
 * What this route does NOT do: read a balance, pick a tier, compute a rate, cap a redemption or
 * resolve a location. The engine does all of it inside one transaction under the card's lock, from
 * the rules pinned to that card's version — so a route that guessed would merely be a second,
 * disagreeing opinion.
 */

/**
 * A minor-unit amount on the wire: digits only, no sign, no decimal point, no exponent.
 *
 * Refused as a NUMBER on purpose. Accepting `8.2` would mean deciding what a caller with a fractional
 * minor unit meant, and there is no reading of it that is not a bug in the caller.
 */
const minorAmount = z
  .string()
  .regex(/^\d{1,18}$/, "amount must be minor units, digits only");

const base = {
  businessId: z.string().min(1).optional(),
  customerCardId: z.string().min(1),
  idempotencyKey: z.string().min(8),
  locationId: z.string().min(1).optional(),
};

const bodySchema = z.discriminatedUnion("action", [
  z.strictObject({ ...base, action: z.literal("earn"), grossAmountMinor: minorAmount }),
  z.strictObject({
    ...base,
    action: z.literal("redeem"),
    grossAmountMinor: minorAmount,
    /** What staff asked to take off the bill. The engine caps it at min(balance, invoice). */
    requestedRedemptionMinor: minorAmount,
  }),
  z.strictObject({ ...base, action: z.literal("discount"), grossAmountMinor: minorAmount }),
  z.strictObject({
    businessId: z.string().min(1).optional(),
    action: z.literal("reverse"),
    monetaryOperationId: z.string().min(1),
    /** Required, and free text: a reversal without a stated reason is not a correction. */
    reason: z.string().trim().min(3).max(500),
    idempotencyKey: z.string().min(8),
  }),
]);

export async function POST(req: Request) {
  try {
    const parsed = bodySchema.safeParse(await readJsonObject(req, { allowLocation: true }));
    if (!parsed.success) throw new ValidationError("Invalid money operation", parsed.error.issues);
    const input = parsed.data;

    const { ctx } = await requireScannerContext(input.businessId ?? null);
    // The counter, as every other scanner route records it. A member of staff at a till.
    const source = OperationSource.SCANNER;

    switch (input.action) {
      case "earn":
        return NextResponse.json(
          await earnCashback(ctx, {
            customerCardId: input.customerCardId,
            grossAmountMinor: input.grossAmountMinor,
            idempotencyKey: input.idempotencyKey,
            locationId: input.locationId,
            source,
          }),
          { status: 201 },
        );
      case "redeem":
        return NextResponse.json(
          await redeemCashback(ctx, {
            customerCardId: input.customerCardId,
            grossAmountMinor: input.grossAmountMinor,
            requestedRedemptionMinor: input.requestedRedemptionMinor,
            idempotencyKey: input.idempotencyKey,
            locationId: input.locationId,
            source,
          }),
          { status: 201 },
        );
      case "discount":
        return NextResponse.json(
          await applyDiscount(ctx, {
            customerCardId: input.customerCardId,
            grossAmountMinor: input.grossAmountMinor,
            idempotencyKey: input.idempotencyKey,
            locationId: input.locationId,
            source,
          }),
          { status: 201 },
        );
      case "reverse":
        return NextResponse.json(
          await reverseMonetaryOperation(ctx, {
            monetaryOperationId: input.monetaryOperationId,
            reason: input.reason,
            idempotencyKey: input.idempotencyKey,
            source,
          }),
          { status: 201 },
        );
    }
  } catch (e) {
    return errorResponse(e);
  }
}
