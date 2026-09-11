import { NextResponse } from "next/server";
import { ConflictError } from "@/server/errors";
import { clientIp, errorResponse } from "@/server/http";
import { consumeRegisterLimit } from "@/server/security/rate-limit";
import { registerBusinessOwner } from "@/server/registration/register";

/**
 * POST /api/auth/register
 * Creates User + Business + OWNER membership + Main location atomically (service layer).
 *
 * **This route never reveals whether an email already has an account.** A submission that
 * conflicts with an existing account and one that creates a new one produce the SAME status and
 * the SAME body, so the endpoint cannot be used to enumerate customers of the platform. The
 * service still raises ConflictError internally — the seed and the admin paths need the truth —
 * and it is this route, the public boundary, that flattens it.
 *
 * Two details make the two paths genuinely indistinguishable rather than merely similar:
 *  - the response carries no identifier of the created business, so there is nothing to compare;
 *  - `registerBusinessOwner` hashes the password BEFORE it opens its transaction, so both paths
 *    pay the same bcrypt cost and the duplicate case is not measurably faster.
 *
 * The caller is told to sign in, which works for exactly one of the two people who can see this
 * response: whoever owns the password for that address. When the email provider of decision D3
 * lands in Phase 1a, this becomes the usual "check your inbox" confirmation and the existing-
 * account case is told so by email rather than by HTTP.
 *
 * Rate limited per submitted email and, where a trusted proxy supplies one, per client address.
 * Forwarding headers are ignored unless TRUST_PROXY_HEADERS is set, so a forged X-Forwarded-For
 * cannot mint fresh windows (src/server/http.ts, docs/PHASE-0-IMPLEMENTATION.md §9).
 */

/** The single answer both outcomes get. Fixed shape, fixed status, no identifiers. */
const ACCEPTED = {
  status: "accepted",
  message: "If this email can be registered, the account is ready. Please sign in to continue.",
} as const;

function accepted(): NextResponse {
  return NextResponse.json(ACCEPTED, { status: 202 });
}

export async function POST(req: Request) {
  const ip = clientIp(req);

  const body: unknown = await req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: { code: "VALIDATION_ERROR", message: "JSON body required" } }, { status: 400 });
  }

  // Key the email window on the raw submission, normalised by the limiter. Reading it here does
  // not validate it: an unparseable body was already rejected above, and a malformed email is
  // refused by the service with the same 400 any other invalid field would produce.
  const submittedEmail = typeof (body as { email?: unknown }).email === "string" ? (body as { email: string }).email : null;

  const limit = await consumeRegisterLimit(ip, submittedEmail);
  if (!limit.allowed) {
    return NextResponse.json(
      { error: { code: "RATE_LIMITED", message: "Too many attempts. Please try again later." } },
      { status: 429, headers: { "retry-after": String(limit.retryAfterSeconds) } },
    );
  }

  try {
    await registerBusinessOwner(body as Parameters<typeof registerBusinessOwner>[0], { ipAddress: ip });
  } catch (e) {
    // A duplicate email is answered exactly like a successful registration. Every other failure
    // (validation, database) keeps its own status: those describe the request, not the account.
    if (!(e instanceof ConflictError)) return errorResponse(e);
  }
  return accepted();
}
