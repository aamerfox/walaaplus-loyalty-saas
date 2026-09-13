import { NextResponse } from "next/server";
import { z } from "zod";
import { ValidationError } from "@/server/errors";
import { errorResponse, readJsonObject } from "@/server/http";
import { createSourceLink, setSourceLinkActive, updateSourceLink } from "@/server/program/source-links";
import { requireScannerContext } from "@/server/tenant/scanner-context";

/**
 * POST /api/staff/sources — manage a program's INTERNAL named sources.
 *
 * A named source is attribution metadata: it answers "where did this customer come from" for staff
 * reporting. It is not a channel. Owner decision **B7** is unchanged, and this endpoint is built so
 * that it stays unchanged:
 *
 *  - **no token is ever returned.** Not on create, not on update, not in a list. `publicToken` is a
 *    capability the schema requires and the product does not use;
 *  - **no URL, slug, QR or landing page exists** for a source, here or anywhere else;
 *  - the only thing that consumes a source is `enrollAtCounter`, behind a session, resolving the
 *    program's built-in counter source from the staff member's own membership.
 *
 * The built-in counter source is protected in the service: it cannot be renamed, deactivated or
 * removed, because it is what staff enrol through.
 */

const sourceLinkId = z.string().min(1).max(64);
const business = z.string().min(1).optional();

const bodySchema = z.discriminatedUnion("action", [
  z.strictObject({
    action: z.literal("create"),
    businessId: business,
    templateId: z.string().min(1).max(64),
    name: z.string().trim().min(1).max(120),
    utmSource: z.string().trim().min(1).max(60),
    utmMedium: z.string().trim().min(1).max(60).optional(),
    utmCampaign: z.string().trim().min(1).max(120).optional(),
    /** Per-source welcome bonus override, fixed at creation: it is baked into the cards it issues. */
    welcomeUnitQuantity: z.number().int().min(0).max(1_000_000).optional(),
  }),
  z.strictObject({
    action: z.literal("update"),
    businessId: business,
    sourceLinkId,
    name: z.string().trim().min(1).max(120).optional(),
    utmMedium: z.string().trim().max(60).optional(),
    utmCampaign: z.string().trim().max(120).optional(),
  }),
  z.strictObject({ action: z.literal("activate"), businessId: business, sourceLinkId }),
  z.strictObject({ action: z.literal("deactivate"), businessId: business, sourceLinkId }),
]);

export async function POST(req: Request) {
  try {
    const parsed = bodySchema.safeParse(await readJsonObject(req));
    if (!parsed.success) throw new ValidationError("Invalid source change", parsed.error.issues);
    const input = parsed.data;

    const { ctx } = await requireScannerContext(input.businessId ?? null);

    switch (input.action) {
      case "create": {
        const created = await createSourceLink(ctx, {
          templateId: input.templateId,
          name: input.name,
          utmSource: input.utmSource,
          utmMedium: input.utmMedium,
          utmCampaign: input.utmCampaign,
          welcomeUnitQuantity: input.welcomeUnitQuantity,
        });
        // The summary the service returns carries no token. Nothing here adds one.
        return NextResponse.json(created, { status: 201 });
      }
      case "update":
        return NextResponse.json(
          await updateSourceLink(ctx, input.sourceLinkId, {
            ...(input.name !== undefined ? { name: input.name } : {}),
            ...(input.utmMedium !== undefined ? { utmMedium: input.utmMedium } : {}),
            ...(input.utmCampaign !== undefined ? { utmCampaign: input.utmCampaign } : {}),
          }),
          { status: 200 },
        );
      case "activate":
        await setSourceLinkActive(ctx, input.sourceLinkId, true);
        return NextResponse.json({ ok: true }, { status: 200 });
      case "deactivate":
        await setSourceLinkActive(ctx, input.sourceLinkId, false);
        return NextResponse.json({ ok: true }, { status: 200 });
    }
  } catch (e) {
    return errorResponse(e);
  }
}
