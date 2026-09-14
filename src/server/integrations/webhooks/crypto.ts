import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Authenticated encryption for the two values a webhook destination holds worth stealing: the
 * **URL** — which may carry a path or query token the receiver treats as authentication — and the
 * **signing secret**.
 *
 * ## AES-256-GCM, and why authenticated
 *
 * GCM authenticates as well as encrypts. A tampered ciphertext fails to decrypt rather than
 * decrypting to something else, which matters here more than usual: a decryption that silently
 * returned a different URL would be a request sent somewhere nobody chose.
 *
 * ## Fail closed, with no exception
 *
 * There is no plaintext mode, no "store it raw in development", and no path by which a missing key
 * produces a usable destination. `INTEGRATION_ENCRYPTION_KEY` is absent or malformed →
 * `EncryptionUnavailableError`, every time.
 *
 * **And nothing else breaks.** This module is imported only by the webhook code. Enrolment, stamps,
 * points, redemptions, referrals, consent, campaigns, the scanner, B7 and the worker's `/health`
 * endpoint do not reach it, so a deployment without the key runs exactly as it did before the
 * feature existed — it simply cannot configure or deliver a webhook.
 *
 * ## Why the key is read here and not validated at startup
 *
 * `src/server/env.ts` accepts it as an optional string and checks nothing about its contents, on
 * purpose. Validating the format at boot would mean a malformed key stops the whole application —
 * including the till — over a feature nobody may be using. The authority is here, at the moment the
 * value is needed.
 *
 * ## The envelope format
 *
 *   v<keyVersion>.<nonce>.<tag>.<ciphertext>      all base64url
 *
 * Self-describing, so a row carries what it takes to read it. The algorithm and the key version are
 * ALSO stored in their own columns, because a `WHERE cipherKeyVersion = 1` over a blob is not a
 * query anyone should have to write when the rotation tool arrives.
 *
 * See `docs/INTEGRATIONS-CAPABILITY-MATRIX.md` §7a and §8a.
 */

/** The only algorithm. The `WebhookCipher` enum says the same thing to the database. */
export const CIPHER_ALGORITHM = "aes-256-gcm" as const;

/** AES-256. Not negotiable, and not derived from whatever length the key happens to be. */
const KEY_BYTES = 32;
/** 96 bits, the size GCM is defined for. Fresh per value, never reused, never derived. */
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

/**
 * The key version this process writes.
 *
 * Rotation writes 2 beside version 1 rows and leaves them readable. **The re-encryption tool does
 * not exist yet** — the schema and this format are ready for it, the code is not, and saying so is
 * better than implying a rotation is a supported operation today (decision D29).
 */
export const CURRENT_KEY_VERSION = 1;

/** Raised whenever the key is unusable. Callers turn it into a refusal, never into plaintext. */
export class EncryptionUnavailableError extends Error {
  constructor(reason: string) {
    // Names the VARIABLE and the shape. Never the value, never part of the value, never its length.
    super(`INTEGRATION_ENCRYPTION_KEY ${reason}. Webhook configuration and delivery are unavailable.`);
    this.name = "EncryptionUnavailableError";
  }
}

/** Raised when a stored value cannot be read back. A tampered row, or the wrong key. */
export class DecryptionFailedError extends Error {
  constructor() {
    super("A stored webhook value could not be decrypted.");
    this.name = "DecryptionFailedError";
  }
}

/**
 * Decode the configured key.
 *
 * Accepts 64 hex characters or base64 / base64url, and insists the result is exactly 32 bytes. A
 * 31-byte key is a typo, not a weaker key, and accepting one would mean a deployment that looks
 * configured and is not.
 *
 * Reads `process.env` directly rather than the cached `env()` so a test can set and clear it
 * without reaching into a module cache — and so that a key rotated in place is picked up without a
 * restart.
 */
