import { ApiScope } from "@prisma/client";
import { ApiErrorCode } from "@/server/api/contract";
import { getApiEvent } from "@/server/api/events";
import { apiFail, apiInternal, apiOk, guardApiRequest } from "@/server/api/request";

/**
 * `GET /api/v1/events/{eventId}` — one event, by the id the feed handed out.
 *
 * Safe for the same reason the list is: `getApiEvent` puts the key's `businessId` in the `WHERE`
 * beside the id, so another tenant's event **does not exist** for this caller.
 *
 * **One 404 for two situations.** An id that was never real and an id belonging to somebody else
 * get the identical response. A distinguishable answer would turn this route into a way to confirm
 * that a given id is a real event in a business the caller cannot read — a small fact, and not one
 * that is ours to give away.
 */

export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ eventId: string }> }) {
  try {
    const guard = await guardApiRequest(req, ApiScope.EVENTS_READ);
    if (!guard.ok) return guard.response;

    const { eventId } = await params;
    const event = await getApiEvent(guard.ctx, eventId);
    // The submitted id is not echoed, so a caller cannot use the error text as a reflection point.
    if (!event) return apiFail(ApiErrorCode.NOT_FOUND, "No such event", 404);

    return apiOk(event);
  } catch (e) {
    return apiInternal(e);
  }
}
