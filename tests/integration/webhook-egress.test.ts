import { randomBytes } from "node:crypto";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { connect as tcpConnect } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GATEWAY_HEADER, signGatewayRequest } from "@/egress/auth";
import { DISPATCH_PATH, MAX_REQUEST_BYTES } from "@/egress/contract";
import { MAX_CONCURRENT_DISPATCHES } from "@/egress/server";
import { startEgressServer, type EgressServer } from "@/egress/server";
import { addressProblem, type AddressPolicy, type LookupFn } from "@/server/integrations/webhooks/address";
import { signaturesMatch, signPayload } from "@/server/integrations/webhooks/crypto";
import { HEADER } from "@/server/integrations/webhooks/envelope";
import { sendWebhook } from "@/server/integrations/webhooks/gateway";
import { OVERSIZED_MARKER, startReceiver, type Receiver } from "../setup/webhook-receiver";

/**
 * The egress gateway at the socket level — the half the pure-function tests cannot reach.
 *
 * Everything here runs on loopback, against a local HTTPS receiver this file starts and stops.
 * **No merchant endpoint, no provider, no external host and no staging service is contacted**, and
 * both secrets are generated per run with `randomBytes` and never printed.
 *
 * Two things are being proved, and they are different:
 *
 *   1. the gateway is a **dispatcher, not a proxy** — a raw client that tries to use it as one is
 *      refused at every affordance a proxy would offer;
 *   2. the worker-to-gateway hop **fails closed in the right direction** — every failure of ours is
 *      retryable and sends nothing, and only a contract violation is permanent.
 *
 * The pure-function half is `tests/unit/webhook-gateway-contract.test.ts`; the topology half is
 * `tests/unit/compose-exposure.test.ts`.
 */

const HOST = "hooks.test.example.com";

let receiver: Receiver;
let gateway: EgressServer;
let gatewayUrl: string;
let secret: string;
let currentLookup: LookupFn;
let currentPolicy: AddressPolicy;

function resolverTo(address: string): LookupFn {
  return ((_h: string, _o: unknown, cb: (e: unknown, a?: unknown) => void) => {
    cb(null, [{ address, family: 4 }]);
  }) as LookupFn;
}

/** Permits exactly the loopback the receiver is bound to; the real rule for everything else. */
function allowReceiver(address: string): string | null {
  return address === receiver.address ? null : addressProblem(address);
}

function withResolver(lookup: LookupFn, policy: AddressPolicy = allowReceiver): void {
  currentLookup = lookup;
  currentPolicy = policy;
}

beforeAll(async () => {
  secret = randomBytes(32).toString("hex");
  process.env.WEBHOOK_GATEWAY_SECRET = secret;

  receiver = await startReceiver();
  withResolver(resolverTo(receiver.address));

  gateway = await startEgressServer({
    host: "127.0.0.1",
    lookup: ((h, o, cb) => currentLookup(h, o, cb)) as LookupFn,
    addressPolicy: (address) => currentPolicy(address),
    ca: receiver.ca,
    allowedPorts: [receiver.port],
  });
  gatewayUrl = `http://127.0.0.1:${gateway.port}`;
});

afterAll(async () => {
  await gateway.close();
  await receiver.close();
  delete process.env.WEBHOOK_GATEWAY_SECRET;
});

/** One dispatch through the worker's own client, which is the production path. */
function deliver(path = "/hook", overrides: Partial<Parameters<typeof sendWebhook>[0]> = {}) {
  return sendWebhook({
    url: `https://${HOST}:${receiver.port}${path}`,
    signingSecret: "s".repeat(64),
    body: JSON.stringify({ id: "evt_1" }),
    eventId: "evt_1",
    deliveryId: "dlv_1",
    attemptNumber: 1,
    gatewayUrl,
    ...overrides,
  });
}

interface RawAnswer {
  status: number;
  body: string;
}

/**
 * Speak to the gateway directly, the way something that is not our worker would.
 *
 * Deliberately low-level: a caller that could use this to reach a merchant endpoint is the failure
 * this whole service exists to prevent, so the tests do exactly that and assert the refusals.
 */
