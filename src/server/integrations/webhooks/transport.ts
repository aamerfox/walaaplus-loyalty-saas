import { Agent, request as httpsRequest } from "node:https";
import { WebhookAttemptOutcome, WebhookErrorClass } from "@prisma/client";
import {
  assertSafeWebhookUrl,
  makeGuardedLookup,
  UnsafeWebhookAddressError,
  type AddressPolicy,
  type LookupFn,
} from "./address";
import { HEADER, MAX_BODY_BYTES } from "./envelope";
import { SIGNATURE_VERSION, signPayload } from "./crypto";

/**
 * **The only place in this product that makes an outbound HTTP request.**
 *
 * Not a route, not a page, not a service a request handler reaches. The worker calls the runner in
 * `delivery.ts`, which calls this. `tests/unit/webhook-boundary.test.ts` asserts that nothing under
 * `src/app/` imports either module, and that this file is the only one under `src/server/` holding
 * an HTTP client.
 *
 * ## What this refuses to do
 *
 * - **Follow a redirect.** A 200 from a validated host that redirects to `169.254.169.254` is the
 *   classic SSRF bypass, so a 3xx is an outcome, not a hop. Node's `https.request` does not follow
 *   redirects on its own; this never asks it to.
 * - **Resolve the hostname and then connect to it.** The agent's `lookup` is
 *   `makeGuardedLookup`, which returns only an address that has just passed validation — so the
 *   address checked and the address connected to are the same one, with no window between.
 * - **Read an unbounded response.** The body is read to a hard cap and the socket destroyed.
 * - **Keep the response.** The body is never logged, stored, returned or classified. Only the
 *   status code leaves this function.
 * - **Put a secret in a log.** Nothing here writes to stdout at all.
 */

/** Connection + response, end to end. A receiver slower than this is a retry, not a wait. */
export const REQUEST_TIMEOUT_MS = 5_000;
/** Read at most this much of the response before destroying the socket. Nothing is kept anyway. */
export const MAX_RESPONSE_BYTES = 2048;

export interface SendWebhookInput {
  url: string;
  signingSecret: string;
  body: string;
  eventId: string;
  deliveryId: string;
  attemptNumber: number;
  /** Injectable so a test can drive DNS without a resolver. */
  lookup?: LookupFn;
  /** Injectable so a test can reach a loopback receiver. Production never sets it — see `AddressPolicy`. */
  addressPolicy?: AddressPolicy;
  /** Injectable so a test server with a self-signed certificate can be reached deliberately. */
  ca?: string | Buffer;
}

