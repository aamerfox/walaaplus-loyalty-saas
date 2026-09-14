import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The egress gateway's structural guarantees — the ones a runtime test cannot make.
 *
 * The whole topology rests on a division that is a property of the *dependency graph*, not of any
 * behaviour you can observe by sending a request:
 *
 *   the worker holds the secrets and has no route to the Internet;
 *   the gateway has the route and holds none of the secrets.
 *
 * A test that sends a webhook and sees it arrive proves neither half. These scans do: if the
 * gateway ever imports a database client, or the worker ever regains a direct HTTP client, the
 * division is gone whether or not anything misbehaves that day.
 */

const ROOT = join(import.meta.dirname, "..", "..");
const EGRESS = join(ROOT, "src", "egress");

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

function read(...parts: string[]): string {
  return readFileSync(join(ROOT, ...parts), "utf8");
}

/** Every `from "…"` in a file. */
function importsOf(text: string): string[] {
  return [...code(text).matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]);
}

const egressFiles = filesUnder(EGRESS);

describe("the gateway has nothing worth stealing", () => {
  it("has files to check", () => {
    expect(egressFiles.map((f) => relative(EGRESS, f)).sort()).toEqual([
      "auth.ts",
      "contract.ts",
      "dispatch.ts",
      "index.ts",
      "outcome.ts",
      "server.ts",
    ]);
  });

  it("imports no database client, driver, queue or ORM anywhere", () => {
    /*
     * The single most important assertion in this file. The gateway is the one process with a
     * route out; it must not be able to read or write a row even if something inside it is
     * compromised, and the cheapest way to guarantee that is for the client not to be in the
     * image at all. `scripts/build-egress.mjs` marks nothing external, so an import here would
     * also bundle a query engine into a container whose job is to open one socket.
     */
    const FORBIDDEN = /@prisma\/client|\.prisma\/client|\bpg-boss\b|from\s+"pg"|\bPrismaClient\b|server\/db\b/;
    for (const file of egressFiles) {
      expect(code(readFileSync(file, "utf8")), relative(ROOT, file)).not.toMatch(FORBIDDEN);
    }
  });

  it("never names a secret it is not given", () => {
    // It decrypts nothing and signs nothing for a destination, so it has no use for either of
    // these — and no compose file passes them to it. A reference here would be the first step to
    // someone adding one.
    for (const file of egressFiles) {
      const text = code(readFileSync(file, "utf8"));
      expect(text, relative(ROOT, file)).not.toMatch(/INTEGRATION_ENCRYPTION_KEY|NEXTAUTH_SECRET|DATABASE_URL/);
    }
  });

  it("reaches into the application only for the address rules, and for nothing else", () => {
    /*
     * One shared module, deliberately: the SSRF policy is enforced twice, in two processes, and
     * two copies of it would be two things to keep in step. `address.ts` is pure — `node:dns` and
     * `node:net` — so importing it pulls in no application surface.
     */
    const reached = new Set<string>();
    for (const file of egressFiles) {
      for (const specifier of importsOf(readFileSync(file, "utf8"))) {
        if (specifier.includes("/server/") || specifier.startsWith("@/server")) reached.add(specifier);
      }
    }
    expect([...reached]).toEqual(["../server/integrations/webhooks/address"]);
    expect(importsOf(read("src", "server", "integrations", "webhooks", "address.ts")).sort()).toEqual([
      "node:dns",
      "node:net",
    ]);
  });

  it("is built as a self-contained bundle, with nothing resolved at runtime", () => {
    const build = read("scripts", "build-egress.mjs");
    expect(build).toContain("src/egress/index.ts");
    // No `external:` list at all: if a future import pulls in a package, the build embeds it and
    // the assertions above are what catch the ones that must never be embedded.
    expect(code(build)).not.toMatch(/external\s*:/);
  });
});

describe("the gateway writes nothing down", () => {
  it("has no logging call in any module that sees a URL, a body or a header", () => {
    for (const name of ["server.ts", "dispatch.ts", "contract.ts", "auth.ts", "outcome.ts"]) {
      const text = code(read("src", "egress", name));
      expect(text, name).not.toMatch(/console\.|process\.stdout|process\.stderr/);
    }
  });

  it("logs only a bounded classification from the entry point", () => {
    const index = code(read("src", "egress", "index.ts"));
    // What the one per-dispatch line may contain. Anything that identifies a business, a delivery,
    // an event or a destination is absent — there is no such value in scope at that point.
    expect(index).toMatch(/outcome:/);
    expect(index).toMatch(/errorClass:/);
    expect(index).not.toMatch(/\burl\b|\bbody\b|\bheaders\b|deliveryId|eventId|businessId|host\b|address/);
  });

  it("keeps the response body out of every return path", () => {
    const dispatch = read("src", "egress", "dispatch.ts");
    // The only thing taken from a response is its status code.
    expect(dispatch).toContain("res.statusCode");
    expect(dispatch).not.toMatch(/body:\s*(chunks|data|text)/);
    expect(dispatch).not.toMatch(/toString\("utf8"\)/);
  });

  it("keeps the resolved address out of every return path", () => {
    // `makeGuardedLookup` offers an `onResolved` hook. Passing one here would be the natural way
    // for an IP to reach a log or a column; nothing does.
    expect(code(read("src", "egress", "dispatch.ts"))).toContain("makeGuardedLookup(options.lookup, undefined,");
  });
});

