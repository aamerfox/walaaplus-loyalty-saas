import { ConsentScope, ConsentState } from "@prisma/client";
import { NextResponse } from "next/server";
import { z } from "zod";
import { recordConsentChange } from "@/server/consent/consent";
import { ValidationError } from "@/server/errors";
import { errorResponse, readJsonObject } from "@/server/http";
import { requireScannerContext } from "@/server/tenant/scanner-context";

/**
 * POST /api/staff/consent — record that a customer changed their mind, to a member of staff.
 *
 * This is the ONLY way a marketing preference changes after enrolment, and it is deliberately a
 * staff action behind a session: there is no customer-facing preference route and no unsubscribe
 * link, because letting somebody change a stored preference by opening a URL needs an
 * authenticated customer session this product does not have. A URL that writes without one is an
 * oracle and a vandalism tool at once.
 *
 * It never touches `CustomerBusinessProfile`. The enrolment answer is history; this appends.
 */

const bodySchema = z.strictObject({
  businessId: z.string().min(1).optional(),
  customerBusinessProfileId: z.string().min(1).max(64),
  /** One scope exists. Named rather than defaulted, so a second cannot arrive by accident. */
  scope: z.literal(ConsentScope.MARKETING),
  state: z.enum([ConsentState.GRANTED, ConsentState.WITHDRAWN]),
  /** The merchant's own words. Bounded, and never echoed into an audit row. */
  reason: z.string().trim().min(1).max(280).optional(),
});

export async function POST(req: Request) {
  try {
    const parsed = bodySchema.safeParse(await readJsonObject(req));
    if (!parsed.success) throw new ValidationError("Invalid consent change", parsed.error.issues);
    const input = parsed.data;

    const { ctx } = await requireScannerContext(input.businessId ?? null);
    const status = await recordConsentChange(ctx, input.customerBusinessProfileId, {
      scope: input.scope,
      state: input.state,
      reason: input.reason,
    });
    return NextResponse.json(status, { status: 200 });
  } catch (e) {
    return errorResponse(e);
  }
}