export interface SendWebhookResult {
  outcome: WebhookAttemptOutcome;
  errorClass: WebhookErrorClass;
  httpStatus: number | null;
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
 * refusal because following it is the bypass; a 4xx other than 429 is the receiver saying no and
 * retrying it would be arguing.
 */
function classifyStatus(status: number): SendWebhookResult {
  if (status >= 200 && status < 300) {
    return { outcome: WebhookAttemptOutcome.DELIVERED, errorClass: WebhookErrorClass.NONE, httpStatus: status };
  }
  if (status >= 300 && status < 400) {
    return { outcome: WebhookAttemptOutcome.PERMANENT, errorClass: WebhookErrorClass.HTTP_REDIRECT, httpStatus: status };
  }
  if (status === 429) {
    return { outcome: WebhookAttemptOutcome.RETRYABLE, errorClass: WebhookErrorClass.HTTP_RATE_LIMITED, httpStatus: status };
  }
  if (status >= 400 && status < 500) {
    return { outcome: WebhookAttemptOutcome.PERMANENT, errorClass: WebhookErrorClass.HTTP_CLIENT_ERROR, httpStatus: status };
  }
  return { outcome: WebhookAttemptOutcome.RETRYABLE, errorClass: WebhookErrorClass.HTTP_SERVER_ERROR, httpStatus: status };
}

/**
 * Classify a thrown error into one of the bounded classes.
 *
 * **The error's message never leaves this function.** A driver or TLS error string can carry a
 * hostname, a certificate subject or, on some stacks, a header — so what is recorded is the class,
 * and the class is chosen from a code, not from text matching a message.
 */
function classifyError(err: unknown): SendWebhookResult {
  if (err instanceof UnsafeWebhookAddressError) {
    // Never retried. Retrying an SSRF attempt is attempting it again.
    return { outcome: WebhookAttemptOutcome.PERMANENT, errorClass: WebhookErrorClass.UNSAFE_ADDRESS, httpStatus: null };
  }
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  if (code === "ETIMEDOUT" || code === "WALAAPLUS_TIMEOUT") {
    return { outcome: WebhookAttemptOutcome.RETRYABLE, errorClass: WebhookErrorClass.TIMEOUT, httpStatus: null };
  }
  if (typeof code === "string" && (code.startsWith("ERR_TLS") || code.startsWith("CERT_") || code.startsWith("UNABLE_TO_"))) {
    // A certificate problem needs the owner to fix something, not time.
    return { outcome: WebhookAttemptOutcome.PERMANENT, errorClass: WebhookErrorClass.TLS, httpStatus: null };
  }
  if (typeof code === "string" && NETWORK_CODES.has(code)) {
    return { outcome: WebhookAttemptOutcome.RETRYABLE, errorClass: WebhookErrorClass.NETWORK, httpStatus: null };
  }
  // An unrecognised failure is treated as the network's: transient, bounded by the retry cap, and
  // never recorded as delivered.
  return { outcome: WebhookAttemptOutcome.RETRYABLE, errorClass: WebhookErrorClass.NETWORK, httpStatus: null };
}

/**
 * Send one attempt.
 *
 * Returns a classification. **It never throws for a delivery failure** — a failure is an outcome to
 * record, and a caller that had to distinguish "threw" from "returned" would eventually get it
 * wrong. The one thing it will not do is return `DELIVERED` for anything but a 2xx.
 */
export async function sendWebhook(input: SendWebhookInput): Promise<SendWebhookResult> {
  const bodyBytes = Buffer.byteLength(input.body, "utf8");
  if (bodyBytes > MAX_BODY_BYTES) {
    // Refused before it is sent. A body this size means something upstream is wrong.
    return { outcome: WebhookAttemptOutcome.PERMANENT, errorClass: WebhookErrorClass.UNSAFE_ADDRESS, httpStatus: null };
  }

  let safe;
  try {
    // Re-validated on every attempt, not only when the owner saved it.
    safe = assertSafeWebhookUrl(input.url);
  } catch (err) {
    return classifyError(err);
  }

  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = `${SIGNATURE_VERSION}=${signPayload(input.signingSecret, timestamp, input.body)}`;

  return new Promise<SendWebhookResult>((resolve) => {
    let settled = false;
    const finish = (result: SendWebhookResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    // A fresh agent per attempt: the guarded lookup must run for THIS request rather than a socket
    // being reused from a pool that resolved the name minutes ago.
    const agent = new Agent({
      keepAlive: false,
      maxSockets: 1,
      lookup: makeGuardedLookup(input.lookup, undefined, input.addressPolicy) as never,
    });

    let req: ReturnType<typeof httpsRequest>;
    try {
      req = httpsRequest(
        {
          protocol: "https:",
          host: safe.host,
          // SNI and Host stay the hostname; only the socket's address comes from the guarded lookup.
          servername: safe.host,
          port: safe.port,
          path: safe.pathWithQuery,
          method: "POST",
          agent,
          ...(input.ca ? { ca: input.ca } : {}),
          headers: {
            "content-type": "application/json",
            "content-length": String(bodyBytes),
            "user-agent": "WalaaPlus-Webhook/1",
            [HEADER.eventId]: input.eventId,
            [HEADER.deliveryId]: input.deliveryId,
            [HEADER.attempt]: String(input.attemptNumber),
            [HEADER.timestamp]: timestamp,
            [HEADER.signature]: signature,
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

    req.end(input.body);
  });
}
