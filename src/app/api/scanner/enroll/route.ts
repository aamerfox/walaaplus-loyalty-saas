import { NextResponse } from "next/server";
import { z } from "zod";
import { enrollAtCounter } from "@/server/customers/counter-enrollment";
import { recordCounterReferral } from "@/server/share/referrals";
import { ValidationError } from "@/server/errors";
import { errorResponse, readJsonObject } from "@/server/http";
import { enforceStaffLimit } from "@/server/security/staff-limit";
import { requireScannerContext } from "@/server/tenant/scanner-context";

/**
 * POST /api/scanner/enroll — sign a customer up at the till.
 *
 * The replacement for public self-service enrolment, which owner decision **B7 option 3** removed.
 * Everything that made the public route dangerous is absent here by construction: the caller is a
 * verified member of a business, and the business, the program, the enrolment source and the
 * location are all resolved on the server from that membership.
 *
 * The schema is **strict** and accepts four fields. A body naming a `businessId`, a `sourceToken`,
 * a `locationId`, a balance or a welcome bonus is refused outright rather than ignored — the point
 * of a strict schema at a boundary is that "we happen not to read it" stops being load-bearing.
 * `readJsonObject` refuses a location under any nesting before the schema is even reached.
 *
 * Repeats are safe: the service is idempotent, so one customer keeps one card and one welcome
 * bonus however many times a cashier who does not remember them presses the button.
 */

const enrollSchema = z.strictObject({
  /** Present only when the caller belongs to several businesses; verified, never trusted. */
  businessId: z.string().min(1).optional(),
  phone: z.string().trim().min(1).max(32),
  firstName: z.string().trim().max(80).optional(),
  lastName: z.string().trim().max(80).optional(),
  /** Ticked at the counter, by the customer, on the staff member's device. */
  marketingConsent: z.boolean().optional(),
  /**
   * The invitation the customer showed, if they showed one.
   *
   * **In the body, and the fragment only.** The scanner strips everything before the `#` before
   * sending, so a capability never reaches a path, a query string, an access log or a `Referer`
   * header — the same property the public page relies on, held on the one authenticated route that
   * is allowed to see one at all.
   *
   * Resolved once, server-side, and discarded. It is never stored, never audited, never logged and
   * never returned.
   *
   * Bounded but **not shape-checked here**, deliberately. A malformed invitation must not turn a
   * successful enrolment into a 400: the customer is standing at the till and has earned their card
   * whatever they scanned. The service applies the real shape rule and answers `NOT_ACCEPTED`, the
   * same as every other refusal.
   */
  referralToken: z.string().trim().min(1).max(400).optional(),
});

export async function POST(req: Request) {
  try {
    const body = await readJsonObject(req);
    const parsed = enrollSchema.safeParse(body);
    if (!parsed.success) throw new ValidationError("Invalid customer details", parsed.error.issues);
    const input = parsed.data;

    const { ctx } = await requireScannerContext(input.businessId ?? null);
    // Finding M-11: one member of staff, one window. Counted after the membership is verified
    // (there is nothing to key on before that) and before the service runs.
    await enforceStaffLimit(ctx, "enroll");

    const result = await enrollAtCounter(ctx, {
      phone: input.phone,
      firstName: input.firstName?.trim() || undefined,
      lastName: input.lastName?.trim() || undefined,
      marketingConsent: input.marketingConsent === true,
    });

    /*
     * Attribution, and only for a card this call actually issued.
     *
     * A customer who already had a card was not referred by anybody today, so a repeat lookup
     * records nothing — attributing one would be retrospective attribution wearing a counter's
     * clothes. The outcome is one of two values, and an unusable invitation never turns a
     * successful enrolment into an error: the customer is standing at the till and has their card.
     */
    const referral =
      input.referralToken && result.created
        ? await recordCounterReferral(ctx, {
            rawToken: input.referralToken,
            enrolledCustomerCardId: result.customerCardId,
            enrolledProfileId: result.customerBusinessProfileId,
          })
        : input.referralToken
          ? ("NOT_ACCEPTED" as const)
          : undefined;

    // 201 when this call issued the card, 200 when the customer already had one. Staff are
    // authorized to know the difference; the public route never was, which is why it is gone.
    return NextResponse.json({ ...result, referral }, { status: result.created ? 201 : 200 });
  } catch (e) {
    return errorResponse(e);
  }
}
