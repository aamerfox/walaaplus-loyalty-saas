import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Authentication for the one internal hop: worker → egress gateway.
 *
 * ## Why this is a second secret and not the encryption key
 *
 * `INTEGRATION_ENCRYPTION_KEY` protects destination URLs and signing secrets **at rest**. This one
 * authenticates a **caller** on a network hop. Using one value for both would mean that recovering
 * it from either place — a dump of one container's environment, a crash file, a mis-scoped compose
 * edit — hands over the other capability as well. They are separate values, provisioned separately,
 * and the gateway never receives the encryption key at all: it decrypts nothing, so it has no use
 * for one.
 *
 * ## Why this module re-reads the environment itself
 *
 * It is imported by both sides, and one of those sides is a process with no Prisma client, no
 * `src/server/env.ts` and no database. Reading `process.env` here, at the moment the value is
 * needed, keeps the gateway's dependency graph to `node:crypto` and nothing else — and gives the
 * same fail-closed shape the encryption key already has: absent or malformed is a deployment
 * condition that stops **this** path and no other.
 *
 * ## What is signed
 *
 *   HMAC-SHA-256 over `"<timestamp>.<raw request body>"`
 *
 * The raw bytes, before parsing. Signing the parsed object would mean signing one serialisation and
 * verifying another; signing the bytes means the thing verified is the thing that arrived.
 */

/** Bumped only if the scheme changes. Carried in the header so a future version can coexist. */
export const GATEWAY_SIGNATURE_VERSION = "v1";

/** Header names for the internal hop. Distinct prefix from the destination-facing headers. */
export const GATEWAY_HEADER = {
  timestamp: "x-walaaplus-gw-timestamp",
  signature: "x-walaaplus-gw-signature",
} as const;

/**
 * How far out of step the two clocks may be.
 *
 * Both containers are on the same host, so this is generous. It exists to bound replay: a captured
 * dispatch cannot be re-sent tomorrow. It cannot stop a replay inside the window — see the note on
 * `verifyGatewayRequest`.
 */
export const GATEWAY_TIMESTAMP_TOLERANCE_SECONDS = 300;

/** 32 bytes, like every other secret here. Not negotiable: a short HMAC key is a weak one. */
export const GATEWAY_SECRET_BYTES = 32;

/** Absent, or present and unusable. The variable is named; no part of a value ever appears. */
export class GatewaySecretUnavailableError extends Error {
  constructor(problem: string) {
    super(`WEBHOOK_GATEWAY_SECRET ${problem}`);
    this.name = "GatewaySecretUnavailableError";
  }
}

/**
 * Read the shared secret.
 *
 * Accepts 64 hex characters or base64, and insists on exactly 32 decoded bytes — a 31-byte value is
 * a typo, not a weaker key, and accepting one means a deployment that looks configured and is not.
 */
export function loadGatewaySecret(source: NodeJS.ProcessEnv = process.env): Buffer {
  const raw = source.WEBHOOK_GATEWAY_SECRET;
  if (raw === undefined || raw.trim().length === 0) throw new GatewaySecretUnavailableError("is not set");
  const value = raw.trim();

  let secret: Buffer;
  if (/^[0-9a-fA-F]{64}$/.test(value)) {
    secret = Buffer.from(value, "hex");
  } else if (/^[A-Za-z0-9+/_-]+={0,2}$/.test(value)) {
    secret = Buffer.from(value, "base64");
  } else {
    throw new GatewaySecretUnavailableError("must be 64 hex characters or base64");
  }

  if (secret.length !== GATEWAY_SECRET_BYTES) {
    throw new GatewaySecretUnavailableError(`must decode to exactly ${GATEWAY_SECRET_BYTES} bytes`);
  }
  return secret;
}

/** Is the secret usable? For a startup line that must not throw. */
export function gatewaySecretAvailable(source: NodeJS.ProcessEnv = process.env): boolean {
  try {
    loadGatewaySecret(source);
    return true;
  } catch {
    return false;
  }
}

/** `v1=<hex>` over `"<timestamp>.<body>"`. */
export function signGatewayRequest(secret: Buffer, timestamp: string, body: string): string {
  const mac = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
  return `${GATEWAY_SIGNATURE_VERSION}=${mac}`;
}

/** Constant-time, and length-safe: `timingSafeEqual` throws on a length mismatch. */
function signaturesMatch(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export interface VerifyInput {
  timestamp: string | undefined;
  signature: string | undefined;
  body: string;
  /** Seconds since the epoch. Injected so a test can drive the clock without waiting. */
  nowSeconds?: number;
  source?: NodeJS.ProcessEnv;
}

/**
 * Verify one dispatch request.
 *
 * Returns `true` or `false`; throws only `GatewaySecretUnavailableError`, because "this deployment
 * is not configured" and "this caller is not authentic" are different answers and the gateway
 * reports them as different codes — `SECRET_UNAVAILABLE` against `BAD_AUTH`. Both refuse.
 *
 * **What this does not claim.** The timestamp window bounds replay to five minutes; it does not
 * eliminate it. A party that can read the internal network can re-send a captured dispatch within
 * the window and cause one duplicate delivery. Webhook delivery is already at-least-once and every
 * envelope carries a stable `x-walaaplus-event-id` for the receiver to de-duplicate on, so the
 * consequence is a duplicate the protocol already permits — not a forged one. Recorded as a
 * residual risk in `docs/WEBHOOK-EGRESS-TOPOLOGY.md` §6.2 rather than papered over with a nonce
 * store the gateway has nowhere to keep.
 */
export function verifyGatewayRequest(input: VerifyInput): boolean {
  const secret = loadGatewaySecret(input.source ?? process.env);

  if (typeof input.timestamp !== "string" || !/^[0-9]{1,12}$/.test(input.timestamp)) return false;
  if (typeof input.signature !== "string" || input.signature.length === 0) return false;

  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  const drift = Math.abs(now - Number(input.timestamp));
  if (!Number.isFinite(drift) || drift > GATEWAY_TIMESTAMP_TOLERANCE_SECONDS) return false;

  return signaturesMatch(input.signature, signGatewayRequest(secret, input.timestamp, input.body));
}
