import { describe, expect, it, vi } from "vitest";
import {
  addressProblem,
  assertSafeWebhookUrl,
  makeGuardedLookup,
  MAX_URL_LENGTH,
  resolveSafeAddress,
  UnsafeWebhookAddressError,
  type LookupFn,
} from "@/server/integrations/webhooks/address";

/**
 * Server-side request forgery, and the reason the second check exists.
 *
 * Every case below is something a merchant-supplied URL could be. None of them contacts anything:
 * the shape rules are pure, and the resolver is a function the test supplies.
 */

/** A fake resolver, so DNS answers are chosen by the test rather than by the network. */
function resolver(answers: { address: string; family: number }[] | Error): LookupFn {
  return ((_host: string, _opts: unknown, cb: (e: NodeJS.ErrnoException | null, a?: unknown) => void) => {
    if (answers instanceof Error) cb(answers as NodeJS.ErrnoException);
    else cb(null, answers);
  }) as LookupFn;
}

describe("the URL has to be the right shape", () => {
  it("accepts an ordinary HTTPS endpoint", () => {
    const safe = assertSafeWebhookUrl("https://hooks.example.com/walaaplus?v=1");
    expect(safe.host).toBe("hooks.example.com");
    expect(safe.port).toBe(443);
    expect(safe.pathWithQuery).toBe("/walaaplus?v=1");
  });

  it("keeps a non-default port", () => {
    expect(assertSafeWebhookUrl("https://hooks.example.com:8443/x").port).toBe(8443);
  });

  it("drops a fragment, which never reaches a server anyway", () => {
    expect(assertSafeWebhookUrl("https://hooks.example.com/x#frag").href).not.toContain("#");
  });

  it("refuses anything but https", () => {
    for (const url of [
      "http://hooks.example.com/x",
      "ftp://hooks.example.com/x",
      "file:///etc/passwd",
      "gopher://hooks.example.com/",
      "javascript:alert(1)",
      "data:text/plain,hello",
    ]) {
      expect(() => assertSafeWebhookUrl(url), url).toThrow(UnsafeWebhookAddressError);
    }
  });

  it("refuses credentials in the URL", () => {
    // They end up in logs, in error strings and in screenshots.
    for (const url of ["https://user:pass@hooks.example.com/x", "https://user@hooks.example.com/x"]) {
      expect(() => assertSafeWebhookUrl(url), url).toThrow(/username or password/);
    }
  });

  it("refuses an IP literal, v4 and v6, public or not", () => {
    // A literal bypasses the DNS policy question, so it is refused before the question is asked.
    for (const url of ["https://93.184.216.34/x", "https://[2606:2800:220:1::]/x", "https://127.0.0.1/x"]) {
      expect(() => assertSafeWebhookUrl(url), url).toThrow(/name, not an IP address|private or loopback/);
    }
  });

  it("refuses loopback and private names", () => {
    for (const url of [
      "https://localhost/x",
      "https://api.localhost/x",
      "https://printer.local/x",
      "https://vault.internal/x",
      "https://wiki.intranet/x",
      "https://thing.home.arpa/x",
    ]) {
      expect(() => assertSafeWebhookUrl(url), url).toThrow(UnsafeWebhookAddressError);
    }
  });

  it("refuses a single-label host, which only this network can resolve", () => {
    expect(() => assertSafeWebhookUrl("https://router/x")).toThrow(/fully qualified/);
  });

  it("refuses whitespace and control characters", () => {
    // A newline in a URL is a request-splitting attempt, not a typo.
    for (const url of ["https://hooks.example.com/x\nHost: evil", "https://hooks.example.com/ x", "https://hooks.example.com/\0"]) {
      expect(() => assertSafeWebhookUrl(url), JSON.stringify(url)).toThrow(UnsafeWebhookAddressError);
    }
  });

  it("refuses an absurdly long address", () => {
    expect(() => assertSafeWebhookUrl(`https://hooks.example.com/${"a".repeat(MAX_URL_LENGTH)}`)).toThrow(/too long/);
  });

  it("refuses an empty or unparseable value", () => {
    for (const url of ["", "not a url", "https://", "://x"]) {
      expect(() => assertSafeWebhookUrl(url), JSON.stringify(url)).toThrow(UnsafeWebhookAddressError);
    }
  });
});