function raw(options: {
  method?: string;
  path?: string;
  body?: string;
  contentType?: string | null;
  sign?: boolean | string;
  timestamp?: string;
  headers?: Record<string, string>;
}): Promise<RawAnswer> {
  const body = options.body ?? "{}";
  const timestamp = options.timestamp ?? Math.floor(Date.now() / 1000).toString();
  const headers: Record<string, string> = {
    "content-length": String(Buffer.byteLength(body, "utf8")),
    ...(options.contentType === null ? {} : { "content-type": options.contentType ?? "application/json" }),
    ...(options.headers ?? {}),
  };
  if (options.sign !== false) {
    headers[GATEWAY_HEADER.timestamp] = timestamp;
    headers[GATEWAY_HEADER.signature] =
      typeof options.sign === "string"
        ? options.sign
        : signGatewayRequest(Buffer.from(secret, "hex"), timestamp, body);
  }

  return new Promise<RawAnswer>((resolve, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port: gateway.port,
        method: options.method ?? "POST",
        path: options.path ?? DISPATCH_PATH,
        headers,
      },
      (res: IncomingMessage) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
      },
    );
    req.on("error", reject);
    req.setTimeout(20_000, () => req.destroy(new Error("raw request timed out")));
    req.end(body);
  });
}

function dispatchBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    url: `https://${HOST}:${receiver.port}/hook`,
    body: JSON.stringify({ id: "evt_1" }),
    headers: {
      [HEADER.eventId]: "evt_1",
      [HEADER.deliveryId]: "dlv_1",
      [HEADER.attempt]: "1",
      [HEADER.timestamp]: "1700000000",
      [HEADER.signature]: "v1=deadbeef",
    },
    ...overrides,
  });
}

describe("the controlled receiver is reached through the gateway", () => {
  it("delivers, and the receiver sees a signature the worker made", async () => {
    receiver.reset();
    withResolver(resolverTo(receiver.address));

    const signingSecret = "s".repeat(64);
    const result = await deliver("/hook", { signingSecret });

    expect(result.outcome).toBe("DELIVERED");
    expect(result.errorClass).toBe("NONE");
    expect(result.httpStatus).toBe(200);

    const request = receiver.requests.at(-1);
    expect(request?.method).toBe("POST");
    expect(request?.path).toBe("/hook");

    /*
     * The signature the RECEIVER got verifies under the destination's secret — which the gateway
     * never held. That is the division: the worker signs, the gateway sends, and a compromised
     * gateway cannot produce a webhook a receiver would accept.
     */
    const timestamp = String(request?.headers[HEADER.timestamp]);
    const signature = String(request?.headers[HEADER.signature]);
    expect(signaturesMatch(signature, `v1=${signPayload(signingSecret, timestamp, request?.body ?? "")}`)).toBe(true);

    // The gateway set these itself; the caller could not have.
    expect(request?.headers["content-type"]).toBe("application/json");
    expect(request?.headers["user-agent"]).toBe("WalaaPlus-Webhook/1");
    // And nothing outside the allow-list plus the three the gateway owns arrived.
    for (const forbidden of ["authorization", "cookie", "x-forwarded-for"]) {
      expect(request?.headers[forbidden], forbidden).toBeUndefined();
    }
  });

  it("classifies what the receiver says without ever keeping what it said", async () => {
    for (const [path, outcome, errorClass, status] of [
      ["/status/201", "DELIVERED", "NONE", 201],
      ["/status/404", "PERMANENT", "HTTP_CLIENT_ERROR", 404],
      ["/status/429", "RETRYABLE", "HTTP_RATE_LIMITED", 429],
      ["/status/503", "RETRYABLE", "HTTP_SERVER_ERROR", 503],
    ] as const) {
      withResolver(resolverTo(receiver.address));
      const result = await deliver(path);
      expect(result.outcome, path).toBe(outcome);
      expect(result.errorClass, path).toBe(errorClass);
      expect(result.httpStatus, path).toBe(status);
      expect(Object.keys(result).sort(), path).toEqual(["errorClass", "httpStatus", "outcome"]);
    }
  });

  it("refuses a redirect instead of following it", async () => {
    // `/redirect` answers 302 to the cloud metadata address. Following it is the classic bypass.
    withResolver(resolverTo(receiver.address));
    const result = await deliver("/redirect");
    expect(result.outcome).toBe("PERMANENT");
    expect(result.errorClass).toBe("HTTP_REDIRECT");
    expect(result.httpStatus).toBe(302);
  });

  it("returns no part of an oversized response body, at any layer", async () => {
    withResolver(resolverTo(receiver.address));
    const result = await deliver("/big");
    expect(result.outcome).toBe("DELIVERED");
    // The receiver sent hundreds of copies of the marker. None of it is in what came back.
    expect(JSON.stringify(result)).not.toContain(OVERSIZED_MARKER);
  });

  it("times out on a receiver that never answers, and calls it retryable", async () => {
    withResolver(resolverTo(receiver.address));
    const result = await deliver("/hang");
    expect(result.outcome).toBe("RETRYABLE");
    expect(result.errorClass).toBe("TIMEOUT");
    expect(result.httpStatus).toBeNull();
  }, 30_000);
});

