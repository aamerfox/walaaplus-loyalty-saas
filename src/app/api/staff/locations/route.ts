import { NextResponse } from "next/server";
import { z } from "zod";
import { ValidationError } from "@/server/errors";
import { errorResponse, readJsonObject } from "@/server/http";
import { requireScannerContext } from "@/server/tenant/scanner-context";
import { createLocation, setLocationActive, updateLocation } from "@/server/tenant/locations";

/**
 * POST /api/staff/locations — open, rename or close a counter.
 *
 * Four verbs behind one discriminated union, for the same reason the staff route uses one: they are
 * one screen's actions and they share one authorization story. Each carries exactly its own fields,
 * so a rename cannot smuggle an activation and a creation cannot smuggle an id.
 *
 * **Every rule lives in the service.** `EDIT_LOCATIONS`, the tenant scope, the name clash, the
 * ceiling, and the three refusals that protect a deactivation from breaking the business are all
 * enforced in `src/server/tenant/locations.ts`, inside its transaction, under the business row
 * lock. This route parses and delegates.
 *
 * The response carries the row the service returned, not the list: a management screen reloads its
 * list from the server afterwards, and two copies of the truth is how a screen ends up showing a
 * counter that was closed a second ago.
 */

const locationId = z.string().min(1).max(64);
const name = z.string().trim().min(1).max(80);
const address = z.string().trim().max(200);

const bodySchema = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("create"), businessId: z.string().min(1).optional(), name, address: address.optional() }),
  z.strictObject({
    action: z.literal("update"),
    businessId: z.string().min(1).optional(),
    locationId,
    name: name.optional(),
    address: address.optional(),
  }),
  z.strictObject({ action: z.literal("activate"), businessId: z.string().min(1).optional(), locationId }),
  z.strictObject({ action: z.literal("deactivate"), businessId: z.string().min(1).optional(), locationId }),
]);

export async function POST(req: Request) {
  try {
    /*
     * `allowLocation` — this endpoint's whole subject is a location, so a top-level `locationId` is
     * its own field rather than a smuggled one. The nested guard still applies: a body like
     * `{ update: { locationId } }` is refused whatever this flag says.
     */
    const parsed = bodySchema.safeParse(await readJsonObject(req, { allowLocation: true }));
    if (!parsed.success) throw new ValidationError("Invalid location change", parsed.error.issues);
    const input = parsed.data;

    const { ctx } = await requireScannerContext(input.businessId ?? null);

    switch (input.action) {
      case "create":
        return NextResponse.json(await createLocation(ctx, { name: input.name, address: input.address || undefined }), {
          status: 201,
        });
      case "update":
        return NextResponse.json(
          await updateLocation(ctx, input.locationId, {
            ...(input.name !== undefined ? { name: input.name } : {}),
            // An empty string is a real value here: it CLEARS the note. Omitting the field leaves
            // it alone, which is a different request and a different result.
            ...(input.address !== undefined ? { address: input.address } : {}),
          }),
          { status: 200 },
        );
      case "activate":
        return NextResponse.json(await setLocationActive(ctx, input.locationId, true), { status: 200 });
      case "deactivate":
        return NextResponse.json(await setLocationActive(ctx, input.locationId, false), { status: 200 });
    }
  } catch (e) {
    return errorResponse(e);
  }
}
