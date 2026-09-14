import { randomBytes } from "node:crypto";
import { WebhookAttemptOutcome, WebhookErrorClass } from "@prisma/client";
import { describe, expect, it } from "vitest";
import {
  GATEWAY_HEADER,
  GATEWAY_SECRET_BYTES,
  GATEWAY_TIMESTAMP_TOLERANCE_SECONDS,
  GatewaySecretUnavailableError,
  gatewaySecretAvailable,
  loadGatewaySecret,
  signGatewayRequest,
  verifyGatewayRequest,
} from "@/egress/auth";
import {
  ALLOWED_DISPATCH_HEADERS,
  DISPATCH_PATH,
  DispatchContractError,
  MAX_DISPATCH_BODY_BYTES,
  MAX_HEADER_VALUE_BYTES,
  MAX_REQUEST_BYTES,
  parseDispatch,
  REQUIRED_PORT,
} from "@/egress/contract";
import {
  DISPATCH_ERROR_CLASSES,
  DISPATCH_OUTCOMES,
  isDispatchResult,
} from "@/egress/outcome";
import { HEADER, MAX_BODY_BYTES } from "@/server/integrations/webhooks/envelope";

/**
 * The egress gateway's contract, as pure functions.
 *
 * Everything here runs without a socket, which is the point: the rules that stop this service being
 * an open proxy are decidable from a string, so they are tested from a string and there is no
 * network in the loop to make a refusal look like a flake.
 *
 * The socket-level behaviour — CONNECT, Upgrade, oversized streams, concurrency, a real receiver —
 * is `tests/integration/webhook-egress.test.ts`.
 */

const SECRET = "a".repeat(64);
const ENV = { WEBHOOK_GATEWAY_SECRET: SECRET } as unknown as NodeJS.ProcessEnv;

function headers(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    "x-walaaplus-event-id": "evt_1",
    "x-walaaplus-delivery-id": "dlv_1",
    "x-walaaplus-attempt": "1",
    "x-walaaplus-timestamp": "1700000000",
    "x-walaaplus-signature": "v1=deadbeef",
    ...overrides,
  };
}

function dispatch(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    url: "https://hooks.example.com/incoming",
    body: '{"id":"evt_1"}',
    headers: headers(),
    ...overrides,
  });
}

/** The reason string is for a developer; only the code ever leaves the process. */
function refusalOf(raw: string, options?: { allowedPorts?: readonly number[] }): string {
  try {
    parseDispatch(raw, options);
  } catch (err) {
    expect(err, raw.slice(0, 60)).toBeInstanceOf(DispatchContractError);
    return (err as DispatchContractError).code;
  }
  throw new Error(`expected a refusal for: ${raw.slice(0, 120)}`);
}

