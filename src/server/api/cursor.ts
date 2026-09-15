import { createHmac, timingSafeEqual } from "node:crypto";
import { env } from "../env";
import type { Cursor } from "./contract";

/**
 * Pagination cursors that the server can prove it minted.
 *
 * ## What was wrong with the first version
 *
 * Prompt 2 shipped cursors as bare base64url JSON and argued they did not need signing, because
 * the tenant filter comes from the key rather than from the cursor — so tampering could only move a
 * caller's window within their own events.
 *
 * That argument is true and it is not the point. "Tampering is harmless" is a different property
 * from "tampering is detected", and the contract promised the second. A cursor is a value this API
 * hands out and later accepts back; accepting one it cannot prove it wrote means the only thing
 * standing between a forged cursor and a query is a filter somewhere else. Defence that rests on a
 * single unrelated line is defence that survives exactly until somebody edits that line.
 *
 * So a cursor is now authenticated: `v1.<payload>.<mac>`, and a value failing the MAC never reaches
 * the parser, let alone the database.
 *
 * ## Where the key comes from, and why not the integration key
 *
 * The review offered two options: derive from the integration encryption material, or use an
 * equally safe existing server-only primitive. This uses the second, and the reason is in
 * `src/server/env.ts`:
 *
 * **`INTEGRATION_ENCRYPTION_KEY` is deliberately optional.** A deployment that sends no webhooks
 * must start normally, and that is written down as a rule rather than an accident. Signing cursors
 * with it would mean `/api/v1` served page one and refused every cursor on any deployment that had
 * not configured webhooks — one feature failing because an unrelated one is unconfigured, which is
 * the precise coupling that rule exists to prevent. A "use it if present, otherwise fall back"
 * arrangement is worse again: the signing key would change the day webhooks were configured,
 * silently invalidating every outstanding cursor, and the security property would depend on
 * deployment configuration rather than on code.
 *
 * `NEXTAUTH_SECRET` is **required**, validated at boot, at least 32 characters, and checked against
 * the two burned values from `docs/PHASE-0-HYGIENE.md`. It is always there, on every deployment.
 *
 * **It is never used as the MAC key itself.** A purpose-specific key is derived from it, exactly as
 * `src/server/security/rate-limit.ts` derives its pepper — the same idiom, deliberately, so there is
 * one way this codebase turns a root secret into a scoped one. Two derivations from one root with
 * different labels cannot produce the same key, so a cursor MAC is no use against a rate-limit hash
 * and neither is any use for signing a session.
 */

/** The wire format. Bumped only if the payload or the MAC construction changes. */
const FORMAT = "v1";

/** Longer than any cursor this issues (~120 characters). Refused before anything is hashed. */
const MAX_CURSOR_LENGTH = 512;

/** Derivation label. Distinct from every other label in this codebase — that is its whole job. */
const DERIVATION_LABEL = "walaaplus:api:v1:cursor";

/**
 * Domain separator inside the signed message.
 *
 * Belt and braces alongside the derivation label: even if some future caller reached this key, a
 * MAC over an events cursor could not be replayed as a MAC over anything else that ever gets signed
 * with it, because the first field of the message says what it is.
 */
const MESSAGE_DOMAIN = "walaaplus:api:v1:cursor:events";

let cachedKey: Buffer | undefined;

function cursorKey(): Buffer {
  // Derived, not reused verbatim: the session secret never appears as the HMAC key itself.
  if (!cachedKey) cachedKey = createHmac("sha256", env().NEXTAUTH_SECRET).update(DERIVATION_LABEL).digest();
  return cachedKey;
}

