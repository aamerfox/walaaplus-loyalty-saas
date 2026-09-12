import { NextResponse } from "next/server";

/**
 * POST /api/enroll — **withdrawn.** Public self-service enrolment no longer exists.
 *
 * Owner decision **B7, option 3**. The reason is structural, not a bug that was patched:
 *
 * A public form that issues a live card to a number that has never enrolled, and reveals nothing
 * for a number that has, tells whoever submits it which case they hit — they either receive a card
 * or they do not. That is true of any implementation. Matching the status code, the response shape
 * and the redirect does not close it, because the signal is the card itself. Only proof that the
 * submitter owns the number closes it, and Phase 1a has no channel to obtain one: the SMS provider
 * and WhatsApp decisions are deferred, and one-time-code restore is explicitly out of scope.
 *
 * So the endpoint is gone rather than hardened, and enrolment happens at the counter, where the
 * person handing over a card can see who they are handing it to:
 * `POST /api/scanner/enroll`, behind a session.
 *
 * **This handler reads nothing.** No body is parsed, no token is resolved, no phone is normalised,
 * no rate-limit window is touched and no database query runs. Every caller gets the identical
 * response at the identical cost, so the withdrawn endpoint cannot be turned back into the oracle
 * it replaced — not by a valid link versus an invalid one, and not by an enrolled number versus a
 * new one.
 *
 * **410, not 404.** The route existed, was published on printed material, and has been withdrawn
 * deliberately. A customer holding an old printed QR gets a page that tells them to ask at the
 * counter, which is true and actionable; pretending the address never existed would be neither.
 *
 * Existing cards, card URLs, balances, programs, ledger rows and enrolment source records are all
 * untouched. A customer who already has their link keeps using it.
 */

const WITHDRAWN = {
  error: {
    code: "ENROLLMENT_MOVED",
    message: "Enrollment now happens at the counter. Please ask a member of staff to add your card.",
  },
} as const;

function withdrawn(): NextResponse {
  return NextResponse.json(WITHDRAWN, { status: 410 });
}

export async function POST(): Promise<NextResponse> {
  return withdrawn();
}

/** Answered the same way, so probing with a different verb learns nothing either. */
export async function GET(): Promise<NextResponse> {
  return withdrawn();
}
