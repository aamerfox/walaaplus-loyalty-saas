import { NextResponse } from "next/server";
import { enrollCustomer } from "@/server/customers/enrollment";
import { isAppError } from "@/server/errors";
import { ENROLLMENT_CONSENT_VERSION } from "@/server/customers/consent";
import { clientIp, errorResponse, readJsonObject } from "@/server/http";
import { consumeEnrollmentLimit } from "@/server/security/rate-limit";
import { opaqueToken } from "@/server/security/tokens";

/**
 * POST /api/enroll — public customer enrollment.
 *
 * The only public write in the product. Everything about it is shaped by that:
 *
 *  - **No session, no tenant input.** The opaque link token is the only thing that says which
 *    program is being joined; business, template and version are all derived from it server-side.
 *    A body naming a businessId, templateId, cardId or locationId gets nowhere near a service.
 *  - **Rate limited in the database**, per client address and per link, so the limit survives a
 *    restart and holds across web processes. Welcome bonuses make this an abuse target
 *    (PRODUCT-SPEC §6.1).
 *  - **Honeypot.** A field no human fills in. Bots fill every input they find; a filled honeypot is
 *    answered exactly like a success, so a script gets no signal that it was caught.
 *  - **No enumeration.** A first enrollment and a repeat enrollment return the SAME shape, and the
 *    repeat's token opens nothing. The response never says "you already have a card here", and it
 *    never hands back the existing card either — both would turn this endpoint into a way to ask
 *    whether a phone number is a customer of a given café, the second one by simply showing you.
 *
 * The response carries the card's page token and nothing else — no ids, no phone number.
 */

/** The field a human never sees and never fills. Named to look worth filling to a script. */
export const HONEYPOT_FIELD = "companyWebsite";

interface EnrollResponse {
  /** Where to send the customer: their own card, addressed by its opaque token. */
  cardToken: string;
}

function accepted(cardToken: string): NextResponse {
  return NextResponse.json({ cardToken } satisfies EnrollResponse, { status: 200 });
}

export async function POST(req: Request) {
  try {
    const body = await readJsonObject(req);
    const sourceToken = typeof body.sourceToken === "string" ? body.sourceToken : "";
    const ip = clientIp(req);

    const limit = await consumeEnrollmentLimit(ip, sourceToken);
    if (!limit.allowed) {
      return NextResponse.json(
        { error: { code: "RATE_LIMITED", message: "Too many attempts. Please try again later." } },
        { status: 429, headers: { "retry-after": String(limit.retryAfterSeconds) } },
      );
    }

    // A filled honeypot is a bot. It is counted against the rate limit above — deliberately, since
    // that is the cheapest place to slow one down — and then answered with a plausible-looking
    // failure that says nothing about why.
    const honeypot = body[HONEYPOT_FIELD];
    if (typeof honeypot === "string" && honeypot.trim() !== "") {
      return NextResponse.json(
        { error: { code: "VALIDATION_ERROR", message: "Enrollment could not be completed." } },
        { status: 400 },
      );
    }

    const result = await enrollCustomer({
      sourceToken,
      phone: typeof body.phone === "string" ? body.phone : "",
      firstName: typeof body.firstName === "string" ? body.firstName : undefined,
      lastName: typeof body.lastName === "string" ? body.lastName : undefined,
      marketingConsent: body.marketingConsent === true,
      // Stamped from the server's own constant, never read from the body. A version the browser
      // has to remember to send is a version that goes missing - which is exactly what happened:
      // the form never sent one, so every real enrolment stored NULL for both the version and the
      // timestamp, while the tests passed because they supplied one by hand.
      consentTextVersion: ENROLLMENT_CONSENT_VERSION,
    });

    /*
     * The card token is returned ONLY when this call created the card.
     *
     * The response shape was already identical for a first and a repeat enrolment, and that was
     * not enough. On a repeat the VALUE was the existing card's live `shareToken` — so anyone
     * holding the enrolment link, which is printed on the counter and published as a QR, could
     * post a phone number and receive that person's card page: their name, their balances, their
     * serial, and the scanner token they present at the till. Knowing a phone number is not
     * knowing a customer, and this turned the one into the other.
     *
     * A repeat now gets a token of the same shape that opens nothing, so the response still
     * carries no signal about whether the number was already enrolled. A returning customer who
     * has lost their link asks the counter, where staff can find them by phone — which is exactly
     * the staff-assisted restore PHASE-PLAN.md schedules for Phase 1.5. Self-service restore needs
     * proof the caller owns the number (an OTP), and Phase 1a deliberately has neither.
     */
    return accepted(result.created ? result.shareToken : opaqueToken());
  } catch (e) {
    // Domain errors keep their status: a malformed phone number is the customer's to fix, and an
    // unknown link is a dead QR. Neither reveals anything about who is or is not a customer.
    if (isAppError(e)) return errorResponse(e);
    return errorResponse(e);
  }
}
