import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import {
  API_VERSION,
  ApiErrorCode,
  apiError,
  apiSuccess,
  apiUnauthorized,
  cursorPage,
  decodeCursor,
  DEFAULT_PAGE_SIZE,
  encodeCursor,
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
  it("round-trips a cursor", () => {
    const cursor = { at: "2026-09-15T10:00:00.000Z", id: "abc" };
    expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor);
  });

  it("returns null for anything it did not produce, and never throws", () => {
    for (const bad of [
      null,
      undefined,
      "",
      "not-base64!",
      Buffer.from("not json").toString("base64url"),
      Buffer.from(JSON.stringify({ at: 1, id: "x" })).toString("base64url"),
      Buffer.from(JSON.stringify({ at: "nonsense", id: "x" })).toString("base64url"),
      Buffer.from(JSON.stringify({ at: "2026-09-15T10:00:00.000Z" })).toString("base64url"),
      Buffer.from(JSON.stringify({ at: "2026-09-15T10:00:00.000Z", id: "" })).toString("base64url"),
      Buffer.from(JSON.stringify({ at: "2026-09-15T10:00:00.000Z", id: "x".repeat(65) })).toString("base64url"),
      Buffer.from(JSON.stringify([1, 2, 3])).toString("base64url"),
      "x".repeat(600),
    ]) {
      expect(() => decodeCursor(bad as string), String(bad).slice(0, 20)).not.toThrow();
      expect(decodeCursor(bad as string), String(bad).slice(0, 20)).toBeNull();
    }
  });

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
    const full = cursorPage(rows, 3, (r) => ({ at: r.at, id: r.id }));
    expect(full.items).toHaveLength(3);
    expect(full.page.count).toBe(3);
    expect(full.page.nextCursor).not.toBeNull();
    expect(decodeCursor(full.page.nextCursor)).toEqual({ at: rows[2].at, id: rows[2].id });
    // A total over a growing table is a second scan and is wrong by the time it is read.
    expect(full.page).not.toHaveProperty("total");

    const last = cursorPage(rows.slice(0, 2), 3, (r) => ({ at: r.at, id: r.id }));
    expect(last.page.nextCursor).toBeNull();
    expect(last.items).toHaveLength(2);
  });

  it("handles an empty page without inventing a cursor", () => {
    const empty = cursorPage([] as { id: string; at: string }[], 3, (r) => ({ at: r.at, id: r.id }));
    expect(empty.items).toEqual([]);
    expect(empty.page).toEqual({ nextCursor: null, count: 0 });
  });
});

describe("the key cannot reach anywhere it must not", () => {
  const apiFiles = filesUnder(join(ROOT, "src", "server", "api"));

  it("has the modules this prompt builds, and no route", () => {
    expect(apiFiles.map((f) => relative(join(ROOT, "src", "server", "api"), f)).sort()).toEqual([
      "auth.ts",
      "contract.ts",
      "keys.ts",
      "rate-limit.ts",
    ]);
  });

  it("serves nothing yet — there is no /api/v1", () => {
    // Prompt 1 builds the key and deliberately not the surface.
    expect(existsSync(join(ROOT, "src", "app", "api", "v1"))).toBe(false);
  });

  it("never logs, anywhere on the key path", () => {
    for (const file of apiFiles) {
      expect(code(readFileSync(file, "utf8")), relative(ROOT, file)).not.toMatch(
        /console\.|process\.stdout|process\.stderr/,
      );
    }
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

  it("is not imported by anything under src/app yet", () => {
    // Prompt 2 mounts the route. Until then nothing in the app tree reaches the key path, and a
    // test that says so is what keeps "core only" true.
    for (const file of filesUnder(join(ROOT, "src", "app"))) {
      expect(code(readFileSync(file, "utf8")), relative(ROOT, file)).not.toMatch(/server\/api\//);
    }
  });
});
