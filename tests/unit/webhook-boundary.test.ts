import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Where outbound HTTP is allowed to live, and where it is not.
 *
 * Prompt 1's rule was "nothing leaves the machine". Prompt 2 opened exactly one door, so the rule
 * became a shape: **one module makes requests, the worker calls it, and nothing else can.**
 *
 * Prompt 3 moved the door. The request is now made by a separate service — `src/egress` — that
 * holds no secrets, and the worker's only remaining client addresses that service over an internal
 * network at a constant path. So the shape under `src/server` is unchanged in kind and narrower in
 * fact: one module, and what it can reach is one origin from configuration rather than anywhere.
 *
 * This file keeps the application-side half of that rule. The gateway's own half — no database
 * client, no secrets, no logging, no test seam in production — is
 * `tests/unit/webhook-egress-boundary.test.ts`.
 *
 * A webhook is a request to somebody else's server. Made from a route handler it would be a
 * cashier's till waiting on a receiver's timeout — which is not a hypothetical failure mode, it is
 * the normal one.
 */

const ROOT = join(import.meta.dirname, "..", "..");

function filesUnder(dir: string, match = /\.tsx?$/): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...filesUnder(full, match));
    else if (match.test(entry.name)) out.push(full);
  }
  return out;
}

/** Comments explain what is deliberately absent, so the scans read code only. */
function code(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/^\s*\/\/\/.*$/gm, "");
}

