import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";
import {
  API_VERSION,
  ApiErrorCode,
  apiError,
  apiSuccess,
  apiUnauthorized,
  cursorPage,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  pageSize,
} from "@/server/api/contract";

/**
 * The public API's wire contract, and the structural rules around the key.
 *
 * Everything here runs without a database, which suits what is being checked: a shape agreed before
 * anything serves it, and a set of source scans that say the key cannot reach the places it must
 * never reach.
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

function code(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/^\s*\/\/\/.*$/gm, "");
}

describe("the response envelope", () => {
  it("carries a version on success and on failure", () => {
    expect(apiSuccess({ a: 1 })).toEqual({ apiVersion: "v1", data: { a: 1 } });
    expect(apiError(ApiErrorCode.NOT_FOUND, "gone")).toEqual({
      apiVersion: "v1",
      error: { code: "NOT_FOUND", message: "gone" },
    });
    expect(API_VERSION).toBe("v1");
  });

  it("omits the page block when there is no page", () => {
    expect(apiSuccess({ a: 1 })).not.toHaveProperty("page");
    expect(apiSuccess([], { nextCursor: null, count: 0 })).toHaveProperty("page");
  });

  it("gives one unauthorized answer, with no way to say which condition applied", () => {
    // The function takes no argument. There is no parameter through which a future edit could pass
    // "revoked" or "expired" to a caller.
    expect(apiUnauthorized.length).toBe(0);
    const body = apiUnauthorized();
    expect(body.error.code).toBe("UNAUTHORIZED");
    expect(JSON.stringify(body)).not.toMatch(/revoked|expired|unknown|malformed|missing/i);
  });
});

describe("cursor pagination", () => {
  /*
   * Signing and verification are NOT tested here.
   *
   * A cursor is now authenticated with a key derived from `NEXTAUTH_SECRET`, so exercising it means
   * a validated environment — which the unit project deliberately does not have. Rather than give
   * `signCursor` a key parameter so a unit test could pass one in (a seam that exists only for
   * tests, and one a caller could later pass something weak through), the cursor tests live in
   * `tests/integration/public-api-cursor.test.ts` where the environment is real.
   *
   * What stays here is the part that has no key in it: the page assembler.
   */

  it("clamps the page size, and never errors on a silly one", () => {
    expect(pageSize(undefined)).toBe(DEFAULT_PAGE_SIZE);
    expect(pageSize(null)).toBe(DEFAULT_PAGE_SIZE);
    expect(pageSize("nonsense")).toBe(DEFAULT_PAGE_SIZE);
    expect(pageSize(0)).toBe(DEFAULT_PAGE_SIZE);
    expect(pageSize(-5)).toBe(DEFAULT_PAGE_SIZE);
    expect(pageSize(10)).toBe(10);
    expect(pageSize("10")).toBe(10);
    expect(pageSize(10.9)).toBe(10);
    // The cap is the product's, not the caller's: an unbounded page is an unbounded query.
    expect(pageSize(1_000_000)).toBe(MAX_PAGE_SIZE);
    expect(pageSize(Number.POSITIVE_INFINITY)).toBe(DEFAULT_PAGE_SIZE);
    expect(pageSize(Number.NaN)).toBe(DEFAULT_PAGE_SIZE);
  });

  it("builds a page from size + 1 rows and reports no total", () => {
    const rows = Array.from({ length: 4 }, (_, i) => ({ id: `id-${i}`, at: `2026-09-1${i}T00:00:00.000Z` }));
    // The signer is injected, which is what keeps this function free of key material.
    const sign = (c: { at: string; id: string }) => `signed(${c.at},${c.id})`;

    const full = cursorPage(rows, 3, (r) => ({ at: r.at, id: r.id }), sign);
    expect(full.items).toHaveLength(3);
    expect(full.page.count).toBe(3);
    // The cursor names the LAST row of the page returned, not of the rows fetched.
    expect(full.page.nextCursor).toBe(`signed(${rows[2].at},${rows[2].id})`);
    // A total over a growing table is a second scan and is wrong by the time it is read.
    expect(full.page).not.toHaveProperty("total");

    const last = cursorPage(rows.slice(0, 2), 3, (r) => ({ at: r.at, id: r.id }), sign);
    expect(last.page.nextCursor).toBeNull();
    expect(last.items).toHaveLength(2);
  });

  it("handles an empty page without inventing a cursor", () => {
    const empty = cursorPage([] as { id: string; at: string }[], 3, (r) => ({ at: r.at, id: r.id }), () => "never");
    expect(empty.items).toEqual([]);
    expect(empty.page).toEqual({ nextCursor: null, count: 0 });
  });

  it("never signs a cursor for a page that has no next page", () => {
    // A cursor minted for a final page would be a value the client is invited to follow into
    // nothing, and one more signed string in the world than there needed to be.
    let signed = 0;
    cursorPage([{ id: "a", at: "2026-09-15T00:00:00.000Z" }], 3, (r) => ({ at: r.at, id: r.id }), () => {
      signed += 1;
      return "x";
    });
    expect(signed).toBe(0);
  });
});