describe("the vocabulary cannot drift from the schema", () => {
  /*
   * The gateway holds no Prisma client — it has no database and must not carry a query engine —
   * so its outcome and error-class names are plain strings. That is a duplication, and this is the
   * assertion that makes the duplication safe: a value added to the schema and not here would
   * otherwise surface as a string the worker cannot store, at delivery time, in production.
   */
  it("names every outcome the schema has, and no other", () => {
    expect([...DISPATCH_OUTCOMES].sort()).toEqual(Object.values(WebhookAttemptOutcome).sort());
  });

  it("names only error classes the schema has", () => {
    const schema = Object.values(WebhookErrorClass) as string[];
    for (const name of DISPATCH_ERROR_CLASSES) expect(schema, name).toContain(name);
  });

  it("deliberately cannot say the classes that are not its to decide", () => {
    // The worker decides these before it ever calls, and GATEWAY_UNAVAILABLE is what the worker
    // records when the gateway did not answer — which the gateway is in no position to report.
    for (const name of ["ENCRYPTION_UNAVAILABLE", "CIPHERTEXT_INVALID", "DESTINATION_NOT_ELIGIBLE", "GATEWAY_UNAVAILABLE"]) {
      expect(DISPATCH_ERROR_CLASSES as readonly string[], name).not.toContain(name);
    }
  });

  it("accepts only a well-formed result on the way back", () => {
    expect(isDispatchResult({ outcome: "DELIVERED", errorClass: "NONE", httpStatus: 200 })).toBe(true);
    expect(isDispatchResult({ outcome: "RETRYABLE", errorClass: "TIMEOUT", httpStatus: null })).toBe(true);
    // A class the gateway may not produce, a status outside the HTTP range, and shapes that are not
    // results at all. A 200 the worker cannot read is never recorded as a delivery.
    expect(isDispatchResult({ outcome: "DELIVERED", errorClass: "GATEWAY_UNAVAILABLE", httpStatus: 200 })).toBe(false);
    expect(isDispatchResult({ outcome: "DELIVERED", errorClass: "NONE", httpStatus: 42 })).toBe(false);
    expect(isDispatchResult({ outcome: "SENT", errorClass: "NONE", httpStatus: 200 })).toBe(false);
    expect(isDispatchResult(null)).toBe(false);
    expect(isDispatchResult("DELIVERED")).toBe(false);
  });

  it("agrees with the envelope module on the header names and the body cap", () => {
    expect([...ALLOWED_DISPATCH_HEADERS].sort()).toEqual(Object.values(HEADER).sort());
    expect(MAX_DISPATCH_BODY_BYTES).toBe(MAX_BODY_BYTES);
  });
});

describe("a well-formed dispatch is accepted, and split rather than re-parsed", () => {
  it("returns a host, a port and a path — not a URL the sender could re-read", () => {
    const parsed = parseDispatch(dispatch());
    expect(parsed.host).toBe("hooks.example.com");
    expect(parsed.port).toBe(REQUIRED_PORT);
    expect(parsed.pathWithQuery).toBe("/incoming");
    expect(parsed.body).toBe('{"id":"evt_1"}');
    expect(Object.keys(parsed.headers).sort()).toEqual([...ALLOWED_DISPATCH_HEADERS].sort());
    // Nothing that could be mistaken for a whole URL survives parsing.
    expect(Object.keys(parsed)).not.toContain("url");
  });

  it("keeps the query string, which is where a receiver's own token often lives", () => {
    expect(parseDispatch(dispatch({ url: "https://hooks.example.com/in?t=abc" })).pathWithQuery).toBe("/in?t=abc");
  });
});

describe("the shape rules", () => {
  it("refuses anything that is not a JSON object", () => {
    expect(refusalOf("not json")).toBe("BAD_CONTRACT");
    expect(refusalOf("[]")).toBe("BAD_CONTRACT");
    expect(refusalOf('"string"')).toBe("BAD_CONTRACT");
    expect(refusalOf("null")).toBe("BAD_CONTRACT");
  });

  it("refuses a fourth key, even a harmless-looking one", () => {
    // A caller speaking a dialect this gateway does not have is a caller to refuse, not to
    // accommodate. `method` and `timeout` are exactly the keys a proxy would grow.
    expect(refusalOf(dispatch({ method: "GET" }))).toBe("BAD_CONTRACT");
    expect(refusalOf(dispatch({ timeout: 60000 }))).toBe("BAD_CONTRACT");
    expect(refusalOf(dispatch({ followRedirects: true }))).toBe("BAD_CONTRACT");
  });

  it("refuses a missing key", () => {
    expect(refusalOf(JSON.stringify({ url: "https://a.example.com/x", body: "{}" }))).toBe("BAD_CONTRACT");
    expect(refusalOf(JSON.stringify({ body: "{}", headers: headers() }))).toBe("BAD_CONTRACT");
  });

  it("refuses a body that is not a string, or is over the envelope cap", () => {
    expect(refusalOf(dispatch({ body: { id: 1 } }))).toBe("BAD_CONTRACT");
    expect(refusalOf(dispatch({ body: "x".repeat(MAX_DISPATCH_BODY_BYTES + 1) }))).toBe("BAD_CONTRACT");
    // Exactly at the cap is fine: the cap is a limit, not an off-by-one.
    expect(parseDispatch(dispatch({ body: "x".repeat(MAX_DISPATCH_BODY_BYTES) })).body).toHaveLength(
      MAX_DISPATCH_BODY_BYTES,
    );
  });

  it("refuses a whole request over the read cap", () => {
    expect(refusalOf(dispatch({ url: `https://a.example.com/${"x".repeat(MAX_REQUEST_BYTES)}` }))).toBe("TOO_LARGE");
  });
});

