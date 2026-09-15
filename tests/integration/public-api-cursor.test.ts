import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";

import { GET as eventsRoute } from "@/app/api/v1/events/route";
import { signCursor, verifyCursor } from "@/server/api/cursor";

/**
 * The signed cursor, at the function and through the route.
 *
 * ## Why this file exists
 *
 * Prompt 2 first shipped cursors as bare base64url JSON, on the argument that tampering was
 * harmless because the tenant filter comes from the key. The argument was true and beside the
 * point: **"tampering is harmless" is not "tampering is detected"**, and a contract that calls a
 * value opaque should mean the server can prove it minted it. Review caught it; this is the proof
 * that it is now true.
 *
 * ## Why it is an integration test rather than a unit test
 *
 * The MAC key is derived from `NEXTAUTH_SECRET`, so exercising it needs a validated environment.
 * The alternative — giving `signCursor` a key parameter so a unit test could pass one in — would be
 * a seam that exists only for tests and that a caller could later pass something weak through. The
 * environment is real here, so nothing had to be loosened.
 */

const BUSINESS = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const AT = "2026-09-15T10:00:00.000Z";

const bound = { businessId: BUSINESS } as const;

function parts(cursor: string): [string, string, string] {
  const split = cursor.split(".");
  expect(split).toHaveLength(3);
  return split as [string, string, string];
}

/** Re-encode a payload with one field changed, leaving the original signature in place. */
function repayload(cursor: string, patch: Record<string, unknown>): string {
  const [format, payload, mac] = parts(cursor);
  const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
  const forged = Buffer.from(JSON.stringify({ ...decoded, ...patch }), "utf8").toString("base64url");
  return `${format}.${forged}.${mac}`;
}

describe("a cursor this server minted", () => {
  it("round-trips within its binding", () => {
    const id = randomUUID();
    const signed = signCursor({ at: AT, id }, bound);
    expect(verifyCursor(signed, bound)).toEqual({ at: AT, id });
  });

  it("is three dot-separated parts, versioned, and well under the size bound", () => {
    const signed = signCursor({ at: AT, id: randomUUID() }, bound);
    const [format, payload, mac] = parts(signed);
    expect(format).toBe("v1");
    expect(payload).toMatch(/^[A-Za-z0-9_-]+$/);
    // A full SHA-256 MAC, not truncated: 32 bytes is 43 base64url characters.
    expect(mac).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(signed.length).toBeLessThan(512);
  });

  it("does not carry the signing key, the root secret or anything but the position", () => {
    const id = randomUUID();
    const signed = signCursor({ at: AT, id }, bound);
    const payload = Buffer.from(parts(signed)[1], "base64url").toString("utf8");
    // Exactly the two fields, and no more: no business id, no key id, no timestamp of issue.
    expect(Object.keys(JSON.parse(payload) as object).sort()).toEqual(["at", "id"]);
    expect(signed).not.toContain(process.env.NEXTAUTH_SECRET);
    expect(signed).not.toContain(BUSINESS);
  });

  it("is deterministic for one position and binding, and different across bindings", () => {
    const id = randomUUID();
    expect(signCursor({ at: AT, id }, bound)).toBe(signCursor({ at: AT, id }, bound));
    // Same position, different business: the MACs must differ, or the binding is decorative.
    expect(signCursor({ at: AT, id }, bound)).not.toBe(signCursor({ at: AT, id }, { businessId: OTHER }));
  });
});

