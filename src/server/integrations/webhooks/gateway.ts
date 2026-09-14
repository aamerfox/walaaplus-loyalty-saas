import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { WebhookAttemptOutcome, WebhookErrorClass } from "@prisma/client";
import {
  GATEWAY_HEADER,
  GatewaySecretUnavailableError,
  loadGatewaySecret,
  signGatewayRequest,
} from "../../../egress/auth";
import { DISPATCH_PATH, MAX_DISPATCH_URL_BYTES } from "../../../egress/contract";
import { isDispatchResult, type DispatchResult } from "../../../egress/outcome";
import { assertSafeWebhookUrl, UnsafeWebhookAddressError } from "./address";
import { SIGNATURE_VERSION, signPayload } from "./crypto";
import { HEADER, MAX_BODY_BYTES } from "./envelope";

/**
 * The worker's side of the egress hop.
 *
 * **This module cannot reach the Internet, and that is its point.** It opens exactly one kind of
 * connection: to the egress gateway, at an origin that comes from the environment, on a path that
 * is a compile-time constant. No caller supplies a URL for this hop — the destination URL is
 * *inside* the JSON body, where it is data for the gateway to validate, not an address this code
 * can be pointed at.
 *
 * ## What stays on this side
 *
 * Decryption, the canonical envelope, and **the HMAC signature over the body using the
 * destination's own signing secret**. That secret never crosses the hop: the gateway receives a
 * body and a finished `x-walaaplus-signature` header and has no way to produce either. So a
 * compromise of the gateway — the one process with a route out — cannot forge a webhook that a
 * receiver would accept, because it never holds the key that makes one valid.
 *
 * ## What crosses the hop
 *
 * The destination URL, the signed body, and five headers. The URL is the sensitive part: it may
 * carry a path or query token a receiver treats as authentication. The hop is authenticated with
 * `WEBHOOK_GATEWAY_SECRET` and runs on a Docker network with `internal: true`, but it is not
 * encrypted — stated as residual risk R1 in `docs/WEBHOOK-EGRESS-TOPOLOGY.md` §6.2 rather than
 * implied away.
 *
 * ## Fail closed, in the right direction
 *
 * Every failure of this hop is `GATEWAY_UNAVAILABLE`, **retryable**, except a refusal that only our
 * own code can provoke — a contract violation — which is `GATEWAY_REJECTED`, permanent. The
 * distinction matters because these are our faults, not the merchant's: recording either as
 * `NETWORK` would tell an owner their endpoint is flaky when it was never contacted.
 */

/** Where the gateway is, inside the Compose network. Not a secret; overridden per environment. */
export const DEFAULT_GATEWAY_URL = "http://webhook-egress:8082";

/**
 * How long the worker waits on the gateway.
 *
 * Deliberately longer than the gateway's own outbound timeout (5 s) plus DNS and a TLS handshake,
 * so that in the normal case the *gateway's* classification is what gets recorded rather than this
 * side giving up first and recording a gateway fault for a slow receiver.
 */
export const GATEWAY_TIMEOUT_MS = 15_000;

/** A gateway that answers with more than this is not our gateway. */
export const MAX_GATEWAY_RESPONSE_BYTES = 2048;

export interface SendWebhookInput {
  url: string;
  signingSecret: string;
  body: string;
  eventId: string;
  deliveryId: string;
  attemptNumber: number;
  /** Injected by tests so an in-process gateway on loopback can be addressed. */
  gatewayUrl?: string;
  /** Injected by tests. Production reads the real environment. */
  env?: NodeJS.ProcessEnv;
}

export interface SendWebhookResult {
  outcome: WebhookAttemptOutcome;
  errorClass: WebhookErrorClass;
  httpStatus: number | null;
}

function unavailable(): SendWebhookResult {
  return {
    outcome: WebhookAttemptOutcome.RETRYABLE,
    errorClass: WebhookErrorClass.GATEWAY_UNAVAILABLE,
    httpStatus: null,
  };
}

function rejected(): SendWebhookResult {
  return {
    outcome: WebhookAttemptOutcome.PERMANENT,
    errorClass: WebhookErrorClass.GATEWAY_REJECTED,
    httpStatus: null,
  };
}

function unsafeAddress(): SendWebhookResult {
  return {
    outcome: WebhookAttemptOutcome.PERMANENT,
    errorClass: WebhookErrorClass.UNSAFE_ADDRESS,
    httpStatus: null,
  };
}

/** The gateway's vocabulary is a subset of the schema's, so this is a widening, not a mapping. */
function fromDispatchResult(result: DispatchResult): SendWebhookResult {
  return {
    outcome: WebhookAttemptOutcome[result.outcome],
    errorClass: WebhookErrorClass[result.errorClass],
    httpStatus: result.httpStatus,
  };
}

interface GatewayOrigin {
  secure: boolean;
  host: string;
  port: number;
}

/**
 * Where to send, from configuration only.
 *
 * Note what is taken and what is thrown away: the scheme, host and port are kept; **any path,
 * query, fragment or userinfo in the configured value is discarded**, and the request path is the
 * constant `DISPATCH_PATH`. A misconfigured or hostile `WEBHOOK_GATEWAY_URL` can therefore move
 * which host is called, which is an operator's decision to make — it cannot turn this function into
 * one that requests an arbitrary path.
 *
 * An IP literal IS accepted here, unlike a destination URL. They are different rules for different
 * things: a destination is a stranger's address and must be a public name so the DNS policy can be
 * applied to it; the gateway is our own service, addressed by a Compose service name in production
 * and by `127.0.0.1` in a test.
 */
