import { NextResponse } from "next/server";
import { clientIp, errorResponse } from "@/server/http";
import { registerRateLimiter } from "@/server/rate-limit";
import { registerBusinessOwner } from "@/server/registration/register";

/**
 * POST /api/auth/register
 * Creates User + Business + OWNER membership + Main location atomically (service layer).
 * Public by nature, so it is rate limited per client address (10 / 15 min, in-process; see
 * src/server/rate-limit.ts for the multi-replica note).
 */
export async function POST(req: Request) {
  const ip = clientIp(req) ?? "unknown";
  const limit = registerRateLimiter.hit(ip);
  if (!limit.allowed) {
    return NextResponse.json(
      { error: { code: "RATE_LIMITED", message: "Too many registration attempts. Try again later." } },
      { status: 429, headers: { "retry-after": String(limit.retryAfterSeconds) } },
    );
  }

  const body: unknown = await req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: { code: "VALIDATION_ERROR", message: "JSON body required" } }, { status: 400 });
  }
  try {
    const result = await registerBusinessOwner(body as Parameters<typeof registerBusinessOwner>[0], {
      ipAddress: clientIp(req),
    });
    return NextResponse.json({ businessId: result.businessId }, { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}