/**
 * What a cursor is valid *for*.
 *
 * ## Bound to the business, and deliberately not to the individual key
 *
 * The review asked for this to be argued rather than assumed, so:
 *
 * **Binding to the business is necessary.** It is the tenant boundary, and it makes a cursor minted
 * for one merchant fail verification outright for another rather than merely being filtered out by
 * a `WHERE` clause somewhere downstream. The check and the isolation then agree, instead of one
 * relying on the other.
 *
 * **Binding to the API key as well would be wrong here**, for three reasons:
 *
 *  1. *It would refuse requests that are entitled to succeed.* A cursor names a position in a feed
 *     the business owns. Every active key of that business is authorised to read exactly the same
 *     rows, so a key-bound cursor would reject a request that is allowed in every other respect.
 *  2. *It would punish the one action we tell people to take.* `docs/PUBLIC-API-V1.md` tells a
 *     consumer to replace a key they suspect. Under key binding, replacing one mid-traversal would
 *     invalidate the cursor in hand and force a restart from the top — re-ingesting the whole feed
 *     as the price of rotating a credential.
 *  3. *It would buy nothing.* A cursor is not a capability: it opens nothing without a valid key.
 *     Anyone holding a key for this business can mint fresh cursors at will, so refusing an old one
 *     from a sibling key stops no attack that the key itself does not already permit.
 *
 * Revocation is unaffected either way: a revoked key is refused at authentication, long before its
 * cursor is looked at.
 */
export interface CursorBinding {
  readonly businessId: string;
}

/**
 * Unambiguous concatenation.
 *
 * Every field is length-prefixed, so no choice of field values can produce the same signed message
 * as a different choice — the classic failure where `a="x|y", b="z"` and `a="x", b="y|z"` join to
 * one string. Today's fields are a uuid and base64url and could not collide anyway; length-prefixing
 * means the next field added here cannot reintroduce the problem.
 */
function canonical(fields: readonly string[]): string {
  return fields.map((f) => `${Buffer.byteLength(f, "utf8")}:${f}`).join("");
}

function mac(payload: string, binding: CursorBinding): Buffer {
  return createHmac("sha256", cursorKey())
    .update(canonical([MESSAGE_DOMAIN, FORMAT, binding.businessId, payload]), "utf8")
    .digest();
}

/** Mint a cursor for this page's last row, valid only for this business. */
export function signCursor(cursor: Cursor, binding: CursorBinding): string {
  const payload = Buffer.from(JSON.stringify({ at: cursor.at, id: cursor.id }), "utf8").toString("base64url");
  return `${FORMAT}.${payload}.${mac(payload, binding).toString("base64url")}`;
}

/** The payload rules, applied only after the MAC has proved we wrote it. */
function parsePayload(payload: string): Cursor | null {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const candidate = parsed as Record<string, unknown>;
    if (typeof candidate.at !== "string" || typeof candidate.id !== "string") return null;
    if (Number.isNaN(Date.parse(candidate.at))) return null;
    if (candidate.id.length === 0 || candidate.id.length > 64) return null;
    return { at: candidate.at, id: candidate.id };
  } catch {
    return null;
  }
}

/**
 * Return the cursor this API issued for this business, or null.
 *
 * Null for every one of: a tampered `at`, a tampered `id`, a tampered or truncated signature, a
 * cursor minted for another business, an **unsigned cursor of the shape this API used to issue**, a
 * value in any other shape at all, and anything over the length bound. The caller turns null into
 * the one fixed `400`; **nothing here reads a row**, and the submitted value is never echoed.
 *
 * Never throws.
 */
export function verifyCursor(raw: string | null | undefined, binding: CursorBinding): Cursor | null {
  if (!raw || raw.length > MAX_CURSOR_LENGTH) return null;

  const parts = raw.split(".");
  // Exactly three, so a legacy unsigned cursor — one base64url segment — stops here.
  if (parts.length !== 3) return null;
  const [format, payload, signature] = parts;
  if (format !== FORMAT || payload.length === 0 || signature.length === 0) return null;

  /*
   * The MAC first, and the payload only afterwards.
   *
   * Parsing before verifying would mean attacker-chosen bytes reaching `JSON.parse` and a date
   * parser on every request, which is a larger surface than a constant-time comparison and buys
   * nothing: a payload we did not sign is one we have no interest in understanding.
   */
  const presented = Buffer.from(signature, "base64url");
  const expected = mac(payload, binding);
  if (presented.length !== expected.length) return null;
  if (!timingSafeEqual(presented, expected)) return null;

  return parsePayload(payload);
}