describe("the header allow-list is the entire vocabulary", () => {
  it("refuses a header outside the list", () => {
    for (const smuggled of ["authorization", "cookie", "host", "x-forwarded-for", "content-length", "user-agent"]) {
      expect(refusalOf(dispatch({ headers: headers({ [smuggled]: "value" }) })), smuggled).toBe("BAD_CONTRACT");
    }
  });

  it("refuses a missing allow-listed header", () => {
    const partial = headers();
    delete partial["x-walaaplus-signature"];
    expect(refusalOf(dispatch({ headers: partial }))).toBe("BAD_CONTRACT");
  });

  it("refuses a header value with a newline, which is response splitting", () => {
    expect(refusalOf(dispatch({ headers: headers({ "x-walaaplus-event-id": "a\r\nx-evil: 1" }) }))).toBe("BAD_CONTRACT");
    expect(refusalOf(dispatch({ headers: headers({ "x-walaaplus-event-id": "a\nb" }) }))).toBe("BAD_CONTRACT");
    const withNul = `a${String.fromCharCode(0)}b`;
    expect(refusalOf(dispatch({ headers: headers({ "x-walaaplus-event-id": withNul }) }))).toBe("BAD_CONTRACT");
    const withDel = `a${String.fromCharCode(0x7f)}b`;
    expect(refusalOf(dispatch({ headers: headers({ "x-walaaplus-event-id": withDel }) }))).toBe("BAD_CONTRACT");
  });

  it("refuses an over-long or empty or non-string header value", () => {
    expect(refusalOf(dispatch({ headers: headers({ "x-walaaplus-attempt": "" }) }))).toBe("BAD_CONTRACT");
    expect(refusalOf(dispatch({ headers: headers({ "x-walaaplus-attempt": 1 }) }))).toBe("BAD_CONTRACT");
    expect(refusalOf(dispatch({ headers: headers({ "x-walaaplus-attempt": "9".repeat(MAX_HEADER_VALUE_BYTES + 1) }) }))).toBe(
      "BAD_CONTRACT",
    );
  });

  it("refuses headers that are not an object at all", () => {
    expect(refusalOf(dispatch({ headers: [] }))).toBe("BAD_CONTRACT");
    expect(refusalOf(dispatch({ headers: "x" }))).toBe("BAD_CONTRACT");
  });
});

