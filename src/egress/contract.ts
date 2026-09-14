import { assertSafeWebhookUrl, UnsafeWebhookAddressError, WEBHOOK_PORT } from "../server/integrations/webhooks/address";

/**
 * The dispatch contract — the entire vocabulary this gateway understands.
 *
 * **This is what stops the service being an open proxy.** A proxy takes a request and a
 * destination and forwards whatever it is given. This takes one JSON object with three fixed keys,
 * refuses any fourth, refuses any header name outside a list of five, refuses any method but POST,
 * any path but `/dispatch`, any scheme but `https:` and any port but 443 — and then builds the
 * outbound request itself from the parts it accepted. Nothing is forwarded. Nothing passes through.
 *
 * Everything here is a pure function over a string, so `tests/unit/webhook-gateway-contract.test.ts`
 * can drive every refusal without a socket.
 */

/** The only path. A request for anything else is a 404, including `/`. */
export const DISPATCH_PATH = "/dispatch";

/** The whole request from the worker: envelope, URL and five headers, with room and no more. */
export const MAX_REQUEST_BYTES = 8192;

/** The envelope itself. Mirrors `MAX_BODY_BYTES` in `envelope.ts`; a test asserts they agree. */
export const MAX_DISPATCH_BODY_BYTES = 4096;

/** A destination URL longer than this is not a URL anyone typed. Mirrors `MAX_URL_LENGTH`. */
export const MAX_DISPATCH_URL_BYTES = 2000;

/** One header value. Generous for a signature, far short of anything worth smuggling. */
export const MAX_HEADER_VALUE_BYTES = 256;

/**
 * HTTPS, and the assigned port. A webhook on 8443 is a decision this product does not offer.
 *
 * Re-exported from `address.ts` rather than written again, so the owner's save-time refusal and
 * this dispatch-time refusal cannot drift to different numbers.
 */
export const REQUIRED_PORT = WEBHOOK_PORT;

/**
 * Which destination ports a dispatch may use.
 *
 * **The default IS the rule** — a list of exactly one, 443. It is a parameter for one reason, and
 * it is the same reason `AddressPolicy` in `address.ts` is one: the local HTTPS receiver the
 * delivery tests talk to is on whatever ephemeral port the OS handed out, and a test cannot bind
 * 443. Rather than soften the rule for everyone or point the tests at something outside this
 * machine, the ports are a parameter whose default is `[443]` and which no production caller sets.
 *
 * A LIST rather than one number because a test also needs a port with nothing listening on it, to
 * prove a refused connection is classified as the network's problem and retried. Widening this
 * changes which ports may be dialled and nothing else: it cannot admit a scheme, an IP literal, a
 * private address or a header.
 *
 * `tests/unit/webhook-egress-boundary.test.ts` asserts the entry point never passes one.
 */
export interface ParseOptions {
  allowedPorts?: readonly number[];
}

/**
 * The five header names a dispatch may carry, and the complete set it MUST carry.
 *
 * Written here rather than imported from `envelope.ts` so the gateway's bundle stays free of
 * anything that touches the database layer; `tests/unit/webhook-gateway-contract.test.ts` asserts
 * this list is exactly `HEADER`'s values, so the two cannot drift.
 *
 * `content-type`, `content-length` and `user-agent` are **not** here. The gateway sets those itself
 * and a caller that tries to set one is refused — a caller-controlled `content-length` is request
 * smuggling, and a caller-controlled `host` is how a "validated" URL ends up at a different server.
 */
export const ALLOWED_DISPATCH_HEADERS = [
  "x-walaaplus-event-id",
  "x-walaaplus-delivery-id",
  "x-walaaplus-attempt",
  "x-walaaplus-timestamp",
  "x-walaaplus-signature",
] as const;

export type AllowedDispatchHeader = (typeof ALLOWED_DISPATCH_HEADERS)[number];

/** Why a request was refused. A short fixed code; never a message built from the request. */
export type GatewayRefusalCode =
  | "BAD_METHOD"
  | "BAD_PATH"
  | "BAD_CONTRACT"
  | "BAD_AUTH"
  | "SECRET_UNAVAILABLE"
  | "TOO_LARGE"
  | "BUSY";

export class DispatchContractError extends Error {
  constructor(
    readonly code: GatewayRefusalCode,
    /** For a test and for a developer reading a stack. **Never sent, never logged.** */
    readonly reason: string,
  ) {
    super(`dispatch refused: ${code}`);
    this.name = "DispatchContractError";
  }
}

