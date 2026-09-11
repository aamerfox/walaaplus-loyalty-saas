/**
 * Fixed-window rate limiter, in process memory.
 *
 * Phase 0 scope: protects public, unauthenticated endpoints (registration) from trivial abuse
 * on a single web instance. It is deliberately simple:
 *   - state lives in the process, so limits are per web replica and reset on restart;
 *   - keys are whatever the caller chooses (client IP for registration);
 *   - expired windows are pruned lazily on each hit, so memory is bounded by active keys.
 *
 * When the platform runs more than one web replica (Phase 1.5+), replace the store with a shared
 * one (PostgreSQL or Redis) behind the same `hit()` contract. Nothing else needs to change.
 */
export interface RateLimitDecision {
  allowed: boolean;
  /** Requests still allowed in the current window (0 when refused). */
  remaining: number;
  /** Whole seconds until the window resets; 0 when allowed. */
  retryAfterSeconds: number;
}

interface Window {
  count: number;
  resetAt: number;
}

export class FixedWindowRateLimiter {
  private readonly windows = new Map<string, Window>();

  constructor(
    /** Maximum hits per key per window. */
    readonly limit: number,
    /** Window length in milliseconds. */
    readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {
    if (!Number.isInteger(limit) || limit < 1) throw new RangeError("limit must be a positive integer");
    if (!Number.isFinite(windowMs) || windowMs <= 0) throw new RangeError("windowMs must be positive");
  }

  hit(key: string): RateLimitDecision {
    const t = this.now();
    this.prune(t);
    let w = this.windows.get(key);
    if (!w || w.resetAt <= t) {
      w = { count: 0, resetAt: t + this.windowMs };
      this.windows.set(key, w);
    }
    if (w.count >= this.limit) {
      return { allowed: false, remaining: 0, retryAfterSeconds: Math.max(1, Math.ceil((w.resetAt - t) / 1000)) };
    }
    w.count += 1;
    return { allowed: true, remaining: this.limit - w.count, retryAfterSeconds: 0 };
  }

  /** Number of keys currently tracked (for tests and diagnostics). */
  get size(): number {
    return this.windows.size;
  }

  private prune(t: number): void {
    // Bounded work: only sweep when the map has grown; sweeping every hit would be O(n) per request.
    if (this.windows.size < 1024) return;
    for (const [k, w] of this.windows) if (w.resetAt <= t) this.windows.delete(k);
  }
}

/** Registration: 10 attempts per client address per 15 minutes. */
export const registerRateLimiter = new FixedWindowRateLimiter(10, 15 * 60 * 1000);