describe("SSRF is enforced again here, at the process that has the route", () => {
  it("refuses every scheme but https", () => {
    for (const url of [
      "http://hooks.example.com/x",
      "file:///etc/passwd",
      "gopher://hooks.example.com/x",
      "ftp://hooks.example.com/x",
      "ws://hooks.example.com/x",
    ]) {
      expect(refusalOf(dispatch({ url })), url).toBe("BAD_CONTRACT");
    }
  });

  it("refuses every port but 443", () => {
    for (const port of [80, 22, 25, 8443, 3000, 6379]) {
      expect(refusalOf(dispatch({ url: `https://hooks.example.com:${port}/x` })), String(port)).toBe("BAD_CONTRACT");
    }
    // And the seam that lets a test reach a local receiver is a PORT LIST, not a policy: it cannot
    // be used to allow a scheme, a literal or a private address.
    const seam = { allowedPorts: [8443, 8444] } as const;
    expect(parseDispatch(dispatch({ url: "https://hooks.example.com:8443/x" }), seam).port).toBe(8443);
    expect(parseDispatch(dispatch({ url: "https://hooks.example.com:8444/x" }), seam).port).toBe(8444);
    expect(refusalOf(dispatch({ url: "https://hooks.example.com:8445/x" }), seam)).toBe("BAD_CONTRACT");
    expect(refusalOf(dispatch({ url: "http://hooks.example.com:8443/x" }), seam)).toBe("BAD_CONTRACT");
    expect(refusalOf(dispatch({ url: "https://127.0.0.1:8443/x" }), seam)).toBe("BAD_CONTRACT");
  });

  it("refuses an IP literal, in either family", () => {
    for (const url of [
      "https://93.184.216.34/x",
      "https://127.0.0.1/x",
      "https://10.0.0.1/x",
      "https://169.254.169.254/latest/meta-data/",
      "https://[::1]/x",
      "https://[2606:2800:220:1:248:1893:25c8:1946]/x",
    ]) {
      expect(refusalOf(dispatch({ url })), url).toBe("BAD_CONTRACT");
    }
  });

  it("refuses an internal-looking name", () => {
    for (const host of ["localhost", "db.local", "vault.internal", "wiki.intranet", "foo.localhost", "x.home.arpa"]) {
      expect(refusalOf(dispatch({ url: `https://${host}/x` })), host).toBe("BAD_CONTRACT");
    }
  });

  it("refuses userinfo, whitespace and control characters", () => {
    expect(refusalOf(dispatch({ url: "https://user:pass@hooks.example.com/x" }))).toBe("BAD_CONTRACT");
    expect(refusalOf(dispatch({ url: "https://hooks.example.com/x y" }))).toBe("BAD_CONTRACT");
    expect(refusalOf(dispatch({ url: "https://hooks.example.com/x\r\nHost: evil" }))).toBe("BAD_CONTRACT");
  });

  it("refuses an empty, non-string or unparseable url", () => {
    expect(refusalOf(dispatch({ url: "" }))).toBe("BAD_CONTRACT");
    expect(refusalOf(dispatch({ url: 42 }))).toBe("BAD_CONTRACT");
    expect(refusalOf(dispatch({ url: "not a url" }))).toBe("BAD_CONTRACT");
  });
});