/** What a valid dispatch resolves to. The URL is kept split so the sender cannot re-parse it. */
export interface DispatchRequest {
  host: string;
  port: number;
  pathWithQuery: string;
  body: string;
  headers: Record<AllowedDispatchHeader, string>;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Any C0 control byte, or DEL.
 *
 * Written as a character-code scan rather than a regular expression on purpose. A regular
 * expression spelling this range needs backslash-u escapes, and that is the kind of source text
 * which has already been mangled once in this repository into LITERAL control bytes inside a
 * tracked TypeScript file, which made git treat it as binary. There is no escape here to mangle,
 * and `tests/unit/source-text-encoding.test.ts` fails the gate if one reappears.
 */
function hasControlCharacter(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * Parse and validate one dispatch request body.
 *
 * Throws `DispatchContractError` for everything it will not do. The reason string exists for tests
 * and stack traces; what leaves the process is the code alone.
 */
export function parseDispatch(raw: string, options: ParseOptions = {}): DispatchRequest {
  const allowedPorts = options.allowedPorts ?? [REQUIRED_PORT];
  if (Buffer.byteLength(raw, "utf8") > MAX_REQUEST_BYTES) {
    throw new DispatchContractError("TOO_LARGE", "the request body is over the cap");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new DispatchContractError("BAD_CONTRACT", "the request body is not JSON");
  }
  if (!isPlainObject(parsed)) throw new DispatchContractError("BAD_CONTRACT", "the request body is not an object");

  // Exactly three keys. An extra one is a caller speaking a dialect this gateway does not have.
  const keys = Object.keys(parsed).sort();
  if (keys.length !== 3 || keys[0] !== "body" || keys[1] !== "headers" || keys[2] !== "url") {
    throw new DispatchContractError("BAD_CONTRACT", "the request must have exactly url, body and headers");
  }

  const { url, body, headers } = parsed as { url: unknown; body: unknown; headers: unknown };

  if (typeof url !== "string" || url.length === 0) {
    throw new DispatchContractError("BAD_CONTRACT", "url must be a non-empty string");
  }
  if (Buffer.byteLength(url, "utf8") > MAX_DISPATCH_URL_BYTES) {
    throw new DispatchContractError("BAD_CONTRACT", "url is too long");
  }

  if (typeof body !== "string") throw new DispatchContractError("BAD_CONTRACT", "body must be a string");
  if (Buffer.byteLength(body, "utf8") > MAX_DISPATCH_BODY_BYTES) {
    throw new DispatchContractError("BAD_CONTRACT", "body is over the envelope cap");
  }

  if (!isPlainObject(headers)) throw new DispatchContractError("BAD_CONTRACT", "headers must be an object");
  const given = Object.keys(headers).sort();
  const expected = [...ALLOWED_DISPATCH_HEADERS].sort();
  if (given.length !== expected.length || given.some((name, i) => name !== expected[i])) {
    throw new DispatchContractError("BAD_CONTRACT", "headers must be exactly the allow-listed names");
  }
  const checked: Record<string, string> = {};
  for (const name of expected) {
    const value = headers[name];
    if (typeof value !== "string" || value.length === 0) {
      throw new DispatchContractError("BAD_CONTRACT", `header ${name} must be a non-empty string`);
    }
    if (Buffer.byteLength(value, "utf8") > MAX_HEADER_VALUE_BYTES) {
      throw new DispatchContractError("BAD_CONTRACT", `header ${name} is too long`);
    }
    // A CR, an LF or any other control byte in a header value is response splitting, not a typo.
    if (hasControlCharacter(value)) {
      throw new DispatchContractError("BAD_CONTRACT", `header ${name} contains a control character`);
    }
    checked[name] = value;
  }

  /*
   * The SSRF rules, run here for the second time in this delivery's life. The worker ran them
   * before it called; this is the process that actually has a route, so it runs them again on its
   * own copy of the string rather than trusting a caller it cannot see.
   */
  let safe;
  try {
    safe = assertSafeWebhookUrl(url);
  } catch (err) {
    if (err instanceof UnsafeWebhookAddressError) {
      throw new DispatchContractError("BAD_CONTRACT", `unsafe address: ${err.message}`);
    }
    throw err;
  }
  if (!allowedPorts.includes(safe.port)) {
    // `assertSafeWebhookUrl` allows any port because a URL may legitimately carry one. Egress does
    // not: 443 is the whole capability the owner approved, and 22 or 25 through a "webhook" is not.
    throw new DispatchContractError("BAD_CONTRACT", "only port 443 is dispatched");
  }

  return {
    host: safe.host,
    port: safe.port,
    pathWithQuery: safe.pathWithQuery,
    body,
    headers: checked as Record<AllowedDispatchHeader, string>,
  };
}
