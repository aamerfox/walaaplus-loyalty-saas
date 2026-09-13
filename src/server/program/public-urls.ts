import { env } from "../env";

/**
 * Absolute public URLs, built from configuration rather than from a request.
 *
 * **The origin never comes from a request header.** `Host` and `X-Forwarded-Host` are
 * attacker-supplied unless something strips them, and these values get printed, copied and turned
 * into QR codes that a merchant then trusts. `NEXTAUTH_URL` is set by the deployment and validated
 * at startup.
 *
 * **No locale prefix.** `/card/<token>` is rewritten by next-intl to the visitor's negotiated
 * locale, falling back to Arabic. A printed QR outlives the decision about which language the
 * person holding it reads.
 *
 * This module used to export `publicEnrollmentUrl` as well. Public self-service enrolment was
 * removed by owner decision B7 option 3 — a public form that issues a card to a new number and
 * nothing to an existing one tells the submitter which case they hit — so there is no public
 * enrolment URL to build any more. Cards enrolled at the counter still get exactly this link.
 */
function origin(): string {
  const e = env();
  return (e.NEXT_PUBLIC_APP_URL ?? e.NEXTAUTH_URL).replace(/\/+$/, "");
}

/** Where a customer opens their own card. The token is a capability; treat the URL as one. */
export function publicCardUrl(shareToken: string): string {
  return `${origin()}/card/${shareToken}`;
}

/**
 * Where a customer opens the invitation page for their card's business.
 *
 * **The token is in the FRAGMENT, and that is the whole design.** A fragment is not sent with the
 * request, so the capability appears in no access log, no proxy log, no `Referer` header and no
 * error report — not on this server and not on any server the visitor navigates to next. The page
 * reads it in the browser and posts it to `/api/share/resolve` in a body.
 *
 * No locale prefix, for the same reason `publicCardUrl` has none: a link that outlives the moment
 * it was created should not also fix the language of whoever eventually opens it.
 */
export function publicShareUrl(rawToken: string): string {
  return `${origin()}/share#${rawToken}`;
}