describe("worker-to-gateway authentication", () => {
  const secret = loadGatewaySecret(ENV);

  it("insists on 32 bytes, as hex or base64", () => {
    expect(secret).toHaveLength(GATEWAY_SECRET_BYTES);
    expect(loadGatewaySecret({ WEBHOOK_GATEWAY_SECRET: randomBytes(32).toString("base64") } as never)).toHaveLength(32);
  });

  it("refuses an absent, blank or wrong-length secret, naming the variable and no value", () => {
    for (const source of [{}, { WEBHOOK_GATEWAY_SECRET: "" }, { WEBHOOK_GATEWAY_SECRET: "   " }]) {
      expect(() => loadGatewaySecret(source as never)).toThrow(GatewaySecretUnavailableError);
      expect(gatewaySecretAvailable(source as never)).toBe(false);
    }
    for (const bad of [randomBytes(31).toString("hex"), randomBytes(33).toString("hex"), "abc", "!!!"]) {
      let message = "";
      try {
        loadGatewaySecret({ WEBHOOK_GATEWAY_SECRET: bad } as never);
      } catch (err) {
        message = (err as Error).message;
      }
      expect(message).toContain("WEBHOOK_GATEWAY_SECRET");
      // Not even a prefix of the rejected value appears in the message.
      expect(message).not.toContain(bad.slice(0, 8));
    }
  });

  it("is not the encryption key, and does not read that variable", () => {
    // A deployment that set only the encryption key must NOT end up with an authenticated hop.
    expect(gatewaySecretAvailable({ INTEGRATION_ENCRYPTION_KEY: SECRET } as never)).toBe(false);
  });

  it("accepts its own signature and rejects every alteration of it", () => {
    const body = dispatch();
    const ts = "1700000000";
    const signature = signGatewayRequest(secret, ts, body);
    const base = { timestamp: ts, signature, body, nowSeconds: Number(ts), source: ENV };

    expect(verifyGatewayRequest(base)).toBe(true);
    // A different body under the same signature: the bytes are what is signed.
    expect(verifyGatewayRequest({ ...base, body: body.replace("evt_1", "evt_2") })).toBe(false);
    // A different timestamp under the same signature.
    expect(verifyGatewayRequest({ ...base, timestamp: "1700000001", nowSeconds: 1700000001 })).toBe(false);
    // A truncated, extended, or entirely absent signature.
    expect(verifyGatewayRequest({ ...base, signature: signature.slice(0, -1) })).toBe(false);
    expect(verifyGatewayRequest({ ...base, signature: `${signature}0` })).toBe(false);
    expect(verifyGatewayRequest({ ...base, signature: undefined })).toBe(false);
    expect(verifyGatewayRequest({ ...base, timestamp: undefined })).toBe(false);
  });

  it("rejects a signature made with a different secret", () => {
    const body = dispatch();
    const ts = "1700000000";
    const other = loadGatewaySecret({ WEBHOOK_GATEWAY_SECRET: "b".repeat(64) } as never);
    expect(
      verifyGatewayRequest({
        timestamp: ts,
        signature: signGatewayRequest(other, ts, body),
        body,
        nowSeconds: Number(ts),
        source: ENV,
      }),
    ).toBe(false);
  });

  it("bounds replay with a timestamp window, in both directions", () => {
    const body = dispatch();
    const ts = "1700000000";
    const signature = signGatewayRequest(secret, ts, body);
    const at = (now: number) => verifyGatewayRequest({ timestamp: ts, signature, body, nowSeconds: now, source: ENV });

    expect(at(Number(ts) + GATEWAY_TIMESTAMP_TOLERANCE_SECONDS)).toBe(true);
    expect(at(Number(ts) - GATEWAY_TIMESTAMP_TOLERANCE_SECONDS)).toBe(true);
    expect(at(Number(ts) + GATEWAY_TIMESTAMP_TOLERANCE_SECONDS + 1)).toBe(false);
    expect(at(Number(ts) - GATEWAY_TIMESTAMP_TOLERANCE_SECONDS - 1)).toBe(false);
  });

  it("rejects a timestamp that is not a plain integer", () => {
    const body = dispatch();
    for (const ts of ["not-a-number", "17e9", "-1700000000", "1700000000.5", ""]) {
      expect(
        verifyGatewayRequest({ timestamp: ts, signature: "v1=x", body, nowSeconds: 1700000000, source: ENV }),
        ts,
      ).toBe(false);
    }
  });

  it("reports an unconfigured deployment as a different answer from an inauthentic caller", () => {
    // The gateway turns these into SECRET_UNAVAILABLE and BAD_AUTH respectively. Both refuse and
    // both send nothing; conflating them would hide a deployment fault behind an auth failure.
    expect(() =>
      verifyGatewayRequest({ timestamp: "1700000000", signature: "v1=x", body: "{}", source: {} as never }),
    ).toThrow(GatewaySecretUnavailableError);
  });

  it("puts its headers under a distinct prefix from the destination-facing ones", () => {
    const destinationFacing = Object.values(HEADER) as string[];
    for (const name of Object.values(GATEWAY_HEADER)) {
      expect(destinationFacing, name).not.toContain(name);
    }
  });
});

describe("the path is a constant", () => {
  it("is /dispatch, and nothing builds it from input", () => {
    expect(DISPATCH_PATH).toBe("/dispatch");
  });
});
