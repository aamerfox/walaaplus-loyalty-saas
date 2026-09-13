import { NextResponse } from "next/server";
import { resolveShareLink } from "@/server/share/share-links";

/**
 * POST /api/share/resolve — is this invitation link live, and whose business is it for?
 *
 * The only endpoint in the product a stranger reaches while holding a capability, so the rules are
 * narrow and all of them are about what it does NOT do.
 *
 * **POST with the token in the body, never in the URL.** A path or query token is written to every
 * access log, proxy log and error report between the browser and here. The invitation link carries
 * its token in a URL fragment, which is not sent with a request at all; the page reads it in the
 * browser and posts it, and this is the single point on the server where one is ever seen.
 *
 * **Nothing is written.** No audit row, no visit counter, no last-seen timestamp, no IP, no user
 * agent. A capability that leaves a trail each time it is opened is a capability that reports who
 * has been looking at it, and an invitation page has no business knowing that.
 *
 * **Nothing is logged.** The body is not echoed into an error, and no `console` call in this handler
 * or below it sees the token.
 *
 * **One response shape for every failure.** Unknown, revoked, malformed, a card since deleted, a
 * business gone inactive — all of them answer `{ ok: false }`. Telling "never existed" apart from
 * "existed and was revoked" is exactly the difference worth probing for, and a visitor has no use
 * for it either way.
 *
 * **No rate limit, deliberately.** A per-address limit would mean storing the address of everyone
 * who opens an invitation, which is precisely the tracking this page exists without. The token is
 * 256 bits behind one indexed digest lookup.
 *
 * A success returns the business name and nothing else: no customer, no card, no balance, no
 * programme, no serial, no token, and no identifier to pivot from.
 */

/** Never cached, by anything. A response about a capability is not a public document. */
const NO_STORE = { "cache-control": "no-store, no-cache, must-revalidate", pragma: "no-cache" } as const;

export async function POST(req: Request) {
  let token: unknown;
  try {
    const body: unknown = await req.json();
    token = body && typeof body === "object" ? (body as Record<string, unknown>).token : undefined;
  } catch {
    // A malformed body is answered like an unknown token. It is not reported, because the report
    // would be the only record that somebody tried.
    return NextResponse.json({ ok: false }, { status: 200, headers: NO_STORE });
  }

  const view = await resolveShareLink(token);
  if (!view) return NextResponse.json({ ok: false }, { status: 200, headers: NO_STORE });

  return NextResponse.json({ ok: true, businessName: view.businessName }, { status: 200, headers: NO_STORE });
}

/**
 * Everything else is a 405 with no body.
 *
 * Named explicitly rather than left to the router so that a GET — the shape that would put a token
 * in a URL — is refused by something a reader can see, rather than by a default.
 */
export function GET() {
  return new NextResponse(null, { status: 405, headers: { allow: "POST", ...NO_STORE } });
}
