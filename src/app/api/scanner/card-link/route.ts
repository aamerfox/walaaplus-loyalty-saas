import { NextResponse } from "next/server";
import { z } from "zod";
import { revealCardLink } from "@/server/customers/counter-enrollment";
import { ValidationError } from "@/server/errors";
import { errorResponse, readJsonObject } from "@/server/http";
import { enforceStaffLimit } from "@/server/security/staff-limit";
import { requireScannerContext } from "@/server/tenant/scanner-context";

/**
 * POST /api/scanner/card-link — show a customer their own card link again, at the counter.
 *
 * The only restore path Phase 1a has. A customer who lost their link cannot get it back by typing
 * their number into a public page, because that page is gone: it told whoever submitted a number
 * whether that number was already a customer. They ask the person at the till instead, who can see
 * who they are talking to.
 *
 * **POST, not GET, for two reasons.** A card id in a query string lands in browser history on a
 * shared till device and in any proxy access log that gets switched on later. And this is not a
 * read: the service writes an audit row, because revealing a capability is an event worth being
 * able to ask about afterwards.
 *
 * The response carries the link and its QR. The audit row carries neither, nor the phone, nor the
 * name — a live capability does not belong in a record that outlives the screen.
 */

const revealSchema = z.strictObject({
  businessId: z.string().min(1).optional(),
  customerCardId: z.string().min(1),
});

export async function POST(req: Request) {
  try {
    const body = await readJsonObject(req);
    const parsed = revealSchema.safeParse(body);
    if (!parsed.success) throw new ValidationError("Invalid request", parsed.error.issues);

    const { ctx } = await requireScannerContext(parsed.data.businessId ?? null);
    // Counted against the same per-actor window as a counter write (M-11). A reveal hands over a
    // live capability - the link that opens a customer's card - so unbounded reveals is precisely
    // the shape of abuse this window exists for.
    await enforceStaffLimit(ctx, "write");
    // Tenant-filtered inside the service: another business's card id is not found, not forbidden.
    return NextResponse.json(await revealCardLink(ctx, parsed.data.customerCardId), { status: 200 });
  } catch (e) {
    return errorResponse(e);
  }
}
