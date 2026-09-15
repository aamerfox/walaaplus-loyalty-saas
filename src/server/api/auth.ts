import { ApiKeyState, ApiScope } from "@prisma/client";
import { prisma } from "../db";
import { keyDigest } from "./keys";

/**
 * `X-API-Key` authentication.
 *
 * ## One answer for every failure
 *
 * Missing, malformed, unknown, revoked and expired all produce the **same** refusal. A caller must
 * not be able to learn that a value was once real, or that it belongs to a business that exists, or
 * that it was revoked rather than never issued — each of those is a fact about somebody else's
 * account, and a difference in any of status, code, message or timing is how it leaks.
 *
 * The owner learns the difference on their own screen, where they are authenticated as a person.
 * The API caller learns nothing.
 *
 * ## What this returns is deliberately not a `TenantContext`
 *
 * A `TenantContext` means "an authenticated person with an active membership": it carries a
 * `userId`, a `membershipId`, a role, a permission set and a location scope. A key has **none** of
 * those. Making those fields optional would weaken the type that every staff service relies on, and
 * every one of those services would silently begin accepting a caller who is not a person.
 *
 * So the key path gets its own, smaller type. Nothing that takes a `TenantContext` can be handed an
 * `ApiContext` — it does not type-check, which is a stronger guarantee than a review comment.
 */

/** What an authenticated key is allowed to be, and nothing more. */
export interface ApiContext {
  /** From the key row. **Never from caller input** — there is no parameter that could supply it. */
  readonly businessId: string;
  /** For the per-key rate-limit window and for correlating audit entries. Not secret. */
  readonly apiKeyId: string;
  readonly scopes: ReadonlySet<ApiScope>;
}

/**
 * Why a key was refused.
 *
 * **Internal only.** It exists so tests can assert that each condition is reached, and so a future
 * operator-facing metric can count them. It must never reach a caller: `apiUnauthorized` in
 * `contract.ts` is what a caller sees, and it takes no argument.
 */
export type ApiAuthFailure = "MISSING" | "MALFORMED" | "UNKNOWN" | "REVOKED" | "EXPIRED";

export type ApiAuthResult =
  | { ok: true; ctx: ApiContext }
  | { ok: false; reason: ApiAuthFailure };

/**
 * The shape a key must have before the database is asked anything.
 *
 * Cheap, and it is what stops an attacker turning arbitrary strings into indexed lookups: a
 * megabyte of text, a SQL fragment or a random UUID is refused here without a query. It is not a
 * security boundary on its own — the digest lookup is — but it bounds the work an unauthenticated
 * caller can cause.
 */
const KEY_SHAPE = /^wpk_[0-9a-f]{8}_[A-Za-z0-9_-]{43}$/;

/** Longer than any valid key. Refused before anything is hashed. */
const MAX_KEY_LENGTH = 128;

/**
 * Resolve a raw `X-API-Key` value to a context, or refuse.
 *
 * Reads only. **`lastUsedAt` is not written here** — see `touchKey`, which the route decides to
 * call, because a write on every authentication is a write an unauthenticated caller could not
 * cause but an authenticated one could, at whatever rate they like.
 */
export async function authenticateApiKey(rawHeader: string | null | undefined): Promise<ApiAuthResult> {
  if (rawHeader === null || rawHeader === undefined || rawHeader.length === 0) {
    return { ok: false, reason: "MISSING" };
  }
  // No trimming, no case folding. A key is an exact string; accepting a variant of it would mean
  // two different values authenticate the same row, and the digest would no longer identify it.
  if (rawHeader.length > MAX_KEY_LENGTH || !KEY_SHAPE.test(rawHeader)) {
    return { ok: false, reason: "MALFORMED" };
  }

  const row = await prisma.apiKey.findUnique({
    where: { keyDigest: keyDigest(rawHeader) },
    select: { id: true, businessId: true, scope: true, state: true, expiresAt: true },
  });
  if (!row) return { ok: false, reason: "UNKNOWN" };

  // Revocation first, so a key that is both revoked and expired reports the decision somebody took
  // rather than the clock running out. Neither reaches the caller; this is for our own tests.
  if (row.state === ApiKeyState.REVOKED) return { ok: false, reason: "REVOKED" };

  /*
   * `expiresAt` is the authority, not `state`.
   *
   * A key one second past its expiry is refused whether or not anything has flipped its state to
   * EXPIRED — that flip is lazy bookkeeping that frees a slot, and a security decision must not
   * wait on housekeeping. A key whose state is already EXPIRED lands here too.
   */
  if (row.state !== ApiKeyState.ACTIVE || row.expiresAt <= new Date()) {
    return { ok: false, reason: "EXPIRED" };
  }

  return {
    ok: true,
    ctx: { businessId: row.businessId, apiKeyId: row.id, scopes: new Set([row.scope]) },
  };
}

/** Does this context carry the scope a handler needs? */
export function hasScope(ctx: ApiContext, scope: ApiScope): boolean {
  return ctx.scopes.has(scope);
}

/**
 * Record that a key was used, at most once per call, monotonically.
 *
 * Separate from authentication so the write is a decision a route makes rather than a side effect
 * of checking a header. The database refuses a value that moves backwards.
 *
 * Failure is swallowed: a key's last-used time is an operator convenience, and losing one must
 * never turn a successful read into an error.
 */
export async function touchKey(apiKeyId: string, at: Date = new Date()): Promise<void> {
  await prisma.apiKey
    .updateMany({
      // Only forward, in the WHERE as well as in the trigger: this way a concurrent later write is
      // not overwritten by an earlier one, and the statement is a no-op rather than a refusal.
      where: { id: apiKeyId, OR: [{ lastUsedAt: null }, { lastUsedAt: { lt: at } }] },
      data: { lastUsedAt: at },
    })
    .catch(() => undefined);
}
