import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { GatewaySecretUnavailableError, GATEWAY_HEADER, verifyGatewayRequest } from "./auth";
import {
  DISPATCH_PATH,
  DispatchContractError,
  MAX_REQUEST_BYTES,
  parseDispatch,
  type GatewayRefusalCode,
} from "./contract";
import { dispatchOnce, type DispatchOptions } from "./dispatch";
import type { DispatchResult } from "./outcome";

/**
 * The webhook egress gateway.
 *
 * One service, one route, one verb, one contract. It exists so that the process with a route to
 * the Internet is not the process that holds the secrets.
 *
 * ## What reaches it
 *
 * Only the worker, and only over `webhook-control`, a Docker network with `internal: true`. No host
 * port is published in any compose variant, so nothing outside the Compose project can address it —
 * not the host, not a neighbouring stack, not a container in another project. `web`, `db`,
 * `migrate` and the proxy are not on that network and hold no gateway secret; both of those are
 * separately asserted in `tests/unit/compose-exposure.test.ts`.
 *
 * ## Why it is not a proxy
 *
 * A proxy forwards. This does not forward anything. It accepts a JSON object with three fixed keys,
 * validates every one of them, and then **builds its own outbound request** from the parts it
 * accepted. There is no pass-through of a method, a header, a path or a body — the body is the one
 * thing copied verbatim, because the destination's HMAC covers those exact bytes, and it is capped
 * and never inspected.
 *
 * Every proxy-shaped affordance is refused explicitly rather than by omission:
 *
 *   - `CONNECT` is answered by destroying the socket. No tunnel, ever.
 *   - An `Upgrade` is answered by destroying the socket. No WebSocket, ever.
 *   - An absolute-form request target (`POST http://host/path`, the spelling a real proxy accepts)
 *     is a 400 before anything else is read.
 *   - Any path but `/dispatch` is a 404; any method but `POST` is a 405.
 *
 * ## What it says back
 *
 * A status code and a bounded classification. **Never the receiver's body, never its headers, never
 * a resolved address, never an error string.** See `outcome.ts`.
 *
 * ## What it writes down
 *
 * Nothing. Not a URL, not a path, not a query token, not a body, not a header, not a response, not
 * a network error. This module contains no logging call at all; the entry point logs a startup line
 * and, per dispatch, a bounded classification with no identifier in it. Asserted by
 * `tests/unit/webhook-egress-boundary.test.ts`.
 */

/** In flight at once. A one-vCPU host is shared; over this, the answer is BUSY and nothing is sent. */
export const MAX_CONCURRENT_DISPATCHES = 4;

/** Read no more than this from a caller before giving up on it. Matches the contract's cap. */
export const MAX_READ_BYTES = MAX_REQUEST_BYTES;

/** How long a caller may take to deliver its request body before the socket is dropped. */
export const REQUEST_READ_TIMEOUT_MS = 5_000;

/** Reported to the entry point for its bounded log line. Carries no identifier and no address. */
export interface DispatchObservation {
  result: DispatchResult | null;
  refusal: GatewayRefusalCode | null;
  durationMs: number;
}

export interface EgressServerOptions extends DispatchOptions {
  /** 0 asks the OS for a free port, which is what the tests use. */
  port?: number;
  /** Bind address. Defaults to every interface, which inside a container means the Compose network. */
  host?: string;
  /** Where the secret is read from. Injected by tests; production reads the real environment. */
  secretSource?: NodeJS.ProcessEnv;
  /** Seconds since the epoch, injected so a clock-skew test need not wait five minutes. */
  nowSeconds?: () => number;
  /** Called once per request with a classification only. The entry point turns this into one log line. */
  onDispatch?: (observation: DispatchObservation) => void;
  /** Test-only seam; the default is `[443]`. See `ParseOptions` in `contract.ts`. */
  allowedPorts?: readonly number[];
}

export interface EgressServer {
  port: number;
  close(): Promise<void>;
}

const REFUSAL_STATUS: Record<GatewayRefusalCode, number> = {
  BAD_METHOD: 405,
  BAD_PATH: 404,
  BAD_CONTRACT: 400,
  BAD_AUTH: 401,
  SECRET_UNAVAILABLE: 503,
  TOO_LARGE: 413,
  BUSY: 503,
};

function refuse(res: ServerResponse, code: GatewayRefusalCode): void {
  const payload = JSON.stringify({ error: code });
  res.writeHead(REFUSAL_STATUS[code], {
    "content-type": "application/json",
    "content-length": String(Buffer.byteLength(payload, "utf8")),
    // Nothing here is cacheable and nothing here is a page.
    "cache-control": "no-store",
    // A refusal never keeps a connection alive. It also means an unread request body - the
    // TOO_LARGE case - cannot leave the socket half-consumed and waiting.
    connection: "close",
  });
  res.end(payload);
}

/** Drop the connection once the answer is on the wire, for a request whose body was not read. */
function closeAfter(req: IncomingMessage, res: ServerResponse): void {
  res.on("finish", () => req.destroy());
}

function answer(res: ServerResponse, result: DispatchResult): void {
  const payload = JSON.stringify(result);
  res.writeHead(200, {
    "content-type": "application/json",
    "content-length": String(Buffer.byteLength(payload, "utf8")),
    "cache-control": "no-store",
  });
  res.end(payload);
}

