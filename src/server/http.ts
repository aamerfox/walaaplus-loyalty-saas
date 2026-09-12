import { NextResponse } from "next/server";
import { env } from "./env";
import { isAppError, ValidationError } from "./errors";

/**
 * Map a thrown error to an HTTP response. Domain errors carry their own status and code.
 * Anything else is a 500 with a generic body — internals are logged server-side, never returned.
 */
export function errorResponse(e: unknown): NextResponse {
  if (isAppError(e)) {
    return NextResponse.json({ error: { code: e.code, message: e.message } }, { status: e.status });
  }
  // The Error branch is narrowed to name and message. The other branch used to log the thrown
  // value whole, which is a standing invitation for the first non-Error throw to print
  // whatever it happens to carry.
  console.error("[api] unhandled error", e instanceof Error ? { name: e.name, message: e.message } : { type: typeof e });
  return NextResponse.json({ error: { code: "INTERNAL", message: "Internal server error" } }, { status: 500 });
}

/**
 * Phase 1a operates at ONE counter, so no request may name a location.
 *
 * The stamp engine already refuses a caller-supplied `locationId`; this repeats the check at the
 * HTTP boundary so a request carrying one is rejected before it reaches a service, and so the rule
 * is visible where a future route author is looking. Nested objects are checked too: a body like
 * `{ award: { locationId } }` must not slip through a shallow test.
 */
export function assertNoLocationInRequest(value: unknown, depth = 0): void {
  if (depth > 4 || value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) assertNoLocationInRequest(item, depth + 1);
    return;
  }
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (/^location(Id)?$/i.test(key)) {
      throw new ValidationError(
        "Phase 1a operates only at the business's Main location; a request may not name a location",
      );
    }
    assertNoLocationInRequest(nested, depth + 1);
  }
}

export interface ReadJsonOptions {
  /**
   * Allow a TOP-LEVEL `locationId`, for the authenticated scanner writes that legitimately name a
   * counter (Phase 1b).
   *
   * Deliberately not a blanket exemption. A route that opts in still gets the nested check - a body
   * like `{ award: { locationId } }` is refused whatever this flag says - and it must then parse the
   * field with a strict schema and hand it to a service that validates it against the card's pinned
   * `availableLocations` and the member's own assignment, inside the write transaction. The flag
   * only says "this endpoint has a location to talk about"; it never says the value is trusted.
   */
  allowLocation?: boolean;
}

/** Parse a JSON body, or refuse with the same generic 400 every route uses. */
export async function readJsonObject(req: Request, options: ReadJsonOptions = {}): Promise<Record<string, unknown>> {
  const body: unknown = await req.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new ValidationError("JSON body required");

  if (options.allowLocation === true) {
    // Check every nested value, and only the nested ones: the top level is this route's business.
    for (const [key, nested] of Object.entries(body as Record<string, unknown>)) {
      if (/^location(Id)?$/i.test(key)) continue;
      assertNoLocationInRequest(nested, 1);
    }
  } else {
    assertNoLocationInRequest(body);
  }
  return body as Record<string, unknown>;
}

/**
 * IPv4, optionally with a port, and IPv6, optionally bracketed with a port. Deliberately strict:
 * a value that is not an address is not a usable rate-limit key, and letting arbitrary text
 * through would let a caller mint unlimited distinct keys out of one connection.
 */
const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const IPV6 = /^[0-9a-f:]+$/i;

/**
 * Reduce one forwarded-for entry to a bare address, or null if it is not one.
 * Handles `1.2.3.4:5678`, `[::1]:5678`, `::1` and the `unknown` placeholder proxies emit.
 */
export function normalizeClientIp(raw: string | null | undefined): string | null {
  let value = (raw ?? "").trim();
  if (!value || value.toLowerCase() === "unknown") return null;

  if (value.startsWith("[")) {
    // [2001:db8::1]:443 → 2001:db8::1
    const close = value.indexOf("]");
    if (close < 0) return null;
    value = value.slice(1, close);
  } else if ((value.match(/:/g) ?? []).length === 1) {
    // 1.2.3.4:443 → 1.2.3.4 (a single colon cannot be IPv6)
    value = value.slice(0, value.indexOf(":"));
  }
  if (!value) return null;

  const v4 = IPV4.exec(value);
  if (v4) return v4.slice(1).every((o) => Number(o) <= 255) ? value : null;
  if (value.includes(":") && IPV6.test(value)) return value.toLowerCase();
  return null;
}

/**
 * Client address from forwarding headers — pure, so the trust decision is explicit and testable.
 *
 * When `trustProxyHeaders` is false the headers are ignored ENTIRELY: no address is better than a
 * forgeable one, because a forgeable address turns a per-address limit into no limit at all.
 *
 * When it is true, the value taken is the LAST entry of `X-Forwarded-For`. Anything earlier in
 * the list arrived with the request and is attacker-controlled; the final entry is the hop our
 * own proxy appended or replaced. This is correct for a proxy that replaces the header (one
 * entry) and for one that appends to it (client-supplied values first, real client last).
 */
export function clientIpFrom(get: (name: string) => string | null | undefined, trustProxyHeaders: boolean): string | null {
  if (!trustProxyHeaders) return null;

  const forwarded = get("x-forwarded-for");
  if (forwarded) {
    const hops = forwarded
      .split(",")
      .map((h) => h.trim())
      .filter(Boolean);
    const nearest = normalizeClientIp(hops[hops.length - 1]);
    if (nearest) return nearest;
  }
  return normalizeClientIp(get("x-real-ip"));
}

/** Client address for rate limiting and audit rows. Null unless a trusted proxy supplied one. */
export function clientIp(req: Request): string | null {
  return clientIpFrom((name) => req.headers.get(name), env().TRUST_PROXY_HEADERS);
}

/** Same, for the plain header record NextAuth hands to `authorize`. */
export function clientIpFromHeaderRecord(headers: Record<string, unknown> | undefined): string | null {
  return clientIpFrom((name) => {
    const v = headers?.[name];
    if (typeof v === "string") return v;
    if (Array.isArray(v) && typeof v[0] === "string") return v[0];
    return null;
  }, env().TRUST_PROXY_HEADERS);
}
