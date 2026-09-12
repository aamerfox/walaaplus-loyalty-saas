import { NextResponse } from "next/server";
import { z } from "zod";
import { enrollAtCounter } from "@/server/customers/counter-enrollment";
import { ValidationError } from "@/server/errors";
import { errorResponse, readJsonObject } from "@/server/http";
import { requireScannerContext } from "@/server/tenant/scanner-context";

/**
 * POST /api/scanner/enroll — sign a customer up at the till.
 *
 * The replacement for public self-service enrolment, which owner decision **B7 option 3** removed.
 * Everything that made the public route dangerous is absent here by construction: the caller is a
 * verified member of a business, and the business, the program, the enrolment source and the
 * location are all resolved on the server from that membership.
 *
 * The schema is **strict** and accepts four fields. A body naming a `businessId`, a `sourceToken`,
 * a `locationId`, a balance or a welcome bonus is refused outright rather than ignored — the point
 * of a strict schema at a boundary is that "we happen not to read it" stops being load-bearing.
 * `readJsonObject` refuses a location under any nesting before the schema is even reached.
 *
 * Repeats are safe: the service is idempotent, so one customer keeps one card and one welcome
 * bonus however many times a cashier who does not remember them presses the button.
 */

const enrollSchema = z.strictObject({
  /** Present only when the caller belongs to several businesses; verified, never trusted. */
  businessId: z.string().min(1).optional(),
  phone: z.string().trim().min(1).max(32),
  firstName: z.string().trim().max(80).optional(),
  lastName: z.string().trim().max(80).optional(),
  /** Ticked at the counter, by the customer, on the staff member's device. */
  marketingConsent: z.boolean().optional(),
});

export async function POST(req: Request) {
  try {
    const body = await readJsonObject(req);
    const parsed = enrollSchema.safeParse(body);
    if (!parsed.success) throw new ValidationError("Invalid customer details", parsed.error.issues);
    const input = parsed.data;

    const { ctx } = await requireScannerContext(input.businessId ?? null);

    const result = await enrollAtCounter(ctx, {
      phone: input.phone,
      firstName: input.firstName?.trim() || undefined,
      lastName: input.lastName?.trim() || undefined,
      marketingConsent: input.marketingConsent === true,
    });

    // 201 when this call issued the card, 200 when the customer already had one. Staff are
    // authorized to know the difference; the public route never was, which is why it is gone.
    return NextResponse.json(result, { status: result.created ? 201 : 200 });
  } catch (e) {
    return errorResponse(e);
  }
}
