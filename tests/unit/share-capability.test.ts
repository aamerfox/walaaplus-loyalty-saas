import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import en from "../../messages/en.json";
import ar from "../../messages/ar.json";
import { SHARE_TOKEN_BYTES, shareTokenDigest } from "@/server/share/share-links";

/**
 * The invitation capability, and the wording of the page it opens.
 *
 * Two unrelated-looking things in one file, because they are the two ways this feature could go
 * wrong without anybody noticing: a token that is not actually random, and a promise the product
 * cannot keep.
 */

describe("the capability is a secret, and is stored as a digest", () => {
  it("is 256 bits, which is why guessing is not a threat model", () => {
    // 32 bytes. The endpoint that resolves one is deliberately not rate limited — a per-address
    // limit would mean storing the address of everybody who opens an invitation — and this number
    // is the entire reason that is safe.
    expect(SHARE_TOKEN_BYTES).toBe(32);
  });

  it("stores sha256 of the raw value, and nothing that reverses to it", () => {
    const raw = "Yy8kQ2Jd-Nn4mWkTgqfHlPz0XcVbNmAsDfGhJkLqWeR";
    const digest = shareTokenDigest(raw);
    expect(digest).toBe(createHash("sha256").update(raw, "utf8").digest("hex"));
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    // The obvious sanity check, and the one that would catch somebody "optimising" the digest away.
    expect(digest).not.toContain(raw);
    expect(raw).not.toContain(digest);
  });

  it("is deterministic, because the lookup is a digest comparison", () => {
    expect(shareTokenDigest("abc")).toBe(shareTokenDigest("abc"));
    expect(shareTokenDigest("abc")).not.toBe(shareTokenDigest("abd"));
  });
});

describe("the share URL puts the capability where no server can see it", () => {
  /*
   * The rule this pins is small and load-bearing: the token goes after the `#`. A path or query
   * token is written into every access log, proxy log and error report between the browser and the
   * server — and into the `Referer` header of whatever the visitor opens next. A fragment is not
   * sent with a request at all.
   *
   * The builder reads configuration through `env()`, so the shape is asserted here rather than the
   * function called; `tests/integration/share-links.test.ts` exercises the real one.
   */
  const SHAPE = /^https?:\/\/[^/]+\/share#[A-Za-z0-9_-]+$/;

  it("accepts a fragment URL", () => {
    expect("https://zademi.example/share#Yy8kQ2Jd-Nn4mWkTgqfHlPz0Xc").toMatch(SHAPE);
  });

  it("rejects every shape that would reach a server log", () => {
    for (const bad of [
      "https://zademi.example/share/Yy8kQ2Jd",
      "https://zademi.example/share?t=Yy8kQ2Jd",
      "https://zademi.example/share?token=Yy8kQ2Jd#",
      "https://zademi.example/s/Yy8kQ2Jd",
    ]) {
      expect(bad, `${bad} would put the capability in a request`).not.toMatch(SHAPE);
    }
  });

  it("carries no locale prefix, because a forwarded link outlives the language of whoever opens it", () => {
    expect("https://zademi.example/ar/share#abc").not.toMatch(SHAPE);
  });
});

describe("the invitation page promises nothing it cannot keep", () => {
  /*
   * There is no referral reward policy — who earns what, when, and within what limits is an open
   * decision (D15). Until one exists, no string on this page or on a wallet pass may imply that
   * sharing a link earns anybody anything. A wallet pass in particular is the one surface a customer
   * cannot re-read a correction on.
   *
   * This is a wording test rather than a code test because the failure mode is entirely in the copy:
   * every line below would ship, render and pass every other check.
   */
  const FORBIDDEN_EN = /\breward|\bearn\b|\bbonus\b|\bfree\b|\bdiscount\b|\bcashback\b|\bpoints? for\b|\bcredit\b/i;
  const FORBIDDEN_AR = /مكافأ|مكافآ|اربح|تربح|خصم|مجان|رصيد مجاني|نقاط مقابل/;

  function leaves(node: unknown, path: string[] = []): [string, string][] {
    if (typeof node === "string") return [[path.join("."), node]];
    if (node && typeof node === "object") {
      return Object.entries(node as Record<string, unknown>).flatMap(([k, v]) => leaves(v, [...path, k]));
    }
    return [];
  }

  it("says invite and share, never earn", () => {
    for (const [locale, messages, forbidden] of [
      ["en", en.Share, FORBIDDEN_EN],
      ["ar", ar.Share, FORBIDDEN_AR],
    ] as const) {
      for (const [key, value] of leaves(messages)) {
        expect(value, `${locale} Share.${key} promises a reward: "${value}"`).not.toMatch(forbidden);
      }
    }
  });

  it("tells a newcomer where cards actually come from", () => {
    // The counter, not a form on this page. B7 option 3 is why, and a visitor who is not told
    // assumes the link is broken.
    expect(en.Share.howToJoin).toMatch(/staff/i);
    expect(ar.Share.howToJoin).toMatch(/موظف/);
  });

  it("offers no enrolment, lookup or account wording anywhere on the page", () => {
    for (const [locale, messages] of [
      ["en", en.Share],
      ["ar", ar.Share],
    ] as const) {
      for (const [key, value] of leaves(messages)) {
        expect(value, `${locale} Share.${key}`).not.toMatch(/sign ?up|register|enrol|enroll|create an account/i);
        expect(value, `${locale} Share.${key}`).not.toMatch(/سجّل الآن|أنشئ حساب|تسجيل عضوية/);
      }
    }
  });
});
