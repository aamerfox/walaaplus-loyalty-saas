import { env } from "../env";

/**
 * The public enrolment URL a customer opens, built from one opaque token.
 *
 * This is the only place the product turns a token into a link, so there is exactly one answer to
 * "what do we print on the table card".
 *
 * **No locale prefix.** `/join/<token>` is rewritten by next-intl to the visitor's negotiated
 * locale, falling back to Arabic. A printed QR outlives the decision about which language the
 * person holding it reads, and hard-coding `/ar/` would hand an English-speaking visitor an
 * Arabic page for no reason.
 *
 * **The origin comes from configuration, not from the request.** A link built from a request
 * header is a link an attacker can influence: `Host` and `X-Forwarded-Host` are attacker-supplied
 * unless something strips them, and this value gets printed, copied and pasted into a QR that a
 * merchant then trusts. `NEXTAUTH_URL` is set by the deployment and validated at startup.
 */
export function publicEnrollmentUrl(token: string): string {
  const e = env();
  const origin = (e.NEXT_PUBLIC_APP_URL ?? e.NEXTAUTH_URL).replace(/\/+$/, "");
  return `${origin}/join/${token}`;
}
