import { ApiScope } from "@prisma/client";
import { ApiErrorCode, decodeCursor, pageSize } from "@/server/api/contract";
import { listApiEvents } from "@/server/api/events";
import { apiFail, apiInternal, apiOk, guardApiRequest } from "@/server/api/request";

/**
 * `GET /api/v1/events` — the public, read-only event feed.
 *
 * The first endpoint in this product that somebody outside it can reach. Everything that makes that
 * safe is somewhere else on purpose: `guardApiRequest` owns the order of the checks, `listApiEvents`
 * owns the tenant filter and the sort, and `docs/PUBLIC-API-V1.md` is what a consumer reads. This
 * file is the join, and it is deliberately short enough to audit in one sitting.
 *
 * **`GET` is the only export.** There is no `POST`, no `OPTIONS`, and no write anywhere under
 * `/api/v1`; anything else gets the framework's 405 without reaching our code.
 */

/**
 * Never prerendered, never revalidated.
 *
 * The response depends on a request header and on rows that change, so a statically-optimised copy
 * would be one tenant's page served from a build artefact.
 */
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const guard = await guardApiRequest(req, ApiScope.EVENTS_READ);
    if (!guard.ok) return guard.response;

    const params = new URL(req.url).searchParams;

    /*
     * Clamp what has a sensible default; refuse what does not.
     *
     * `limit` of "abc" has one obviously-safe reading, so `pageSize` returns the default and the
     * request succeeds. A cursor has no safe reading: quietly serving page one would restart a
     * consumer's traversal without telling it, and a client looping "fetch page, follow cursor"
     * would re-ingest the whole feed forever. So a cursor we did not issue is an error.
     *
     * An EMPTY `?cursor=` is treated as absent rather than malformed. It cannot have come from
     * following `nextCursor` — that is either a non-empty string or null — so it means "I have no
     * cursor", which is what a client building a URL from an unset variable is saying.
     */
    const rawCursor = params.get("cursor");
    const cursor = rawCursor === null || rawCursor === "" ? null : decodeCursor(rawCursor);
    if (rawCursor !== null && rawCursor !== "" && cursor === null) {
      // The submitted value is not echoed: a cursor is not secret, but a rule that never reflects
      // caller input back into a response is a rule with no exceptions to get wrong later.
      return apiFail(ApiErrorCode.BAD_REQUEST, "The cursor is not one this API issued", 400);
    }

    const { items, page } = await listApiEvents(guard.ctx, {
      size: pageSize(params.get("limit")),
      cursor,
    });
    return apiOk(items, page);
  } catch (e) {
    return apiInternal(e);
  }
}
