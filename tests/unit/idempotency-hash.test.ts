import { describe, expect, it } from "vitest";
import { canonicalJson, hashPayload } from "@/server/ledger/idempotency";

describe("canonicalJson / hashPayload", () => {
  it("is independent of object key order at every depth", () => {
    const a = { b: 1, a: { y: [1, { k: 2, j: 3 }], x: "s" } };
    const b = { a: { x: "s", y: [1, { j: 3, k: 2 }] }, b: 1 };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
    expect(hashPayload(a)).toBe(hashPayload(b));
  });

  it("preserves array order (arrays are ordered data)", () => {
    expect(hashPayload({ ops: [1, 2] })).not.toBe(hashPayload({ ops: [2, 1] }));
  });

  it("treats undefined properties as absent", () => {
    expect(hashPayload({ a: 1, b: undefined })).toBe(hashPayload({ a: 1 }));
  });

  it("distinguishes different payloads and produces a 64-char sha256 hex", () => {
    const h1 = hashPayload({ amount: 5 });
    const h2 = hashPayload({ amount: 6 });
    expect(h1).not.toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
  });

  it("handles primitives and null", () => {
    expect(canonicalJson(null)).toBe("null");
    expect(canonicalJson("x")).toBe('"x"');
    expect(canonicalJson(3)).toBe("3");
  });
});