function originOf(raw: string): GatewayOrigin | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username !== "" || url.password !== "") return null;
  if (url.hostname === "") return null;
  const secure = url.protocol === "https:";
  const port = url.port === "" ? (secure ? 443 : 80) : Number(url.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { secure, host: url.hostname, port };
}

/**
 * Send one attempt, through the gateway.
 *
 * **Never throws for a delivery failure.** Every outcome is a classification the caller records.
 */
export async function sendWebhook(input: SendWebhookInput): Promise<SendWebhookResult> {
  const env = input.env ?? process.env;

  const bodyBytes = Buffer.byteLength(input.body, "utf8");
  if (bodyBytes > MAX_BODY_BYTES) {
    // Refused before it is sent. A body this size means something upstream is wrong, and the
    // gateway would refuse it too — this just refuses it one hop earlier.
    return rejected();
  }

  /*
   * The shape rules, run here as well as in the gateway. This copy is advisory — the gateway is the
   * process with the route and it checks again on its own copy — but it is worth keeping: a URL
   * that fails here never crosses the hop at all, so a stored value that has gone bad is refused
   * without a second service ever seeing it.
   *
   * **The port rule is deliberately NOT duplicated here.** `REQUIRED_PORT` is enforced once, in the
   * gateway, because that is the process with the route and because the seam that lets a test reach
   * a local receiver on an ephemeral port belongs with it. Two copies would mean two places to keep
   * in step and a second seam on the side that has the secrets. A destination on a port other than
   * 443 therefore crosses the hop once and comes back GATEWAY_REJECTED, permanently, which is the
   * correct answer for it.
   */
  let safeUrl: string;
  try {
    const safe = assertSafeWebhookUrl(input.url);
    if (Buffer.byteLength(safe.href, "utf8") > MAX_DISPATCH_URL_BYTES) return unsafeAddress();
    safeUrl = safe.href;
  } catch (err) {
    if (err instanceof UnsafeWebhookAddressError) return unsafeAddress();
    throw err;
  }

  // Signed HERE. The signing secret does not cross the hop.
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = `${SIGNATURE_VERSION}=${signPayload(input.signingSecret, timestamp, input.body)}`;

  const dispatch = JSON.stringify({
    url: safeUrl,
    body: input.body,
    headers: {
      [HEADER.eventId]: input.eventId,
      [HEADER.deliveryId]: input.deliveryId,
      [HEADER.attempt]: String(input.attemptNumber),
      [HEADER.timestamp]: timestamp,
      [HEADER.signature]: signature,
    },
  });

  let gatewaySignature: string;
  const gatewayTimestamp = timestamp;
  try {
    gatewaySignature = signGatewayRequest(loadGatewaySecret(env), gatewayTimestamp, dispatch);
  } catch (err) {
    // The shared secret is absent or malformed: a deployment condition an operator corrects in
    // minutes. Nothing is sent, and the delivery waits rather than being discarded.
    if (err instanceof GatewaySecretUnavailableError) return unavailable();
    throw err;
  }

  const origin = originOf(input.gatewayUrl ?? env.WEBHOOK_GATEWAY_URL ?? DEFAULT_GATEWAY_URL);
  if (!origin) return unavailable();

  return new Promise<SendWebhookResult>((resolve) => {
    let settled = false;
    const finish = (result: SendWebhookResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const send = origin.secure ? httpsRequest : httpRequest;
    const req = send(
      {
        host: origin.host,
        port: origin.port,
        // A constant. There is no caller-supplied path on this hop.
        path: DISPATCH_PATH,
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": String(Buffer.byteLength(dispatch, "utf8")),
          [GATEWAY_HEADER.timestamp]: gatewayTimestamp,
          [GATEWAY_HEADER.signature]: gatewaySignature,
        },
      },
      (res) => {
        const status = res.statusCode ?? 0;
        const chunks: Buffer[] = [];
        let read = 0;
        res.on("data", (chunk: Buffer) => {
          read += chunk.length;
          if (read > MAX_GATEWAY_RESPONSE_BYTES) {
            res.destroy();
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => {
          /*
           * 400 and 413 are the only answers our own code can provoke: a URL or a body the contract
           * refuses. Permanent, because waiting does not make a malformed dispatch well formed.
           *
           * Everything else — unreachable, 401 (our secret does not match the gateway's), 403, 404
           * or 405 (whatever is answering is not our gateway), 503 (its secret is unset, or it is
           * at its concurrency limit), any other 5xx — is a deployment condition an operator
           * corrects. Retryable and bounded by the normal five-attempt cap.
           */
          if (status === 400 || status === 413) {
            finish(rejected());
            return;
          }
          if (status !== 200) {
            finish(unavailable());
            return;
          }
          try {
            const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            if (!isDispatchResult(parsed)) {
              finish(unavailable());
              return;
            }
            finish(fromDispatchResult(parsed));
          } catch {
            // A 200 we cannot read is not a delivery we may record.
            finish(unavailable());
          }
        });
        res.on("error", () => finish(unavailable()));
      },
    );

    req.setTimeout(GATEWAY_TIMEOUT_MS, () => req.destroy(new Error("gateway timeout")));
    req.on("error", () => finish(unavailable()));
    req.end(dispatch);
  });
}
