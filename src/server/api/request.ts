import type { ApiScope } from "@prisma/client";
import { NextResponse } from "next/server";
import { type ApiContext, authenticateApiKey, hasScope, touchKey } from "./auth";
import {
  type ApiError,
  ApiErrorCode,
  type ApiErrorCodeName,
  type ApiPage,
  type ApiSuccess,
  apiError,
  apiSuccess,
  apiUnauthorized,
} from "./contract";
import { consumeApiRateLimit } from "./rate-limit";

/**
 * The one way into `/api/v1`.
 *
 * Every public handler begins with `guardApiRequest` and ends with `apiOk` or `apiFail`. Putting
 * the order in one place is the point: the sequence below is a set of decisions that only work in
 * this sequence, and a second handler that reimplemented it would eventually get one of them the
 * wrong way round.
 *
 * ## The order, and why each step is where it is
 *
 *   1. **Refuse credential-shaped query parameters** — before anything is read from the request.
 *      A key in a URL is a key in somebody's access log.
 *   2. **Authenticate** — a read, and one generic refusal for all five failure conditions.
 *   3. **Authorise the scope** — separate from authentication, so "who are you" and "may you do
 *      this" produce different statuses and cannot be conflated.
 *   4. **Consume the rate-limit window** — a WRITE, and therefore last among the checks. Doing it
 *      before step 2 would let an attacker turn each of a million guessed keys into a row.
 *   5. **Record the use** — `lastUsedAt`, once the request is actually going to be served.
 *
 * ## Nothing here is a `TenantContext`
 *
 * What comes out is an `ApiContext`: a business, a key id and a scope set. It does not type-check
 * where a staff service expects a person, which is a stronger guarantee than a review comment.
 */

/**
 * Headers on every `/api/v1` response, success and failure alike.
 *
 * `no-store` because a response selected by a secret header must never be held by an intermediary —
 * one tenant's page sitting in a shared cache is one tenant's page served to another. `Vary` is
 * belt-and-braces for an intermediary that ignores `no-store`.
 */
const API_HEADERS: Record<string, string> = {
  "cache-control": "no-store",
  vary: "X-API-Key",
};

/**
 * **No CORS header is ever added**, by this function or anywhere else.
 *
 * A key in a browser is a key published, so this is server-to-server. The shape of the API enforces
 * that before the missing header does: `X-API-Key` is not a CORS-safelisted request header, so a
 * cross-origin call must preflight with `OPTIONS`, no route exports an `OPTIONS` handler, and no
 * allow-origin header comes back — the browser refuses before the real request leaves.
 */
function apiJson(body: ApiSuccess<unknown> | ApiError, status: number, extra?: Record<string, string>): NextResponse {
  return NextResponse.json(body, { status, headers: extra ? { ...API_HEADERS, ...extra } : API_HEADERS });
}

/** A successful read. `page` is present on list responses and absent everywhere else. */
export function apiOk<T>(data: T, page?: ApiPage): NextResponse {
  return apiJson(apiSuccess(data, page), 200);
}

/** A refusal in the one error shape. The message is ours; nothing from a caller is echoed. */
export function apiFail(code: ApiErrorCodeName, message: string, status: number): NextResponse {
  return apiJson(apiError(code, message), status);
}

/**
 * Query-parameter names that look like credentials.
 *
 * v1 takes exactly two parameters, `limit` and `cursor`, so nothing legitimate is refused by this.
 * What it buys: a merchant who reaches for `?api_key=` is told at once, instead of getting a `401`
 * and retrying the URL form — each retry writing their key into a proxy log, a browser history and
 * an analytics row, none of which we can reach to erase.
 *
 * Checked on the parameter's NAME. The value is never read, never hashed, never looked up, and
 * never echoed back.
 */
const CREDENTIAL_PARAM =
  /^(x[-_]?)?(api[-_]?key|key|token|secret|access[-_]?token|auth|authorization|password|passwd|pwd|credential|bearer)$/i;

export type ApiGuardResult = { ok: true; ctx: ApiContext } | { ok: false; response: NextResponse };

/**
 * Authenticate, authorise and rate-limit one `/api/v1` request.
 *
 * Returns either a context or the exact response to send. A handler that forgets to check `ok`
 * cannot reach `ctx`, because the union does not carry one on the failure branch.
 */
export async function guardApiRequest(req: Request, scope: ApiScope): Promise<ApiGuardResult> {
  // 1. Before anything else, and before the key is read: a credential in the URL.
  const url = new URL(req.url);
  for (const name of url.searchParams.keys()) {
    if (CREDENTIAL_PARAM.test(name)) {
      return {
        ok: false,
        response: apiFail(
          ApiErrorCode.BAD_REQUEST,
          // The name, never the value.
          `Credentials must be sent in the X-API-Key header, not in the query string (remove "${name}")`,
          400,
        ),
      };
    }
  }

  // 2. The header, and nothing but the header. No cookie is read and GET has no body.
  const auth = await authenticateApiKey(req.headers.get("x-api-key"));
  if (!auth.ok) {
    // `apiUnauthorized` takes no argument. `auth.reason` exists for our tests and stops here.
    return { ok: false, response: apiJson(apiUnauthorized(), 401) };
  }
  const ctx = auth.ctx;

  // 3. Scope. A 403 says "authenticated, but not for this" — a different fact from a 401, and one
  //    the caller is entitled to, because it is about their own key.
  if (!hasScope(ctx, scope)) {
    return {
      ok: false,
      response: apiFail(ApiErrorCode.FORBIDDEN, "This key's scope does not cover this endpoint", 403),
    };
  }

  // 4. The first write of the request, and only now that the key is known real.
  const limit = await consumeApiRateLimit(ctx);
  if (!limit.allowed) {
    return {
      ok: false,
      response: apiJson(apiError(ApiErrorCode.RATE_LIMITED, "Too many requests; please wait a moment"), 429, {
        "retry-after": String(limit.retryAfterSeconds),
      }),
    };
  }

  /*
   * 5. Record the use — for a request that is actually going to be served.
   *
   * Not for a refused one: a rate-limited request was not served, and a key's last-used time that
   * moved on a refusal would tell an owner their key is working when it is being turned away.
   *
   * Awaited, because it is one indexed UPDATE and a floating promise in a serverless handler is a
   * promise that may not run. It swallows its own failures: a last-used time is an operator
   * convenience and losing one must never turn a successful read into an error.
   */
  await touchKey(ctx.apiKeyId);

  return { ok: true, ctx };
}

/**
 * Turn an unexpected throw into the one generic failure.
 *
 * Deliberately not `errorResponse` from `src/server/http.ts`: that one returns a domain error's own
 * `code` and `message`, which is right for a staff route talking to our own screens and wrong here.
 * A public caller gets a fixed sentence and a fixed code, because a domain message is written for
 * somebody who already has an account.
 */
export function apiInternal(e: unknown): NextResponse {
  console.error("[api/v1] unhandled error", e instanceof Error ? { name: e.name, message: e.message } : { type: typeof e });
  return apiFail(ApiErrorCode.INTERNAL, "Internal server error", 500);
}
