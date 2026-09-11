import { NextResponse } from "next/server";
import { isAppError } from "./errors";

/**
 * Map a thrown error to an HTTP response. Domain errors carry their own status and code.
 * Anything else is a 500 with a generic body — internals are logged server-side, never returned.
 */
export function errorResponse(e: unknown): NextResponse {
  if (isAppError(e)) {
    return NextResponse.json({ error: { code: e.code, message: e.message } }, { status: e.status });
  }
  console.error("[api] unhandled error", e instanceof Error ? { name: e.name, message: e.message } : e);
  return NextResponse.json({ error: { code: "INTERNAL", message: "Internal server error" } }, { status: 500 });
}

/** Best-effort client address for audit rows. Trusts proxy headers only because the app sits behind one. */
export function clientIp(req: Request): string | null {
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0]?.trim() || null;
  return req.headers.get("x-real-ip");
}