describe("the key cannot reach anywhere it must not", () => {
  const apiFiles = filesUnder(join(ROOT, "src", "server", "api"));

  it("has the modules these prompts build, and nothing else", () => {
    expect(apiFiles.map((f) => relative(join(ROOT, "src", "server", "api"), f)).sort()).toEqual([
      "auth.ts",
      "contract.ts",
      // Prompt 2 adds the event reader, the request pipeline and the signed cursor.
      "cursor.ts",
      "events.ts",
      "keys.ts",
      "rate-limit.ts",
      "request.ts",
    ]);
  });

  it("serves exactly two public routes, both GET, and no write verb anywhere under /api/v1", () => {
    const v1 = join(ROOT, "src", "app", "api", "v1");
    expect(existsSync(v1)).toBe(true);

    const routes = filesUnder(v1).map((f) => relative(v1, f).split(sep).join("/"));
    expect(routes.sort()).toEqual(["events/[eventId]/route.ts", "events/route.ts"]);

    for (const file of filesUnder(v1)) {
      const text = code(readFileSync(file, "utf8"));
      const verbs = [...text.matchAll(/export\s+async\s+function\s+([A-Z]+)/g)].map((m) => m[1]);
      // GET, once, and nothing else. A write verb here would be a write endpoint in a read-only API,
      // and an OPTIONS handler would be the first half of CORS.
      expect(verbs, relative(ROOT, file)).toEqual(["GET"]);
      for (const forbidden of ["POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]) {
        expect(text, `${relative(ROOT, file)} must not export ${forbidden}`).not.toMatch(
          new RegExp(`export\\s+(async\\s+)?(function|const)\\s+${forbidden}\\b`),
        );
      }
    }
  });

  it("signs cursors with a derived, domain-separated key and never with a raw secret", () => {
    /*
     * The properties a reviewer should be able to check without running anything:
     *
     *  - the HMAC key is DERIVED, so `NEXTAUTH_SECRET` never appears as the key itself;
     *  - the derivation is labelled, so this key cannot collide with the rate-limit pepper that is
     *    derived from the same root;
     *  - the signed message is domain-separated and carries the binding;
     *  - the comparison is constant-time;
     *  - the integration encryption key is NOT used — see the file's own note on why.
     */
    const cursor = readFileSync(join(ROOT, "src", "server", "api", "cursor.ts"), "utf8");
    const body = code(cursor);

    expect(body).toMatch(/createHmac\("sha256", env\(\)\.NEXTAUTH_SECRET\)\.update\(DERIVATION_LABEL\)/);
    expect(body).toMatch(/const DERIVATION_LABEL = "walaaplus:api:v1:cursor"/);
    expect(body).toMatch(/const MESSAGE_DOMAIN = "walaaplus:api:v1:cursor:events"/);
    expect(body).toMatch(/canonical\(\[MESSAGE_DOMAIN, FORMAT, binding\.businessId, payload\]\)/);
    expect(body).toMatch(/timingSafeEqual\(presented, expected\)/);

    // The root secret is never the HMAC key, and never the message either.
    expect(body).not.toMatch(/createHmac\([^)]*cursorKey\(\)[^)]*NEXTAUTH_SECRET/);
    expect(body).not.toContain("INTEGRATION_ENCRYPTION_KEY");

    // And no test-only door into the key.
    expect(body).not.toMatch(/ForTests|__test|process\.env\./);
  });

  it("verifies the cursor before any row is read, and against the authenticated context", () => {
    const route = code(readFileSync(join(ROOT, "src", "app", "api", "v1", "events", "route.ts"), "utf8"));
    const verifyAt = route.indexOf("verifyCursor(");
    const readAt = route.indexOf("listApiEvents(");
    expect(verifyAt).toBeGreaterThan(-1);
    expect(readAt).toBeGreaterThan(-1);
    // Source order is not proof of runtime order on its own, but the 400 between them is: the
    // handler returns before it reaches the read. The integration suite proves the behaviour.
    expect(verifyAt, "the cursor is verified before the events are read").toBeLessThan(readAt);
    // The binding comes from the guard's context, never from the request.
    expect(route).toMatch(/verifyCursor\(rawCursor, \{ businessId: guard\.ctx\.businessId \}\)/);
  });

  it("sends no CORS header, from any public route or the pipeline they share", () => {
    /*
     * A key in a browser is a key published, so this is server-to-server.
     *
     * The absence is checked in the source rather than only over the wire, because a response
     * assertion proves today's behaviour and this proves nobody wrote the header at all.
     */
    const files = [...filesUnder(join(ROOT, "src", "app", "api", "v1")), join(ROOT, "src", "server", "api", "request.ts")];
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      expect(text.toLowerCase(), relative(ROOT, file)).not.toMatch(/access-control-allow/);
    }
  });

  it("marks every public response uncacheable", () => {
    // A response selected by a secret header must never sit in a shared cache.
    const pipeline = readFileSync(join(ROOT, "src", "server", "api", "request.ts"), "utf8");
    expect(pipeline).toMatch(/"cache-control":\s*"no-store"/);
    expect(pipeline).toMatch(/vary:\s*"X-API-Key"/);
  });

  it("never logs on the key-material path, and narrows the one log it does keep", () => {
    /*
     * The rule is not "no logging" — a 500 that leaves no trace is unoperable. The rule is that
     * **nothing that could hold key material may be logged**, which means: the modules that touch a
     * raw key log nothing at all, and the one module that reports an unexpected failure narrows the
     * thrown value to a name and a message before it goes anywhere.
     *
     * An earlier version of this test forbade `console.` under `src/server/api` outright. That is a
     * blunt proxy: it would have been satisfied by moving the same statement into a route file,
     * which protects nothing.
     */
    const pipeline = join(ROOT, "src", "server", "api", "request.ts");
    for (const file of apiFiles.filter((f) => f !== pipeline)) {
      expect(code(readFileSync(file, "utf8")), relative(ROOT, file)).not.toMatch(
        /console\.|process\.stdout|process\.stderr/,
      );
    }

    const text = code(readFileSync(pipeline, "utf8"));
    const logs = [...text.matchAll(/console\.\w+\([^;]*\)/g)].map((m) => m[0]);
    expect(logs, "one log statement, in the error mapper").toHaveLength(1);
    // The narrowing itself: an Error becomes {name, message}, anything else becomes its typeof.
    expect(logs[0]).toMatch(/e instanceof Error \? \{ name: e\.name, message: e\.message \}/);
    expect(logs[0]).toMatch(/\{ type: typeof e \}/);
    // And nothing that could be a key goes near it.
    expect(logs[0]).not.toMatch(/ctx|key|digest|header|req\b|url/i);
  });

  it("returns a raw key from exactly two functions, and from the value it just generated", () => {
    const keys = readFileSync(join(ROOT, "src", "server", "api", "keys.ts"), "utf8");
    // `apiKey:` is the field that carries the value. It appears once, in the one place that mints.
    const occurrences = code(keys).match(/apiKey:\s*minted\.raw/g) ?? [];
    expect(occurrences).toHaveLength(1);
    // And nothing reads the digest column back out into a view.
    expect(code(keys)).not.toMatch(/keyDigest:\s*true/);
  });

  it("keeps the digest out of every projection an owner can reach", () => {
    const keys = code(readFileSync(join(ROOT, "src", "server", "api", "keys.ts"), "utf8"));
    const select = keys.slice(keys.indexOf("const KEY_SELECT"), keys.indexOf("} as const;", keys.indexOf("const KEY_SELECT")));
    expect(select).not.toContain("keyDigest");
    expect(select).toContain("keyPrefix");
  });

  it("puts no key, digest or prefix into an audit metadata payload beyond the public prefix", () => {
    const keys = code(readFileSync(join(ROOT, "src", "server", "api", "keys.ts"), "utf8"));
    // The only metadata fields are a name, the public prefix and a provenance id.
    expect(keys).not.toMatch(/metadata:\s*\{[^}]*digest/i);
    expect(keys).not.toMatch(/metadata:\s*\{[^}]*minted/i);
    expect(keys).not.toMatch(/metadata:\s*\{[^}]*apiKey/i);
  });

  it("consumes a rate-limit window only from an authenticated context", () => {
    const limiter = code(readFileSync(join(ROOT, "src", "server", "api", "rate-limit.ts"), "utf8"));
    /*
     * The signature is the guarantee: the only way to hold an `ApiContext` is to have been handed
     * one by `authenticateApiKey`, so a window cannot be opened for a value that was never a key.
     * Had this taken a string, an attacker's guesses would each become a row.
     */
    expect(limiter).toMatch(/consumeApiRateLimit\(ctx: ApiContext\)/);
    expect(limiter).toMatch(/ctx\.apiKeyId/);
    expect(limiter).not.toMatch(/rawKey|keyDigest|apiKey:/);
  });

  it("never puts a key in a URL", () => {
    for (const file of apiFiles) {
      const text = code(readFileSync(file, "utf8"));
      expect(text, relative(ROOT, file)).not.toMatch(/searchParams.*api[_-]?key/i);
      expect(text, relative(ROOT, file)).not.toMatch(/\?api[_-]?key=/i);
    }
  });

  it("is reachable from exactly four files in the app tree, named one by one", () => {
    /*
     * Prompt 1's version of this said "nothing under src/app imports the key path", which is what
     * kept "core only" honest while there was no surface. Prompt 2 mounts one, so the rule becomes
     * an allow-list — still a closed set, and still failing the gate the moment a fifth file
     * reaches for a key.
     */
    const allowed = new Set(
      [
        "src/app/api/v1/events/route.ts",
        "src/app/api/v1/events/[eventId]/route.ts",
        "src/app/api/staff/api-keys/route.ts",
        // The owner screen, for the key LIST. Metadata only: `KEY_SELECT` has no digest in it.
        "src/app/[locale]/business/integrations/page.tsx",
      ].map((p) => p.split("/").join(sep)),
    );

    const importers = filesUnder(join(ROOT, "src", "app"))
      .filter((file) => /server\/api\//.test(code(readFileSync(file, "utf8"))))
      .map((file) => relative(ROOT, file));

    expect(importers.sort()).toEqual([...allowed].sort());
  });

  it("keeps the raw key out of client-side storage entirely", () => {
    /*
     * The one moment a key exists outside the database is the response to create or rotate. The
     * screen holds it in React state and offers a copy button; **nothing writes it anywhere**.
     *
     * Every API on this list survives a page reload, which is exactly what a show-once value must
     * not do — and the browser's own form-value restoration is why the input that would have held
     * it does not exist.
     */
    const client = readFileSync(
      join(ROOT, "src", "app", "[locale]", "business", "integrations", "ApiKeysClient.tsx"),
      "utf8",
    );
    for (const api of [
      "localStorage",
      "sessionStorage",
      "indexedDB",
      "document.cookie",
      "history.pushState",
      "history.replaceState",
      "URLSearchParams",
    ]) {
      expect(code(client), `ApiKeysClient must not use ${api}`).not.toContain(api);
    }
    // The value reaches exactly two places: component state, and the clipboard the owner asked for.
    expect(code(client)).toMatch(/setSecret\(/);
    expect(code(client)).toMatch(/navigator\.clipboard\.writeText\(secret\)/);
  });

  it("puts no key material into the owner screen's server-rendered props", () => {
    const page = code(
      readFileSync(join(ROOT, "src", "app", "[locale]", "business", "integrations", "page.tsx"), "utf8"),
    );
    // The list is metadata. The prefix is public and is how an owner recognises a row.
    expect(page).toContain("keyPrefix: row.keyPrefix");
    expect(page).not.toMatch(/keyDigest|apiKey:|minted/);
  });
});
