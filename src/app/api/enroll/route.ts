import { NextResponse } from "next/server";
import { enrollCustomer } from "@/server/customers/enrollment";
import { isAppError } from "@/server/errors";
import { clientIp, errorResponse, readJsonObject } from "@/server/http";
import { consumeEnrollmentLimit } from "@/server/security/rate-limit";

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
 *  - **No enumeration.** A first enrollment and a repeat enrollment return the SAME shape. The
 *    response never says "you already have a card here", because that would turn this endpoint
 *    into a way to ask whether a phone number is a customer of a given café.
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
      consentTextVersion: typeof body.consentTextVersion === "string" ? body.consentTextVersion : undefined,
    });

    // Identical whether this call issued the card or found one. `created` is not returned.
    return accepted(result.shareToken);
  } catch (e) {
    // Domain errors keep their status: a malformed phone number is the customer's to fix, and an
    // unknown link is a dead QR. Neither reveals anything about who is or is not a customer.
    if (isAppError(e)) return errorResponse(e);
    return errorResponse(e);
  }
}
