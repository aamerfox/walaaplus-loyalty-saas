import { NextResponse } from "next/server";
import { clientIp, errorResponse } from "@/server/http";
import { registerBusinessOwner } from "@/server/registration/register";

/**
 * POST /api/auth/register
 * Creates User + Business + OWNER membership + Main location atomically (service layer).
 * Public by nature. Rate limiting is tracked as a Prompt 0.3 item.
 */
export async function POST(req: Request) {
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
