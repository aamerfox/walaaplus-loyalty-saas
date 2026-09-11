import { NextResponse } from "next/server";
import { clientIp, errorResponse } from "@/server/http";
import { consumeRegisterLimit } from "@/server/security/rate-limit";
import { registerBusinessOwner } from "@/server/registration/register";

/**
 * POST /api/auth/register
 * Creates User + Business + OWNER membership + Main location atomically (service layer).
 *
 * Public by nature, so it is rate limited per client address in the DATABASE
 * (src/server/security/rate-limit.ts), not in process memory: the limit must survive a restart
 * and hold across web processes. The refusal body is fixed text — it never says which window
 * was exhausted, and it is identical whether or not the submitted email belongs to an account.
 */
export async function POST(req: Request) {
  const ip = clientIp(req);
  const limit = await consumeRegisterLimit(ip);
  if (!limit.allowed) {
    return NextResponse.json(
      { error: { code: "RATE_LIMITED", message: "Too many attempts. Please try again later." } },
      { status: 429, headers: { "retry-after": String(limit.retryAfterSeconds) } },
    );
  }

  const body: unknown = await req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: { code: "VALIDATION_ERROR", message: "JSON body required" } }, { status: 400 });
  }
  try {
    const result = await registerBusinessOwner(body as Parameters<typeof registerBusinessOwner>[0], { ipAddress: ip });
    return NextResponse.json({ businessId: result.businessId }, { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}