describe("the production entry point uses no test seam", () => {
  /*
   * Three seams exist so the delivery tests can reach a local HTTPS receiver: a `lookup`, an
   * `addressPolicy` whose default IS the real rule, and `allowedPorts` whose default is `[443]`.
   * Each is a way to soften the address rules, so each is asserted unused in the one place that
   * runs in production.
   */
  const index = code(read("src", "egress", "index.ts"));

  it("passes no lookup, no address policy, no certificate and no port override", () => {
    for (const seam of ["lookup", "addressPolicy", "allowedPorts", "ca:"]) {
      expect(index, seam).not.toContain(seam);
    }
  });

  it("starts the real server, so the seams it omits are the real defaults", () => {
    expect(index).toContain("startEgressServer");
  });
});

describe("the worker keeps the secrets and loses the socket", () => {
  const HTTP_CLIENT = /\bfetch\s*\(|\baxios\b|from\s+"node:https?"|from\s+"node:http"|\bXMLHttpRequest\b|\bWebSocket\b/;

  it("no longer has a transport module at all", () => {
    expect(() => read("src", "server", "integrations", "webhooks", "transport.ts")).toThrow();
  });

  it("holds an HTTP client in exactly one module under src/server, and it addresses the gateway", () => {
    const holders = filesUnder(join(ROOT, "src", "server"))
      .filter((f) => HTTP_CLIENT.test(code(readFileSync(f, "utf8"))))
      .map((f) => relative(ROOT, f).replace(/\\/g, "/"));
    expect(holders).toEqual(["src/server/integrations/webhooks/gateway.ts"]);
  });

  it("gives that client a constant path and an origin from configuration only", () => {
    const gateway = code(read("src", "server", "integrations", "webhooks", "gateway.ts"));
    /*
     * The structural reason the worker cannot be pointed at a merchant endpoint: the request path
     * is the imported constant, and the origin comes from `WEBHOOK_GATEWAY_URL`. The destination
     * URL travels INSIDE the JSON body, as data for the gateway to validate.
     */
    expect(gateway).toContain("path: DISPATCH_PATH");
    expect(gateway).not.toMatch(/path:\s*(input|url|safe|raw)/);
    expect(gateway).toContain("WEBHOOK_GATEWAY_URL");
  });

  it("signs the destination's body on this side, so the secret never crosses the hop", () => {
    const gateway = code(read("src", "server", "integrations", "webhooks", "gateway.ts"));
    expect(gateway).toContain("signPayload(input.signingSecret");
    // And the signing secret is not one of the things put into the dispatch object.
    const dispatchLiteral = gateway.slice(gateway.indexOf("JSON.stringify({"), gateway.indexOf("});", gateway.indexOf("JSON.stringify({")));
    expect(dispatchLiteral).not.toContain("signingSecret");
  });

  it("lets the delivery runner reach the gateway and nothing lower", () => {
    const delivery = code(read("src", "server", "integrations", "webhooks", "delivery.ts"));
    expect(delivery).toMatch(/from\s+"\.\/gateway"/);
    expect(delivery).not.toMatch(HTTP_CLIENT);
    // The DNS seams are gone from this path entirely: there is no longer a parameter here that
    // could soften the address rules for a production caller.
    expect(delivery).not.toMatch(/addressPolicy|LookupFn|\bca\b/);
  });
});

describe("nothing a request handler can reach knows the gateway exists", () => {
  const appFiles = filesUnder(join(ROOT, "src", "app"));

  it("has files to check", () => {
    expect(appFiles.length).toBeGreaterThan(20);
  });

  it("imports no egress module and no gateway client, anywhere", () => {
    for (const file of appFiles) {
      const text = code(readFileSync(file, "utf8"));
      expect(text, relative(ROOT, file)).not.toMatch(/egress\//);
      expect(text, relative(ROOT, file)).not.toMatch(/webhooks\/gateway/);
    }
  });

  it("names the gateway secret nowhere in the application surface", () => {
    // `web` is not on the gateway's network and is given no gateway secret by any compose file.
    // A reference in a page or a route would be the first sign of that changing.
    for (const file of appFiles) {
      expect(code(readFileSync(file, "utf8")), relative(ROOT, file)).not.toContain("WEBHOOK_GATEWAY_SECRET");
    }
  });
});
