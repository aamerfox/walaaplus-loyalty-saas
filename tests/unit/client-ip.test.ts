import { describe, expect, it } from "vitest";
import { clientIpFrom, normalizeClientIp } from "@/server/http";

/**
 * Phase 0.3 security remediation, blocker 2.
 *
 * `X-Forwarded-For` is a request header like any other. Unless something in front of the app
 * overwrites it, a caller sets it to a different value on every request and every per-address
 * rate limit becomes decoration. These tests pin the two rules that follow from that:
 *
 *   1. Without trust, the headers are ignored ENTIRELY — no address at all, never a forgeable one.
 *   2. With trust, the value taken is the LAST hop, the one our own proxy set. Anything earlier
 *      arrived with the request and is attacker-controlled.
 */
const headers = (h: Record<string, string>) => (name: string) => h[name] ?? null;

describe("client address from forwarding headers", () => {
  describe("untrusted (the default)", () => {
    it("ignores every forwarding header, however plausible", () => {
      const spoofed = headers({
        "x-forwarded-for": "203.0.113.7",
        "x-real-ip": "203.0.113.8",
      });
      expect(clientIpFrom(spoofed, false)).toBeNull();
    });

    it("gives an attacker no way to present themselves as many clients", () => {
      const seen = new Set<string | null>();
      for (let i = 0; i < 50; i++) {
        seen.add(clientIpFrom(headers({ "x-forwarded-for": `198.51.100.${i}` }), false));
      }
      // Fifty forged addresses collapse to one outcome: no address, hence no per-address window.
      expect([...seen]).toEqual([null]);
    });
  });

  describe("trusted (behind the proxy in deploy/Caddyfile)", () => {
    it("takes the single value a replacing proxy sets", () => {
      expect(clientIpFrom(headers({ "x-forwarded-for": "203.0.113.7" }), true)).toBe("203.0.113.7");
    });

    it("takes the LAST hop, so a client-supplied prefix is discarded", () => {
      // What a forging client produces when the proxy APPENDS instead of replacing:
      // their own value first, the address the proxy saw last.
      expect(clientIpFrom(headers({ "x-forwarded-for": "6.6.6.6, 203.0.113.7" }), true)).toBe("203.0.113.7");
      expect(clientIpFrom(headers({ "x-forwarded-for": "1.1.1.1, 2.2.2.2, 203.0.113.9" }), true)).toBe("203.0.113.9");
    });

    it("falls back to x-real-ip only when there is no forwarded-for", () => {
      expect(clientIpFrom(headers({ "x-real-ip": "203.0.113.5" }), true)).toBe("203.0.113.5");
      expect(clientIpFrom(headers({ "x-forwarded-for": "203.0.113.7", "x-real-ip": "6.6.6.6" }), true)).toBe("203.0.113.7");
    });

    it("returns null when nothing usable is present", () => {
      expect(clientIpFrom(headers({}), true)).toBeNull();
      expect(clientIpFrom(headers({ "x-forwarded-for": "" }), true)).toBeNull();
      expect(clientIpFrom(headers({ "x-forwarded-for": "unknown" }), true)).toBeNull();
    });

    it("refuses values that are not addresses, so junk cannot become a rate-limit key", () => {
      for (const junk of ["not-an-ip", "999.1.1.1", "1.2.3", "<script>", "127.0.0.1.evil.com", "  "]) {
        expect(clientIpFrom(headers({ "x-forwarded-for": junk }), true), junk).toBeNull();
      }
    });
  });

  describe("normalisation", () => {
    it("strips the port from IPv4 and bracketed IPv6", () => {
      expect(normalizeClientIp("203.0.113.7:44321")).toBe("203.0.113.7");
      expect(normalizeClientIp("[2001:db8::1]:44321")).toBe("2001:db8::1");
    });

    it("keeps bare IPv6 and lower-cases it, so one client is one key", () => {
      expect(normalizeClientIp("2001:DB8::1")).toBe("2001:db8::1");
      expect(normalizeClientIp("::1")).toBe("::1");
    });

    it("rejects empty, unknown and out-of-range values", () => {
      expect(normalizeClientIp(null)).toBeNull();
      expect(normalizeClientIp(undefined)).toBeNull();
      expect(normalizeClientIp("")).toBeNull();
      expect(normalizeClientIp("unknown")).toBeNull();
      expect(normalizeClientIp("256.1.1.1")).toBeNull();
      expect(normalizeClientIp("[2001:db8::1")).toBeNull();
    });
  });
});