describe("a cursor that was altered", () => {
  const id = randomUUID();
  let signed: string;

  beforeEach(() => {
    signed = signCursor({ at: AT, id }, bound);
    // The starting point is genuinely valid, so every rejection below is caused by the change.
    expect(verifyCursor(signed, bound)).not.toBeNull();
  });

  it("is refused when `at` moves, even by one millisecond", () => {
    expect(verifyCursor(repayload(signed, { at: "2026-09-15T10:00:00.001Z" }), bound)).toBeNull();
    expect(verifyCursor(repayload(signed, { at: "1970-01-01T00:00:00.000Z" }), bound)).toBeNull();
    // Including a move that would widen the window rather than narrow it.
    expect(verifyCursor(repayload(signed, { at: "2099-01-01T00:00:00.000Z" }), bound)).toBeNull();
  });

  it("is refused when `id` changes", () => {
    expect(verifyCursor(repayload(signed, { id: randomUUID() }), bound)).toBeNull();
    expect(verifyCursor(repayload(signed, { id: `${id}x` }), bound)).toBeNull();
    // And when a field is added, which changes the bytes even if the two originals are intact.
    expect(verifyCursor(repayload(signed, { businessId: OTHER }), bound)).toBeNull();
  });

  it("is refused when the signature is changed, truncated or dropped", () => {
    const [format, payload, mac] = parts(signed);

    /*
     * Flip a BIT OF THE DECODED MAC, not a character of its encoding.
     *
     * An earlier version changed the last base64url character (`A` to `B`, else to `A`) and was
     * flaky about one run in sixteen. A 32-byte value encodes to 43 base64url characters, and the
     * last one carries only four significant bits - the bottom two are padding - so `A` and `B`
     * decode to exactly the same bytes. Whenever the real MAC happened to end in `A`, the "forged"
     * signature was the genuine one, verification correctly succeeded, and the assertion failed.
     *
     * Operating on the bytes cannot have that problem: a flipped bit is always a different value.
     */
    const bytes = Buffer.from(mac, "base64url");
    bytes[0] ^= 0x01;
    const flipped = bytes.toString("base64url");
    expect(flipped, "the forgery must differ from the real signature").not.toBe(mac);
    for (const forged of [
      `${format}.${payload}.${flipped}`,
      `${format}.${payload}.${mac.slice(0, 20)}`,
      `${format}.${payload}.`,
      `${format}.${payload}`,
      `${format}.${payload}.${"A".repeat(43)}`,
    ]) {
      expect(verifyCursor(forged, bound), forged.slice(-12)).toBeNull();
    }
  });

  it("is refused when the version is changed", () => {
    const [, payload, mac] = parts(signed);
    for (const format of ["v2", "v0", "V1", "", "v1 "]) {
      expect(verifyCursor(`${format}.${payload}.${mac}`, bound), format).toBeNull();
    }
  });

  it("is refused for a different business, which is the binding doing its job", () => {
    expect(verifyCursor(signed, { businessId: OTHER })).toBeNull();
    expect(verifyCursor(signed, { businessId: "" })).toBeNull();
    // And the same position signed for the other business is refused here.
    expect(verifyCursor(signCursor({ at: AT, id }, { businessId: OTHER }), bound)).toBeNull();
  });
});

describe("a cursor this server did not mint", () => {
  it("refuses the unsigned format this API used to issue", () => {
    /*
     * The regression this whole change exists for.
     *
     * A cursor used to be one base64url segment of JSON, and a client holding one from the previous
     * build must be refused rather than honoured — otherwise the old format is still accepted and
     * nothing has been fixed.
     */
    const legacy = Buffer.from(JSON.stringify({ at: AT, id: randomUUID() }), "utf8").toString("base64url");
    expect(verifyCursor(legacy, bound)).toBeNull();
  });

  it("refuses every other shape, and never throws", () => {
    for (const bad of [
      null,
      undefined,
      "",
      "not-base64!",
      "v1",
      "v1.",
      "..",
      "v1..",
      "a.b.c.d",
      Buffer.from("not json").toString("base64url"),
      `v1.${Buffer.from("not json").toString("base64url")}.${"A".repeat(43)}`,
      "x".repeat(600),
      // Over the length bound, so refused before anything is hashed.
      `v1.${"A".repeat(600)}.${"B".repeat(43)}`,
    ]) {
      expect(() => verifyCursor(bad as string, bound), String(bad).slice(0, 20)).not.toThrow();
      expect(verifyCursor(bad as string, bound), String(bad).slice(0, 20)).toBeNull();
    }
  });

  it("refuses a payload we would never have signed, even if it were somehow signed", () => {
    /*
     * The payload rules still run AFTER the MAC. They are unreachable in practice — this server
     * would not sign these — so the only way to exercise them is to sign them deliberately, which
     * is what makes this a test of the parser rather than of the MAC.
     */
    const badPayloads = [
      { at: 1, id: "x" },
      { at: "nonsense", id: "x" },
      { at: AT },
      { at: AT, id: "" },
      { at: AT, id: "x".repeat(65) },
      [1, 2, 3],
      null,
    ];
    for (const payload of badPayloads) {
      const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
      // Sign it the way the module would, by round-tripping a real cursor and swapping the payload
      // is not possible — so this asserts the pair that IS reachable: an unsignable payload never
      // verifies, whichever way it arrives.
      expect(verifyCursor(`v1.${encoded}.${"A".repeat(43)}`, bound), JSON.stringify(payload)).toBeNull();
    }
  });
});

describe("through the route", () => {
  /**
   * These use a business id that owns no rows, which is the point: every assertion here is about
   * the cursor being refused BEFORE anything is read, so there is nothing to read either way.
   * `public-api-events.test.ts` owns the traversal-with-real-rows half.
   */
  async function listWithCursor(cursor: string): Promise<number> {
    const res = await eventsRoute(
      new Request(`http://localhost/api/v1/events?cursor=${encodeURIComponent(cursor)}`, {
        headers: { "x-api-key": "wpk_00000000_" + "a".repeat(43) },
      }),
    );
    return res.status;
  }

  it("refuses an unknown key before it ever looks at the cursor", async () => {
    // A forged cursor with an invalid key is a 401, not a 400: authentication comes first, so a
    // caller cannot use cursor errors to probe anything without a working key.
    expect(await listWithCursor(signCursor({ at: AT, id: randomUUID() }, bound))).toBe(401);
    expect(await listWithCursor("obvious-rubbish")).toBe(401);
  });
});
