import { Agent, request as httpsRequest } from "node:https";
import {
  makeGuardedLookup,
  UnsafeWebhookAddressError,
  type AddressPolicy,
  type LookupFn,
} from "../server/integrations/webhooks/address";
import type { DispatchRequest } from "./contract";
import type { DispatchResult } from "./outcome";

/**
 * **The only place in this product that opens a socket to an address someone else chose.**
 *
 * It used to live in `src/server/integrations/webhooks/transport.ts` and run inside the worker.
 * It now runs in the egress gateway, a process that holds no database credential, no encryption
 * key, no signing secret and no session secret — so a flaw reached through this code reaches a
 * process with nothing in it. The worker keeps the secrets and, on every compose variant, keeps no
 * route to the Internet.
 *
 * ## What this refuses to do
 *
 * - **Follow a redirect.** A 200 from a validated host that redirects to `169.254.169.254` is the
 *   classic bypass, so a 3xx is an outcome, not a hop. Node's `https.request` does not follow
 *   redirects on its own; this never asks it to.
 * - **Resolve a hostname and then connect to it.** The agent's `lookup` is `makeGuardedLookup`,
 *   which returns only an address that has just passed the policy — the address checked and the
 *   address connected to are the same one, with no window between.
 * - **Read an unbounded response.** Read to a hard cap, then the socket is destroyed.
 * - **Keep the response.** The body is never logged, stored, returned or classified. Only the
 *   status code leaves this function.
 * - **Say anything about the address.** The resolved IP is used to connect and then forgotten: it
 *   is not returned, not logged and not classified.
 * - **Write to stdout.** Nothing here logs at all — `tests/unit/webhook-egress-boundary.test.ts`
 *   asserts it.
 */

/** Connection + response, end to end. A receiver slower than this is a retry, not a wait. */
export const REQUEST_TIMEOUT_MS = 5_000;

/** Read at most this much of the response before destroying the socket. Nothing is kept anyway. */
export const MAX_RESPONSE_BYTES = 2048;

/** What the gateway identifies itself as. Fixed; a caller cannot set it. */
export const USER_AGENT = "WalaaPlus-Webhook/1";

export interface DispatchOptions {
  /** Injectable so a test can drive DNS without a resolver. Production passes none. */
  lookup?: LookupFn;
  /** Injectable so a test can reach a loopback receiver. Production passes none — the default IS the rule. */
  addressPolicy?: AddressPolicy;
  /** Injectable so a test receiver with a self-signed certificate can be reached deliberately. */
  ca?: string | Buffer;
}

/** Errors whose code says the network, not the receiver. */
const NETWORK_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EPIPE",
  "EAI_AGAIN",
  "ENOTFOUND",
]);

/**
 * Classify a status code.
 *
 * The one rule worth reading twice: **2xx is the only thing that counts as delivered.** A 3xx is a
 * refusal because following it is the bypass; a 4xx other than 429 is the receiver saying no, and
 * retrying it would be arguing.
 */
function classifyStatus(status: number): DispatchResult {
  if (status >= 200 && status < 300) return { outcome: "DELIVERED", errorClass: "NONE", httpStatus: status };
  if (status >= 300 && status < 400) return { outcome: "PERMANENT", errorClass: "HTTP_REDIRECT", httpStatus: status };
  if (status === 429) return { outcome: "RETRYABLE", errorClass: "HTTP_RATE_LIMITED", httpStatus: status };
  if (status >= 400 && status < 500) return { outcome: "PERMANENT", errorClass: "HTTP_CLIENT_ERROR", httpStatus: status };
  return { outcome: "RETRYABLE", errorClass: "HTTP_SERVER_ERROR", httpStatus: status };
}

/**
 * Classify a thrown error into one of the bounded classes.
 *
 * **The error's message never leaves this function.** A driver or TLS error string can carry a
 * hostname, a certificate subject or, on some stacks, a header — so what is reported is the class,
 * and the class is chosen from a code, not from text matched against a message.
 */
