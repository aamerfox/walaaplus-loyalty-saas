import { NextResponse } from "next/server";
import { findCardByQrToken, findCardBySerial, findCardsByPhone } from "@/server/customers/lookup";
import { ValidationError } from "@/server/errors";
import { assertNoLocationInRequest, errorResponse } from "@/server/http";
import { requireScannerContext } from "@/server/tenant/scanner-context";

/**
 * GET /api/scanner/lookup — find the customer at the counter.
 *
 * Three equal first-class paths (PRODUCT-SPEC §7): the scanned QR, the phone number, and the
 * serial printed on the card. Phone lookup is not a fallback — a delivery business never sees the
 * customer's screen.
 *
 * Every path resolves through the tenant-scoped services, so another business's token, number or
 * serial is "not found", the same answer as something that does not exist.
 */
export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const params = Object.fromEntries(url.searchParams.entries());
    // The query string is a request too: it may not name a location either.
    assertNoLocationInRequest(params);

    const { ctx } = await requireScannerContext(params.businessId ?? null);

    if (params.qr) return NextResponse.json({ cards: [await findCardByQrToken(ctx, params.qr)] });
    if (params.serial) return NextResponse.json({ cards: [await findCardBySerial(ctx, params.serial)] });
    if (params.phone !== undefined) return NextResponse.json({ cards: await findCardsByPhone(ctx, params.phone) });

    throw new ValidationError("Provide a qr token, a phone number or a serial to look up");
  } catch (e) {
    return errorResponse(e);
  }
}
