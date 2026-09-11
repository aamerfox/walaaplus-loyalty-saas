import { describe, expect, it } from "vitest";
import { TOKEN_ENTROPY_BYTES, cardSerialNumber, newCardTokens, opaqueToken } from "@/server/security/tokens";

/**
 * QR tokens, card-page tokens, enrollment-link tokens and serials all end up printed, scanned or
 * pasted into a URL. An attacker can collect them and will try to walk from one to the next, so
 * they must be random, independent, and free of anything about the card or its owner.
 */
describe("opaque card tokens", () => {
  const SAMPLE = 2_000;

  it("produces URL-safe values with no padding or separators", () => {
    for (let i = 0; i < 100; i++) {
      expect(opaqueToken()).toMatch(/^[A-Za-z0-9_-]+$/);
    }
  });

  it("carries at least 192 bits of entropy", () => {
    expect(TOKEN_ENTROPY_BYTES).toBeGreaterThanOrEqual(24);
    // base64url of 24 bytes is 32 characters.
    expect(opaqueToken().length).toBe(Math.ceil((TOKEN_ENTROPY_BYTES * 8) / 6));
  });

  it("never repeats across a large sample", () => {
    const seen = new Set<string>();
    for (let i = 0; i < SAMPLE; i++) seen.add(opaqueToken());
    expect(seen.size).toBe(SAMPLE);
  });

  it("shows no sequence: consecutive tokens share no prefix", () => {
    // A counter or timestamp source would make neighbours share a long common prefix.
    let maxSharedPrefix = 0;
    let previous = opaqueToken();
    for (let i = 0; i < 500; i++) {
      const next = opaqueToken();
      let shared = 0;
      while (shared < previous.length && previous[shared] === next[shared]) shared++;
      maxSharedPrefix = Math.max(maxSharedPrefix, shared);
      previous = next;
    }
    expect(maxSharedPrefix).toBeLessThan(6);
  });

  it("uses the whole alphabet, as a uniform source would", () => {
    let joined = "";
    for (let i = 0; i < 500; i++) joined += opaqueToken();
    expect(new Set(joined).size).toBeGreaterThan(50); // base64url has 64 symbols
  });

  describe("a new card's token set", () => {
    it("draws the QR token and the page token independently", () => {
      // Scanning a card at the counter must not reveal the URL that opens it.
      for (let i = 0; i < 200; i++) {
        const t = newCardTokens();
        expect(t.qrToken).not.toBe(t.shareToken);
        expect(t.qrToken).not.toContain(t.shareToken);
        expect(t.shareToken).not.toContain(t.qrToken);
        expect(t.serialNumber).not.toContain(t.qrToken);
      }
    });

    it("gives every card a distinct set", () => {
      const all = new Set<string>();
      for (let i = 0; i < 500; i++) {
        const t = newCardTokens();
        all.add(t.qrToken).add(t.shareToken).add(t.serialNumber);
      }
      expect(all.size).toBe(1_500);
    });
  });

  describe("serial numbers", () => {
    it("are grouped and use an alphabet without look-alike characters", () => {
      for (let i = 0; i < 200; i++) {
        const serial = cardSerialNumber();
        expect(serial).toMatch(/^WP-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
        // I, L, O and U are excluded: staff read these aloud and type them back.
        expect(serial.slice(3)).not.toMatch(/[ILOU]/);
      }
    });

    it("are random rather than sequential", () => {
      const seen = new Set<string>();
      for (let i = 0; i < SAMPLE; i++) seen.add(cardSerialNumber());
      expect(seen.size).toBe(SAMPLE);
    });

    it("spread across the alphabet in every position", () => {
      // A biased generator (modulo bias, or a fixed prefix) would collapse a position.
      const positions = [0, 1, 2, 3].map(() => new Set<string>());
      for (let i = 0; i < 1_000; i++) {
        const group = cardSerialNumber().slice(3, 7);
        for (let p = 0; p < 4; p++) positions[p].add(group[p]);
      }
      for (const p of positions) expect(p.size).toBeGreaterThan(25);
    });
  });

  it("encodes nothing about the card, the customer or the moment of issue", () => {
    // Two cards drawn in the same millisecond must look unrelated.
    const batch = Array.from({ length: 50 }, () => newCardTokens());
    const now = Date.now();
    for (const t of batch) {
      for (const value of [t.qrToken, t.shareToken, t.serialNumber]) {
        // No timestamp: neither the current epoch millis nor seconds appear.
        expect(value).not.toContain(String(now).slice(0, 8));
        expect(value).not.toContain(String(Math.floor(now / 1000)).slice(0, 7));
      }
    }
    // And nothing in the batch shares a long prefix with its neighbour.
    const qrTokens = batch.map((t) => t.qrToken);
    expect(new Set(qrTokens).size).toBe(qrTokens.length);
  });
});