const HTTP_CLIENT = /\bfetch\s*\(|\baxios\b|from\s+"node:https?"|from\s+"node:http"|\bXMLHttpRequest\b|\bWebSocket\b/;

/**
 * The one module under `src/server` allowed to hold an HTTP client, named here so the allowance is
 * explicit. It talks to the egress gateway and to nothing else: the origin comes from
 * configuration and the path is a compile-time constant.
 */
const GATEWAY_CLIENT = join("src", "server", "integrations", "webhooks", "gateway.ts");

describe("exactly one module sends an outbound request", () => {
  const serverFiles = filesUnder(join(ROOT, "src", "server"));

  it("has files to check", () => {
    expect(serverFiles.length).toBeGreaterThan(20);
  });

  it("finds an HTTP client in the gateway client and nowhere else under src/server", () => {
    const holders = serverFiles
      .filter((f) => HTTP_CLIENT.test(code(readFileSync(f, "utf8"))))
      .map((f) => relative(ROOT, f).replace(/\\/g, "/"));
    expect(holders).toEqual([GATEWAY_CLIENT.replace(/\\/g, "/")]);
  });

  it("gives that client one destination, and it is not a merchant's", () => {
    // The distinction Prompt 3 rests on: this client cannot be pointed at an arbitrary host. The
    // origin is configuration, the path is a constant, and a destination URL is DATA inside the
    // body rather than an address this code can be asked to use.
    const gateway = code(readFileSync(join(ROOT, GATEWAY_CLIENT), "utf8"));
    expect(gateway).toContain("path: DISPATCH_PATH");
    expect(gateway).toContain("WEBHOOK_GATEWAY_URL");
  });

  it("still finds no HTTP client, queue or timer in the events module", () => {
    // Prompt 1's guarantee, unchanged: `emitIntegrationEvent` writes an outbox row and stops.
    const events = code(readFileSync(join(ROOT, "src", "server", "integrations", "events.ts"), "utf8"));
    expect(events).not.toMatch(HTTP_CLIENT);
    expect(events).not.toMatch(/\bsetTimeout\s*\(|\bsetInterval\s*\(|pg-boss/);
  });
});

describe("nothing a request handler can reach makes a request", () => {
  const appFiles = filesUnder(join(ROOT, "src", "app"));

  it("has files to check", () => {
    expect(appFiles.length).toBeGreaterThan(20);
  });

  it("holds no HTTP client of its own in any server-side app file", () => {
    /*
     * Client components legitimately call `fetch` — that is a browser calling this product's own
     * API. What is being excluded is a SERVER-side fetch, so files marked "use client" are exempt
     * and the exemption is asserted rather than assumed.
     */
    for (const file of appFiles) {
      const text = readFileSync(file, "utf8");
      if (/^\s*["']use client["']/m.test(text)) continue;
      expect(code(text), relative(ROOT, file)).not.toMatch(HTTP_CLIENT);
    }
  });

  it("imports neither the gateway client nor the delivery runner, anywhere", () => {
    // The structural rule. A route that imported either could send from a request.
    for (const file of appFiles) {
      const text = code(readFileSync(file, "utf8"));
      expect(text, relative(ROOT, file)).not.toMatch(/webhooks\/gateway/);
      expect(text, relative(ROOT, file)).not.toMatch(/webhooks\/transport/);
      expect(text, relative(ROOT, file)).not.toMatch(/webhooks\/delivery/);
    }
  });

  it("lets the route reach only the destination service, which queues and does not send", () => {
    const route = readFileSync(join(ROOT, "src", "app", "api", "staff", "webhooks", "route.ts"), "utf8");
    expect(route).toContain("webhooks/destinations");
    // And the service it calls holds no client either.
    const service = code(readFileSync(join(ROOT, "src", "server", "integrations", "webhooks", "destinations.ts"), "utf8"));
    expect(service).not.toMatch(HTTP_CLIENT);
  });
});

describe("the worker is the caller", () => {
  it("registers the delivery job and reaches the runner", () => {
    const job = readFileSync(join(ROOT, "src", "worker", "jobs", "webhook-delivery.ts"), "utf8");
    expect(job).toContain("runDueDeliveries");
    const index = readFileSync(join(ROOT, "src", "worker", "index.ts"), "utf8");
    expect(index).toContain("registerWebhookDeliveryJob");
  });

  it("logs counts, never an address or an error string", () => {
    const job = code(readFileSync(join(ROOT, "src", "worker", "jobs", "webhook-delivery.ts"), "utf8"));
    // No logging at all from the job; the worker's own logger prints the summary object only.
    expect(job).not.toMatch(/console\./);
    expect(job).not.toMatch(/endpointCipher|signingSecret|\.url\b/);
  });
});

describe("no secret or response body can reach a store", () => {
  const webhookFiles = filesUnder(join(ROOT, "src", "server", "integrations", "webhooks"));

  it("never writes a decrypted URL or secret into a column", () => {
    /*
     * `endpointCipher` and `signingSecretCipher` are written from the OUTPUT of `encryptSecret`, and
     * nothing else is. A scan for an assignment of a decrypted value to one of those columns.
     */
    for (const file of webhookFiles) {
      const text = code(readFileSync(file, "utf8"));
      expect(text, relative(ROOT, file)).not.toMatch(/endpointCipher:\s*(safe\.href|url|input\.url)/);
      expect(text, relative(ROOT, file)).not.toMatch(/signingSecretCipher:\s*signingSecret\b/);
    }
  });

  it("never logs", () => {
    for (const file of webhookFiles) {
      expect(code(readFileSync(file, "utf8")), relative(ROOT, file)).not.toMatch(/console\.|process\.stdout/);
    }
  });

  it("keeps the receiver's response out of the worker entirely", () => {
    /*
     * Stronger than it was, and for free. The worker no longer sees a receiver's response at all:
     * what comes back over the internal hop is a bounded classification, and the only thing this
     * module reads from it is `outcome`, `errorClass` and `httpStatus`. The assertion that the
     * receiver's body never leaves the socket now lives with the code that holds the socket, in
     * `tests/unit/webhook-egress-boundary.test.ts`.
     */
    const gateway = readFileSync(join(ROOT, GATEWAY_CLIENT), "utf8");
    expect(gateway).toContain("isDispatchResult");
    expect(gateway).not.toMatch(/responseBody|res\.headers/);
  });
});

describe("the schema has nowhere to put a body, a header or an address", () => {
  const schema = readFileSync(join(ROOT, "prisma", "schema.prisma"), "utf8");

  function model(name: string): string {
    const start = schema.indexOf(`model ${name} {`);
    expect(start, name).toBeGreaterThan(-1);
    return schema.slice(start, schema.indexOf("\n}", start));
  }

  it("has no JSON column in any of the three webhook tables", () => {
    for (const name of ["WebhookDestination", "WebhookDelivery", "WebhookDeliveryAttempt"]) {
      expect(model(name), name).not.toMatch(/\bJson\b/);
    }
  });

  it("has no column that could hold a response, a header or an error message", () => {
    const FORBIDDEN = /responseBody|requestBody|\bheaders\b|\bpayload\b|errorMessage|rawError|\bmetadata\b|\bconfig\b/i;
    for (const name of ["WebhookDestination", "WebhookDelivery", "WebhookDeliveryAttempt"]) {
      expect(model(name), name).not.toMatch(FORBIDDEN);
    }
  });

  it("holds the endpoint only as ciphertext and a hostname", () => {
    const destination = model("WebhookDestination");
    expect(destination).toContain("endpointCipher");
    expect(destination).toContain("endpointHost");
    // No plaintext URL column, under any of the obvious names.
    expect(destination).not.toMatch(/^\s+(url|endpointUrl|targetUrl|webhookUrl)\s/m);
    expect(destination).not.toMatch(/signingSecret\s+String/);
  });
});