describe("the gateway refuses to be a proxy", () => {
  it("answers 405 to every method but POST", async () => {
    for (const method of ["GET", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"]) {
      const answer = await raw({ method });
      expect(answer.status, method).toBe(405);
    }
  });

  it("answers 404 to every path but /dispatch", async () => {
    for (const path of ["/", "/healthz", "/proxy", "/dispatch/extra", "/DISPATCH"]) {
      const answer = await raw({ path });
      expect(answer.status, path).toBe(404);
    }
  });

  it("refuses an absolute-form request target, which is how a forward proxy is addressed", async () => {
    /*
     * `POST http://example.com/x HTTP/1.1` is the proxy spelling. A server that treats the
     * authority as part of a path is how one accidentally becomes a proxy, so it is refused before
     * anything else about the request is considered.
     */
    for (const target of ["http://example.com/x", "https://example.com/x", "http://169.254.169.254/latest/"]) {
      const answer = await raw({ path: target });
      expect(answer.status, target).toBe(404);
      expect(answer.body).toContain("BAD_PATH");
    }
  });

  it("destroys the socket on CONNECT rather than opening a tunnel", async () => {
    // Node does not emit `request` for CONNECT, so the method check above never sees one. A server
    // that ignores the event simply leaves the socket open — which is exactly what a proxy client
    // is waiting for.
    const answer = await new Promise<string>((resolve) => {
      const socket = tcpConnect(gateway.port, "127.0.0.1", () => {
        socket.write("CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n");
      });
      let received = "";
      socket.setTimeout(5_000, () => {
        socket.destroy();
        resolve(`TIMEOUT:${received}`);
      });
      socket.on("data", (chunk: Buffer) => {
        received += chunk.toString("utf8");
      });
      socket.on("close", () => resolve(`CLOSED:${received}`));
      socket.on("error", () => resolve(`ERROR:${received}`));
    });
    // Closed or reset, with no "200 Connection Established" — the one answer that would mean a
    // tunnel was opened.
    expect(answer).not.toContain("200");
    expect(answer.startsWith("CLOSED:") || answer.startsWith("ERROR:")).toBe(true);
  }, 20_000);

  it("destroys the socket on an Upgrade rather than speaking WebSocket", async () => {
    const answer = await new Promise<string>((resolve) => {
      const socket = tcpConnect(gateway.port, "127.0.0.1", () => {
        socket.write(
          "GET /dispatch HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
            "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n",
        );
      });
      let received = "";
      socket.setTimeout(5_000, () => {
        socket.destroy();
        resolve(`TIMEOUT:${received}`);
      });
      socket.on("data", (chunk: Buffer) => {
        received += chunk.toString("utf8");
      });
      socket.on("close", () => resolve(`CLOSED:${received}`));
      socket.on("error", () => resolve(`ERROR:${received}`));
    });
    expect(answer).not.toContain("101");
    expect(answer).not.toContain("Switching Protocols");
  }, 20_000);

  it("refuses a body that is not declared as JSON", async () => {
    for (const contentType of ["text/plain", "application/x-www-form-urlencoded", "multipart/form-data"]) {
      const answer = await raw({ contentType });
      expect(answer.status, contentType).toBe(400);
    }
    const none = await raw({ contentType: null });
    expect(none.status).toBe(400);
  });

  it("refuses a request body past the read cap, and says so rather than hanging up", async () => {
    /*
     * The answer matters, not just the refusal. A bare socket hang-up is indistinguishable from a
     * gateway that fell over, and our own worker would have to call that GATEWAY_UNAVAILABLE and
     * retry it forever; a 413 is GATEWAY_REJECTED, permanent, which is the truth about a body this
     * size. So the gateway stops reading, answers, and then closes.
     */
    const answer = await raw({ body: JSON.stringify({ pad: "x".repeat(MAX_REQUEST_BYTES * 4) }) });
    expect(answer.status).toBe(413);
    expect(answer.body).toContain("TOO_LARGE");
  });
});

describe("a caller without the secret cannot make the gateway do anything", () => {
  it("refuses an unsigned request", async () => {
    const answer = await raw({ body: dispatchBody(), sign: false });
    expect(answer.status).toBe(401);
    expect(answer.body).toContain("BAD_AUTH");
  });

  it("refuses a request signed with the wrong secret", async () => {
    const forged = signGatewayRequest(randomBytes(32), Math.floor(Date.now() / 1000).toString(), dispatchBody());
    const answer = await raw({ body: dispatchBody(), sign: forged });
    expect(answer.status).toBe(401);
  });

  it("refuses a signature that does not cover this body", async () => {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const signature = signGatewayRequest(Buffer.from(secret, "hex"), timestamp, dispatchBody());
    // Same signature, different body: the bytes are what is signed.
    const answer = await raw({ body: dispatchBody({ url: `https://${HOST}:${receiver.port}/elsewhere` }), sign: signature, timestamp });
    expect(answer.status).toBe(401);
  });

  it("refuses a replay from outside the timestamp window", async () => {
    const stale = (Math.floor(Date.now() / 1000) - 3600).toString();
    const signature = signGatewayRequest(Buffer.from(secret, "hex"), stale, dispatchBody());
    const answer = await raw({ body: dispatchBody(), sign: signature, timestamp: stale });
    expect(answer.status).toBe(401);
  });

  it("sends nothing to the receiver for any of those", async () => {
    receiver.reset();
    await raw({ body: dispatchBody(), sign: false });
    await raw({ body: dispatchBody(), sign: "v1=00" });
    expect(receiver.requests).toHaveLength(0);
  });

  it("is the reason web, db and migrate cannot invoke it even if they could reach it", async () => {
    /*
     * Those services hold no `WEBHOOK_GATEWAY_SECRET` — `tests/unit/compose-exposure.test.ts`
     * asserts that no compose file gives them one, and that none of them is on the gateway's
     * network. This is the other half: WITHOUT the secret, reaching the gateway achieves nothing.
     * Two independent barriers, and this test is the one that does not depend on a YAML file.
     */
    const answer = await raw({ body: dispatchBody(), sign: false });
    expect(answer.status).toBe(401);
    expect(answer.body).not.toContain(HOST);
  });
});

describe("an unconfigured gateway refuses instead of crashing", () => {
  it("answers SECRET_UNAVAILABLE, and the worker calls that retryable", async () => {
    const unconfigured = await startEgressServer({
      host: "127.0.0.1",
      // No WEBHOOK_GATEWAY_SECRET in this environment at all.
      secretSource: {} as NodeJS.ProcessEnv,
      lookup: ((h, o, cb) => currentLookup(h, o, cb)) as LookupFn,
      addressPolicy: (address) => currentPolicy(address),
      ca: receiver.ca,
      allowedPorts: [receiver.port],
    });
    try {
      receiver.reset();
      const result = await deliver("/hook", { gatewayUrl: `http://127.0.0.1:${unconfigured.port}` });
      // Retryable: a deployment condition an operator corrects in minutes, not a lost webhook.
      expect(result.outcome).toBe("RETRYABLE");
      expect(result.errorClass).toBe("GATEWAY_UNAVAILABLE");
      expect(receiver.requests).toHaveLength(0);
    } finally {
      await unconfigured.close();
    }
  });

  it("refuses when the WORKER has no secret, without opening a socket to the gateway", async () => {
    const result = await deliver("/hook", { env: {} as NodeJS.ProcessEnv });
    expect(result.outcome).toBe("RETRYABLE");
    expect(result.errorClass).toBe("GATEWAY_UNAVAILABLE");
  });

  it("refuses when the worker's secret does not match the gateway's", async () => {
    const result = await deliver("/hook", {
      env: { WEBHOOK_GATEWAY_SECRET: randomBytes(32).toString("hex") } as unknown as NodeJS.ProcessEnv,
    });
    expect(result.outcome).toBe("RETRYABLE");
    expect(result.errorClass).toBe("GATEWAY_UNAVAILABLE");
  });

  it("treats a gateway that is not there as retryable, not as a failed delivery", async () => {
    // Nothing is listening on this port. The delivery waits; it is not discarded.
    const result = await deliver("/hook", { gatewayUrl: "http://127.0.0.1:1" });
    expect(result.outcome).toBe("RETRYABLE");
    expect(result.errorClass).toBe("GATEWAY_UNAVAILABLE");
  });

  it("treats a malformed gateway address as retryable too", async () => {
    for (const bad of ["not a url", "ftp://webhook-egress:8082", "http://user:pass@webhook-egress:8082"]) {
      const result = await deliver("/hook", { gatewayUrl: bad });
      expect(result.errorClass, bad).toBe("GATEWAY_UNAVAILABLE");
    }
  });
});

describe("the address rules are enforced again here, by the process with the route", () => {
  it("refuses a contract-level unsafe address before any socket is opened", async () => {
    /*
     * Every URL here carries the port this gateway WAS configured for, so the port rule cannot be
     * what refuses them. Without that the port check masks the address check and this test passes
     * even with the address rules removed - which is exactly what a red proof found.
     */
    receiver.reset();
    const p = receiver.port;
    for (const url of [
      `https://127.0.0.1:${p}/x`,
      `https://169.254.169.254:${p}/latest/meta-data/`,
      `https://localhost:${p}/x`,
      `https://db.internal:${p}/x`,
      `https://[::1]:${p}/x`,
      `http://hooks.test.example.com:${p}/x`,
      `https://user:pass@hooks.test.example.com:${p}/x`,
      `https://hooks.test.example.com:${p}/x y`,
    ]) {
      const answer = await raw({ body: dispatchBody({ url }) });
      expect(answer.status, url).toBe(400);
      expect(answer.body, url).toContain("BAD_CONTRACT");
    }
    expect(receiver.requests).toHaveLength(0);
  });

  it("refuses at connection time when a public name resolves to a private address", async () => {
    // The URL passes every shape check. The name answers with the metadata address by the time the
    // gateway resolves it — and the guarded lookup is what the socket uses, so it never connects.
    receiver.reset();
    withResolver(resolverTo("169.254.169.254"), addressProblem);
    const result = await deliver("/hook");
    expect(result.outcome).toBe("PERMANENT");
    expect(result.errorClass).toBe("UNSAFE_ADDRESS");
    expect(result.httpStatus).toBeNull();
    expect(receiver.requests).toHaveLength(0);
  });

  it("refuses every private range the same way", async () => {
    for (const address of ["10.0.0.1", "127.0.0.1", "192.168.1.1", "172.16.0.1", "100.64.0.1", "0.0.0.0"]) {
      withResolver(resolverTo(address), addressProblem);
      const result = await deliver("/hook");
      expect(result.errorClass, address).toBe("UNSAFE_ADDRESS");
      expect(result.outcome, address).toBe("PERMANENT");
    }
  });

  it("says nothing about the address it refused", async () => {
    withResolver(resolverTo("169.254.169.254"), addressProblem);
    const answer = await raw({ body: dispatchBody() });
    expect(answer.status).toBe(200);
    expect(answer.body).toContain("UNSAFE_ADDRESS");
    // Not the resolved address, not the hostname, not the path.
    expect(answer.body).not.toContain("169.254");
    expect(answer.body).not.toContain(HOST);
    expect(answer.body).not.toContain("/hook");
  });

  it("refuses a port other than the ones this gateway was configured for", async () => {
    withResolver(resolverTo(receiver.address));
    const answer = await raw({ body: dispatchBody({ url: `https://${HOST}:${receiver.port + 7}/hook` }) });
    expect(answer.status).toBe(400);
  });
});

describe("concurrency is bounded", () => {
  it("refuses a dispatch past the in-flight limit rather than queueing it", async () => {
    /*
     * `/hang` never answers, so each accepted dispatch occupies a slot until the gateway's own
     * 5-second timeout. Firing more than the limit at once must produce a BUSY refusal — which the
     * worker records as GATEWAY_UNAVAILABLE and retries — rather than an unbounded queue of open
     * sockets on a one-vCPU host shared with other people's services.
     */
    withResolver(resolverTo(receiver.address));
    const overshoot = MAX_CONCURRENT_DISPATCHES + 3;
    const answers = await Promise.all(
      Array.from({ length: overshoot }, () => raw({ body: dispatchBody({ url: `https://${HOST}:${receiver.port}/hang` }) })),
    );
    const busy = answers.filter((a) => a.status === 503 && a.body.includes("BUSY"));
    expect(busy.length).toBeGreaterThan(0);
    expect(busy.length).toBeLessThanOrEqual(overshoot - MAX_CONCURRENT_DISPATCHES);
  }, 40_000);
});