describe("the resolved address has to be public", () => {
  it("names every reserved IPv4 range", () => {
    for (const address of [
      "0.0.0.0",
      "10.1.2.3",
      "127.0.0.1",
      "100.64.0.1",
      "169.254.169.254", // the cloud metadata endpoint, which is the whole point
      "172.16.0.1",
      "172.31.255.255",
      "192.0.0.1",
      "192.168.1.1",
      "198.18.0.1",
      "198.51.100.1",
      "203.0.113.1",
      "224.0.0.1",
      "255.255.255.255",
    ]) {
      expect(addressProblem(address), address).not.toBeNull();
    }
  });

  it("names every reserved IPv6 form, including the IPv4-mapped disguise", () => {
    for (const address of [
      "::",
      "::1",
      "::ffff:10.0.0.1",
      "::ffff:169.254.169.254",
      "fc00::1",
      "fd12:3456::1",
      "fe80::1",
      "ff02::1",
      "2001:db8::1",
      "64:ff9b::a00:1",
    ]) {
      expect(addressProblem(address), address).not.toBeNull();
    }
  });

  it("allows a genuinely public address", () => {
    for (const address of ["93.184.216.34", "8.8.8.8", "2606:2800:220:1:248:1893:25c8:1946"]) {
      expect(addressProblem(address), address).toBeNull();
    }
  });

  it("refuses a malformed address rather than guessing", () => {
    for (const address of ["", "not-an-ip", "1.2.3", "999.1.1.1"]) {
      expect(addressProblem(address), address).not.toBeNull();
    }
  });
});

describe("DNS rebinding", () => {
  it("refuses when ANY answer is private, not just the first", () => {
    /*
     * The case that matters. A name answering with one public address and one `10.0.0.1` is an
     * attempt: taking the public one and moving on would leave the next resolution — inside the
     * agent, or on a retry — free to pick the other.
     */
    const lookup = resolver([
      { address: "93.184.216.34", family: 4 },
      { address: "10.0.0.1", family: 4 },
    ]);
    return expect(resolveSafeAddress("hooks.example.com", lookup)).rejects.toThrow(UnsafeWebhookAddressError);
  });

  it("returns a validated address when every answer is public", async () => {
    const resolved = await resolveSafeAddress("hooks.example.com", resolver([{ address: "93.184.216.34", family: 4 }]));
    expect(resolved).toEqual({ address: "93.184.216.34", family: 4 });
  });

  it("refuses a resolution failure and an empty answer alike", async () => {
    await expect(resolveSafeAddress("x.example.com", resolver(new Error("ENOTFOUND")))).rejects.toThrow(
      UnsafeWebhookAddressError,
    );
    await expect(resolveSafeAddress("x.example.com", resolver([]))).rejects.toThrow(UnsafeWebhookAddressError);
  });

  it("hands the agent only an address it has just validated", async () => {
    /*
     * This is the defence itself. The agent does not resolve and then connect; it asks this, and
     * this answers with an address checked in the same breath. There is no window between them.
     */
    const seen: string[] = [];
    const guarded = makeGuardedLookup(resolver([{ address: "93.184.216.34", family: 4 }]), (r) => seen.push(r.address));
    const address = await new Promise<unknown>((resolve) => {
      guarded("hooks.example.com", {}, (_e, a) => resolve(a));
    });
    expect(address).toBe("93.184.216.34");
    expect(seen).toEqual(["93.184.216.34"]);
  });

  it("answers with an ARRAY when Node asks with all:true", async () => {
    /*
     * Node calls a custom `lookup` with `{ all: true }` whenever Happy Eyeballs is on, which it is
     * by default from Node 20. Answering with a bare string there fails as
     * `ERR_INVALID_IP_ADDRESS: undefined` — a real bug this caught, and one that looks like a DNS
     * problem rather than a shape problem.
     */
    const guarded = makeGuardedLookup(resolver([{ address: "93.184.216.34", family: 4 }]));
    const all = await new Promise<unknown>((resolve) => {
      guarded("hooks.example.com", { all: true }, (_e, a) => resolve(a));
    });
    expect(all).toEqual([{ address: "93.184.216.34", family: 4 }]);
  });

  it("fails the lookup, so the request never starts, when the answer is private", async () => {
    const guarded = makeGuardedLookup(resolver([{ address: "169.254.169.254", family: 4 }]));
    const err = await new Promise<Error | null>((resolve) => {
      guarded("metadata.example.com", { all: true }, (e) => resolve(e));
    });
    expect(err).toBeInstanceOf(UnsafeWebhookAddressError);
  });

  it("re-resolves for every call, so an answer cannot be cached past its check", async () => {
    // First call public, second private: the second is refused even though the first passed.
    const answers = [[{ address: "93.184.216.34", family: 4 }], [{ address: "10.0.0.1", family: 4 }]];
    const lookup = vi.fn(((_h: string, _o: unknown, cb: (e: unknown, a?: unknown) => void) => {
      cb(null, answers.shift() ?? []);
    }) as LookupFn);

    const guarded = makeGuardedLookup(lookup);
    const first = await new Promise((resolve) => guarded("h.example.com", {}, (e, a) => resolve(e ?? a)));
    const second = await new Promise((resolve) => guarded("h.example.com", {}, (e, a) => resolve(e ?? a)));

    expect(first).toBe("93.184.216.34");
    expect(second).toBeInstanceOf(UnsafeWebhookAddressError);
    expect(lookup).toHaveBeenCalledTimes(2);
  });
});