function loadKey(source: NodeJS.ProcessEnv = process.env): Buffer {
  const raw = source.INTEGRATION_ENCRYPTION_KEY;
  if (raw === undefined || raw.trim().length === 0) {
    throw new EncryptionUnavailableError("is not set");
  }
  const value = raw.trim();

  let key: Buffer;
  if (/^[0-9a-fA-F]{64}$/.test(value)) {
    key = Buffer.from(value, "hex");
  } else if (/^[A-Za-z0-9+/_-]+={0,2}$/.test(value)) {
    key = Buffer.from(value, "base64");
  } else {
    throw new EncryptionUnavailableError("must be 64 hex characters or base64");
  }

  if (key.length !== KEY_BYTES) {
    throw new EncryptionUnavailableError(`must decode to exactly ${KEY_BYTES} bytes`);
  }
  return key;
}

/** Is the key usable? For a screen that needs to say "not configured" without throwing. */
export function encryptionAvailable(source: NodeJS.ProcessEnv = process.env): boolean {
  try {
    loadKey(source);
    return true;
  } catch {
    return false;
  }
}

function b64(buf: Buffer): string {
  return buf.toString("base64url");
}

/**
 * Encrypt one value.
 *
 * The returned string is everything needed to read it back except the key. Note what is NOT in it:
 * no plaintext length hint beyond what a ciphertext length already gives, no key material, and no
 * identifier for the row it belongs to.
 */
export function encryptSecret(plaintext: string, source: NodeJS.ProcessEnv = process.env): string {
  const key = loadKey(source);
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv(CIPHER_ALGORITHM, key, nonce);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v${CURRENT_KEY_VERSION}.${b64(nonce)}.${b64(tag)}.${b64(ciphertext)}`;
}

/**
 * Read one value back.
 *
 * Throws `DecryptionFailedError` for a tampered nonce, a tampered tag, a tampered ciphertext, a
 * malformed envelope, or the wrong key — deliberately the SAME error for all of them, because a
 * caller that could tell "wrong key" from "tampered" has an oracle.
 */
export function decryptSecret(envelope: string, source: NodeJS.ProcessEnv = process.env): string {
  const key = loadKey(source);

  const parts = envelope.split(".");
  if (parts.length !== 4) throw new DecryptionFailedError();
  const [version, nonceB64, tagB64, ciphertextB64] = parts;
  if (!/^v[0-9]+$/.test(version)) throw new DecryptionFailedError();

  const nonce = Buffer.from(nonceB64, "base64url");
  const tag = Buffer.from(tagB64, "base64url");
  const ciphertext = Buffer.from(ciphertextB64, "base64url");
  if (nonce.length !== NONCE_BYTES || tag.length !== TAG_BYTES) throw new DecryptionFailedError();

  try {
    const decipher = createDecipheriv(CIPHER_ALGORITHM, key, nonce);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch {
    // `final()` throws on a failed tag check. Nothing about which part failed escapes.
    throw new DecryptionFailedError();
  }
}

/** The key version an envelope was written with, for the rotation tool that does not exist yet. */
export function envelopeKeyVersion(envelope: string): number | null {
  const m = /^v([0-9]+)\./.exec(envelope);
  return m ? Number(m[1]) : null;
}

// ── The signing secret, and the signature over a delivery ────────────────────

/** 32 bytes. The same width as every other secret in this codebase. */
export const SIGNING_SECRET_BYTES = 32;

/** A fresh signing secret, shown to the owner once and then only ever stored encrypted. */
export function newSigningSecret(): string {
  return randomBytes(SIGNING_SECRET_BYTES).toString("base64url");
}

/** The signature scheme's version, sent in the header so a second one can be added unambiguously. */
export const SIGNATURE_VERSION = "v1";

/**
 * `HMAC-SHA-256` over `"{timestamp}.{body}"`, hex.
 *
 * The timestamp is inside the signed string rather than only in a header, so a captured body cannot
 * be replayed later under a fresh timestamp — the signature would not cover the new one. A receiver
 * that checks the signature and rejects an old timestamp cannot be replayed at all.
 */
export function signPayload(secret: string, timestamp: string, body: string): string {
  return createHmac("sha256", secret).update(`${timestamp}.${body}`, "utf8").digest("hex");
}

/** Constant-time comparison, for a receiver-side helper and for the tests that check one. */
export function signaturesMatch(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}
