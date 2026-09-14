import { NextResponse } from "next/server";
import { z } from "zod";
import { ValidationError } from "@/server/errors";
import { errorResponse, readJsonObject } from "@/server/http";
import { redeemCoupon } from "@/server/promotions/redemption";
import { enforceStaffLimit } from "@/server/security/staff-limit";
import { requireScannerContext } from "@/server/tenant/scanner-context";

/**
 * POST /api/scanner/coupon — a member of staff types a coupon code for a customer's card.
 *
 * **The only place a raw coupon code reaches this server.** It arrives in a body, behind a verified
 * staff session, is hashed against each candidate promotion's salt, and is discarded. It is never
 * stored, returned, rendered, logged or written to an audit row.
 *
 * A code in a query string or a path would be written into every access log, proxy log and error
 * report between the till and here, which is why there is no `GET` and no lookup route.
 *
 * **Nothing about money leaves this endpoint.** A success carries the promotion's name and the
 * merchant's own sentence about what the customer gets. There is no amount, percentage, currency,
 * tax or total anywhere in this phase, and the cashier's screen says the offer was recorded for
 * manual fulfilment rather than "applied".
 *
 * **A refusal is a 200 with `NOT_ACCEPTED`**, not an error. The customer is standing at the counter
 * and the card lookup already succeeded; a bad coupon must not turn that into a failure, and the
 * refusal names no reason because a cashier who could tell "expired" from "never existed" could ask
 * the till which codes exist, one guess at a time.
 */

const bodySchema = z.strictObject({
  businessId: z.string().min(1).optional(),
  customerCardId: z.string().min(1).max(64),
  /*
   * Bounded but not shape-checked here, deliberately. A mistyped code must not produce a 400 — the
   * service applies the real rule and answers the same generic refusal as everything else.
   */
  code: z.string().trim().min(1).max(64),
});

export async function POST(req: Request) {
  try {
    const parsed = bodySchema.safeParse(await readJsonObject(req));
    if (!parsed.success) throw new ValidationError("Invalid coupon request", parsed.error.issues);
    const input = parsed.data;

    const { ctx } = await requireScannerContext(input.businessId ?? null);
    /*
     * The same per-actor window every other counter write is bounded by (finding M-11), and it
     * matters more here than elsewhere: a coupon code is short and human-chosen, so a till left
     * running a script is the one realistic way to find one by guessing.
     */
    await enforceStaffLimit(ctx, "write");

    const result = await redeemCoupon(ctx, { code: input.code, customerCardId: input.customerCardId });
    return NextResponse.json(result, { status: 200 });
  } catch (e) {
    return errorResponse(e);
  }
}