function classifyError(err: unknown): DispatchResult {
  if (err instanceof UnsafeWebhookAddressError) {
    // Never retried. Retrying an SSRF attempt is attempting it again.
    return { outcome: "PERMANENT", errorClass: "UNSAFE_ADDRESS", httpStatus: null };
  }
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  if (code === "ETIMEDOUT" || code === "WALAAPLUS_TIMEOUT") {
    return { outcome: "RETRYABLE", errorClass: "TIMEOUT", httpStatus: null };
  }
  if (typeof code === "string" && (code.startsWith("ERR_TLS") || code.startsWith("CERT_") || code.startsWith("UNABLE_TO_"))) {
    // A certificate problem needs the owner to fix something, not time.
    return { outcome: "PERMANENT", errorClass: "TLS", httpStatus: null };
  }
  if (typeof code === "string" && NETWORK_CODES.has(code)) {
    return { outcome: "RETRYABLE", errorClass: "NETWORK", httpStatus: null };
  }
  // An unrecognised failure is treated as the network's: transient, bounded by the worker's retry
  // cap, and never recorded as delivered.
  return { outcome: "RETRYABLE", errorClass: "NETWORK", httpStatus: null };
}

/**
 * Send one already-validated, already-signed dispatch.
 *
 * Takes a `DispatchRequest` — a host, a port, a path and five checked headers — not a URL string.
 * There is nothing here to re-parse and therefore nothing to disagree with what was validated.
 *
 * **It never throws for a delivery failure.** A failure is a classification to return; a caller that
 * had to distinguish "threw" from "returned" would eventually get it wrong.
 */
export async function dispatchOnce(request: DispatchRequest, options: DispatchOptions = {}): Promise<DispatchResult> {
  const bodyBytes = Buffer.byteLength(request.body, "utf8");

  return new Promise<DispatchResult>((resolve) => {
    let settled = false;
    const finish = (result: DispatchResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    // A fresh agent per attempt: the guarded lookup must run for THIS request rather than a socket
    // being reused from a pool that resolved the name minutes ago.
    const agent = new Agent({
      keepAlive: false,
      maxSockets: 1,
      lookup: makeGuardedLookup(options.lookup, undefined, options.addressPolicy) as never,
    });

    let req: ReturnType<typeof httpsRequest>;
    try {
      req = httpsRequest(
        {
          protocol: "https:",
          host: request.host,
          // SNI and Host stay the hostname; only the socket's address comes from the guarded lookup.
          servername: request.host,
          port: request.port,
          path: request.pathWithQuery,
          method: "POST",
          agent,
          ...(options.ca ? { ca: options.ca } : {}),
          headers: {
            // Set here, never by the caller: a caller-controlled content-length is smuggling.
            "content-type": "application/json",
            "content-length": String(bodyBytes),
            "user-agent": USER_AGENT,
            ...request.headers,
          },
        },
        (res) => {
          const status = res.statusCode ?? 0;
          let read = 0;
          // The body is read only so the socket can close cleanly, and is discarded as it arrives.
          res.on("data", (chunk: Buffer) => {
            read += chunk.length;
            if (read > MAX_RESPONSE_BYTES) res.destroy();
          });
          const done = () => {
            agent.destroy();
            finish(classifyStatus(status));
          };
          res.on("end", done);
          res.on("close", done);
          res.on("error", done);
        },
      );
    } catch (err) {
      agent.destroy();
      finish(classifyError(err));
      return;
    }

    req.setTimeout(REQUEST_TIMEOUT_MS, () => {
      const timeout: NodeJS.ErrnoException = new Error("timeout");
      timeout.code = "WALAAPLUS_TIMEOUT";
      req.destroy(timeout);
    });

    req.on("error", (err) => {
      agent.destroy();
      finish(classifyError(err));
    });

    req.end(request.body);
  });
}
