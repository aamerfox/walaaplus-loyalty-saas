/**
 * The public API's wire contract — **defined here, served nowhere yet.**
 *
 * Prompt 1 builds the key and deliberately does not build the surface. `/api/v1` does not exist;
 * these shapes are unit-tested and unused until Prompt 2 mounts a route on them.
 *
 * Writing the contract before the endpoint is the same discipline the capability matrices used: a
 * shape agreed while nothing depends on it is a shape that can still be changed.
 */

/** Bumped only for a breaking change, and carried in the path as well as the body. */
export const API_VERSION = "v1";

/** What a successful read looks like. One shape for every endpoint, so a client parses once. */
export interface ApiSuccess<T> {
  apiVersion: typeof API_VERSION;
  data: T;
  /** Present on list responses only. */
  page?: ApiPage;
}

export interface ApiPage {
  /**
   * Opaque and **signed**. Pass it back as `cursor` to continue; absent when there is nothing after
   * this page. A client must not construct, parse or alter one — an altered cursor is a `400`.
   */
  nextCursor: string | null;
  /** How many items this page holds. Never a total — see `cursorPage`. */
  count: number;
}

/**
 * Every failure, in one shape.
 *
 * `code` is what a client branches on; `message` is for a human reading a log. **Neither ever
 * carries the submitted key, a hostname, a path, a query, an internal id the caller did not already
 * have, or a database message.**
 */
export interface ApiError {
  apiVersion: typeof API_VERSION;
  error: { code: ApiErrorCodeName; message: string };
}

export const ApiErrorCode = {
  /** Missing, malformed, unknown, revoked or expired. **One code for all five** — see `auth.ts`. */
  UNAUTHORIZED: "UNAUTHORIZED",
  /** Authenticated, but the key's scope does not cover this. */
  FORBIDDEN: "FORBIDDEN",
  /** The request itself is wrong — a bad cursor, an out-of-range limit. */
  BAD_REQUEST: "BAD_REQUEST",
  NOT_FOUND: "NOT_FOUND",
  RATE_LIMITED: "RATE_LIMITED",
  INTERNAL: "INTERNAL",
} as const;
export type ApiErrorCodeName = (typeof ApiErrorCode)[keyof typeof ApiErrorCode];

export function apiSuccess<T>(data: T, page?: ApiPage): ApiSuccess<T> {
  return page ? { apiVersion: API_VERSION, data, page } : { apiVersion: API_VERSION, data };
}

export function apiError(code: ApiErrorCodeName, message: string): ApiError {
  return { apiVersion: API_VERSION, error: { code, message } };
}

/**
 * The single refusal every authentication failure produces.
 *
 * It takes **no argument**, which is the point: there is no way for a caller to be told which of
 * the five conditions applied, because there is no parameter through which a future edit could
 * pass one.
 */
export function apiUnauthorized(): ApiError {
  return apiError(ApiErrorCode.UNAUTHORIZED, "A valid X-API-Key is required");
}

// ── Cursor pagination ───────────────────────────────────────────────────────

/** The most a caller may ask for in one page, whatever they send. */
export const MAX_PAGE_SIZE = 100;
export const DEFAULT_PAGE_SIZE = 25;

/**
 * Why a cursor and not an offset.
 *
 * `OFFSET 10000` makes PostgreSQL walk ten thousand rows to discard them, so a caller can make the
 * database do arbitrary work with a small request. A keyset cursor is an indexed seek regardless of
 * depth. It is also correct under insertion: an offset page shifts when a row is added ahead of it,
 * so a client walking pages sees an item twice or not at all.
 *
 * The cursor is **opaque by contract** — clients must not construct one — and it is
 * **authenticated**: `src/server/api/cursor.ts` signs it with a derived, domain-separated key and
 * binds it to the business it was issued for, so a value this API did not mint is refused before
 * anything is parsed or read.
 *
 * This module holds only the SHAPE. Signing lives next door because it needs server-side key
 * material, and keeping the shape free of that is what lets the page assembler below stay pure.
 */
export interface Cursor {
  /** ISO-8601, from the sort column of the last item on the previous page. */
  at: string;
  /** Tie-break, so rows sharing a timestamp have a total order. */
  id: string;
}

/**
 * Turns a cursor into the string a client receives.
 *
 * Passed in rather than imported, so `cursorPage` has no key material and no environment to read,
 * and so a caller cannot build a page without having decided what the cursor is valid for.
 */
export type CursorSigner = (cursor: Cursor) => string;

/** Clamp a caller's `limit`. An absent or unusable value gets the default, never an error. */
export function pageSize(raw: string | number | null | undefined): number {
  const asNumber = typeof raw === "string" ? Number(raw) : raw;
  if (asNumber === null || asNumber === undefined || !Number.isFinite(asNumber)) return DEFAULT_PAGE_SIZE;
  const floored = Math.floor(asNumber);
  if (floored < 1) return DEFAULT_PAGE_SIZE;
  return Math.min(floored, MAX_PAGE_SIZE);
}

/**
 * Turn `size + 1` fetched rows into one page.
 *
 * Fetching one more than asked for is how the next cursor is decided without a second query and
 * without a `COUNT`. **No total is returned**: a total over a growing table is a second scan and is
 * wrong by the time it is read.
 */
export function cursorPage<T>(
  rows: T[],
  size: number,
  keyOf: (row: T) => Cursor,
  sign: CursorSigner,
): { items: T[]; page: ApiPage } {
  const hasMore = rows.length > size;
  const items = hasMore ? rows.slice(0, size) : rows;
  const last = items.at(-1);
  return {
    items,
    page: { nextCursor: hasMore && last ? sign(keyOf(last)) : null, count: items.length },
  };
}
