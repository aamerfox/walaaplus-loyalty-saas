import { consumeRateLimit, RateLimitScope, type RateLimitDecision, type RateLimitRule } from "../security/rate-limit";
import type { ApiContext } from "./auth";

/**
 * Per-key rate limiting for the public API.
 *
 * ## The one rule that makes this different from the auth limiter
 *
 * **A window is consumed only after the key is known valid.**
 *
 * The auth limiter keys its windows on a submitted email address, which is fine: an address is a
 * value a real user typed, and the table's growth is bounded by how many distinct addresses people
 * try. An API key is not like that. It is a 43-character random string, and an attacker sending a
 * million different ones would create a million counter rows if the window were consumed before the
 * key was checked — turning an unauthenticated request into a write, and the rate-limit table into
 * an unbounded dump of attacker-chosen noise.
 *
 * So the order is fixed and it is the opposite way round from the sign-in path:
 *
 *   1. `authenticateApiKey` — a read, and a refusal for anything unknown;
 *   2. only then `consumeApiRateLimit` — a write, keyed on a row that exists.
 *
 * An unknown key therefore costs one indexed lookup and writes nothing at all.
 *
 * ## Keyed on the key's ID, never on its value
 *
 * The window is keyed on `apiKeyId`, a uuid this product generated. Not the raw key, which never
 * leaves the request; not a digest of it either, because the id already identifies the row and a
 * second derivation of the secret is a second thing to keep out of a table.
 */

/** Requests per key per window. The reference product's figure is ten a second. */
export const API_RATE_LIMIT_MAX = 600;

/** One minute, so the figure above reads as ten a second averaged over a minute. */
export const API_RATE_LIMIT_WINDOW_SECONDS = 60;

export function apiKeyRules(): RateLimitRule[] {
  return [{ scope: RateLimitScope.API_KEY, max: API_RATE_LIMIT_MAX, windowSeconds: API_RATE_LIMIT_WINDOW_SECONDS }];
}

/**
 * Count one API request against its key's window.
 *
 * Takes an `ApiContext` rather than a raw key **by type**, so it cannot be called before
 * authentication has happened — the only way to hold one of these is to have been given it by
 * `authenticateApiKey`.
 */
export function consumeApiRateLimit(ctx: ApiContext): Promise<RateLimitDecision> {
  return consumeRateLimit(apiKeyRules(), { [RateLimitScope.API_KEY]: ctx.apiKeyId });
}