/**
 * Read the request body with a running byte count.
 *
 * Rejects with `TOO_LARGE` the moment the cap is passed rather than after the fact: a caller that
 * would send ten megabytes must not be allowed to buffer ten megabytes first. The buffered chunks
 * are dropped at that point and nothing more is accumulated.
 *
 * The stream is PAUSED rather than destroyed, so the handler can still write a 413 and the caller
 * learns why it was refused. Destroying here instead produced a bare socket hang-up, which a
 * caller cannot tell from a gateway that fell over - and which our own worker would have to record
 * as GATEWAY_UNAVAILABLE (retryable) rather than GATEWAY_REJECTED (permanent). The socket is closed
 * once the answer is on the wire; see `closeAfter`.
 */
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let chunks: Buffer[] = [];
    let total = 0;
    let done = false;

    const fail = (code: GatewayRefusalCode, reason: string, destroy = true) => {
      if (done) return;
      done = true;
      chunks = [];
      if (destroy) req.destroy();
      reject(new DispatchContractError(code, reason));
    };

    const timer = setTimeout(() => fail("BAD_CONTRACT", "the caller was too slow to send its body"), REQUEST_READ_TIMEOUT_MS);
    timer.unref?.();

    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_READ_BYTES) {
        clearTimeout(timer);
        req.pause();
        fail("TOO_LARGE", "the request body is over the cap", false);
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", () => {
      clearTimeout(timer);
      fail("BAD_CONTRACT", "the request stream failed");
    });
  });
}

export async function startEgressServer(options: EgressServerOptions = {}): Promise<EgressServer> {
  let inFlight = 0;

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const started = Date.now();
    let refusal: GatewayRefusalCode | null = null;
    let result: DispatchResult | null = null;

    try {
      /*
       * Absolute-form first, before anything else is looked at. `POST http://example.com/x` is how
       * a client addresses a FORWARD PROXY, and a server that quietly treats the authority as part
       * of a path is how one accidentally becomes one.
       */
      const target = req.url ?? "";
      if (!target.startsWith("/")) {
        refusal = "BAD_PATH";
        refuse(res, refusal);
        return;
      }
      if (req.method !== "POST") {
        refusal = "BAD_METHOD";
        refuse(res, refusal);
        return;
      }
      // Compared without the query string: this endpoint takes no parameters at all.
      if (target.split("?")[0] !== DISPATCH_PATH) {
        refusal = "BAD_PATH";
        refuse(res, refusal);
        return;
      }
      const contentType = (req.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
      if (contentType !== "application/json") {
        refusal = "BAD_CONTRACT";
        refuse(res, refusal);
        return;
      }

      const raw = await readBody(req);

      /*
       * Authenticate BEFORE parsing the contract. An unauthenticated caller must not be able to
       * learn which of its JSON shapes this gateway likes, and must not be able to make it do
       * parsing work.
       */
      let authentic: boolean;
      try {
        authentic = verifyGatewayRequest({
          timestamp: req.headers[GATEWAY_HEADER.timestamp] as string | undefined,
          signature: req.headers[GATEWAY_HEADER.signature] as string | undefined,
          body: raw,
          nowSeconds: options.nowSeconds?.(),
          source: options.secretSource,
        });
      } catch (err) {
        if (err instanceof GatewaySecretUnavailableError) {
          // "This deployment is not configured" is a different answer from "you are not authentic",
          // and the worker maps it to the same retryable class either way: nothing was sent.
          refusal = "SECRET_UNAVAILABLE";
          refuse(res, refusal);
          return;
        }
        throw err;
      }
      if (!authentic) {
        refusal = "BAD_AUTH";
        refuse(res, refusal);
        return;
      }

      const request = parseDispatch(raw, { allowedPorts: options.allowedPorts });

      if (inFlight >= MAX_CONCURRENT_DISPATCHES) {
        refusal = "BUSY";
        refuse(res, refusal);
        return;
      }

      inFlight += 1;
      try {
        result = await dispatchOnce(request, {
          lookup: options.lookup,
          addressPolicy: options.addressPolicy,
          ca: options.ca,
        });
      } finally {
        inFlight -= 1;
      }
      answer(res, result);
    } catch (err) {
      if (err instanceof DispatchContractError) {
        refusal = err.code;
        if (!res.headersSent) {
          refuse(res, refusal);
          // The over-cap case stopped reading rather than destroying, so the rest of the caller's
          // body is still arriving. Say why, then hang up.
          if (refusal === "TOO_LARGE") closeAfter(req, res);
        }
        return;
      }
      /*
       * Anything unexpected is a 500 with no detail. The error is not logged, not returned and not
       * classified: an unexpected error's message is the one string most likely to contain a
       * hostname or a header.
       */
      refusal = "BAD_CONTRACT";
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json", "content-length": "20", "cache-control": "no-store" });
        res.end('{"error":"INTERNAL"}');
      }
    } finally {
      options.onDispatch?.({ result, refusal, durationMs: Date.now() - started });
    }
  };

  const server: Server = createServer((req, res) => {
    void handle(req, res);
  });

  /*
   * The two ways an HTTP server becomes a tunnel, closed explicitly.
   *
   * Node does not emit `request` for either of these, so neither is covered by the method check
   * above: a server that ignores them simply leaves the socket open, which for CONNECT is exactly
   * what a proxy client wants.
   */
  server.on("connect", (_req: IncomingMessage, socket: Socket) => socket.destroy());
  server.on("upgrade", (_req: IncomingMessage, socket: Socket) => socket.destroy());
  // A caller that opens a socket and says nothing must not hold one forever.
  server.headersTimeout = REQUEST_READ_TIMEOUT_MS;
  server.requestTimeout = REQUEST_READ_TIMEOUT_MS * 2;

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, options.host ?? "0.0.0.0", () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : (options.port ?? 0);

  return {
    port,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}
