import { describe, expect, it } from "vitest";
import { FixedWindowRateLimiter } from "@/server/rate-limit";

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

describe("FixedWindowRateLimiter", () => {
  it("allows up to the limit, then refuses with a retry-after until the window resets", () => {
    const c = clock();
    const rl = new FixedWindowRateLimiter(3, 60_000, c.now);

    expect(rl.hit("a")).toEqual({ allowed: true, remaining: 2, retryAfterSeconds: 0 });
    expect(rl.hit("a")).toEqual({ allowed: true, remaining: 1, retryAfterSeconds: 0 });
    expect(rl.hit("a")).toEqual({ allowed: true, remaining: 0, retryAfterSeconds: 0 });

    c.advance(15_000);
    const refused = rl.hit("a");
    expect(refused.allowed).toBe(false);
    expect(refused.remaining).toBe(0);
    expect(refused.retryAfterSeconds).toBe(45);

    c.advance(45_000); // window boundary reached
    expect(rl.hit("a").allowed).toBe(true);
  });

  it("keys are independent", () => {
    const rl = new FixedWindowRateLimiter(1, 60_000, clock().now);
    expect(rl.hit("a").allowed).toBe(true);
    expect(rl.hit("a").allowed).toBe(false);
    expect(rl.hit("b").allowed).toBe(true);
  });

  it("refused hits do not extend the window", () => {
    const c = clock();
    const rl = new FixedWindowRateLimiter(1, 10_000, c.now);
    rl.hit("a");
    c.advance(9_000);
    expect(rl.hit("a").retryAfterSeconds).toBe(1);
    c.advance(1_000);
    expect(rl.hit("a").allowed).toBe(true);
  });

  it("prunes expired windows once the map is large", () => {
    const c = clock();
    const rl = new FixedWindowRateLimiter(1, 1_000, c.now);
    for (let i = 0; i < 1100; i++) rl.hit(`k${i}`);
    expect(rl.size).toBe(1100);
    c.advance(2_000);
    rl.hit("fresh");
    expect(rl.size).toBe(1);
  });

  it("rejects nonsensical configuration", () => {
    expect(() => new FixedWindowRateLimiter(0, 1000)).toThrow(RangeError);
    expect(() => new FixedWindowRateLimiter(1, 0)).toThrow(RangeError);
  });
});
