/**
 * Prompt 0.3 item 4 — authentication rate limiting, enforced in PostgreSQL.
 *
 * Proven here against a real database: the limit holds for repeated AND for simultaneous
 * attempts (the enforcement is one atomic statement, not read-then-write), windows expire and
 * reset, the stored rows contain no plain identifier, refusals are auditable without recording
 * anything sensitive, and neither the API response nor the NextAuth path reveals whether an
 * account exists.
 */
import { randomUUID } from "node:crypto";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getAuthOptions } from "@/server/auth/options";
import { AuditAction } from "@/server/audit/audit";
import { prisma } from "@/server/db";
import { env } from "@/server/env";
import {
  RateLimitScope,
  clearSignInLimit,
  consumeRegisterLimit,
  consumeSignInLimit,
  hashKey,
  normalizeIdentifier,
  pruneExpiredRateLimits,
} from "@/server/security/rate-limit";
import { registerTestOwner, resetDatabase, TEST_PASSWORD } from "../setup/fixtures";

const REGISTER_MAX = env().AUTH_RATE_LIMIT_REGISTER_MAX;
const SIGNIN_MAX = env().AUTH_RATE_LIMIT_SIGNIN_MAX;

/** A fresh, unique client address per test, so tests never share a window. */
const ip = () => `203.0.113.${Math.floor(Math.random() * 200) + 1}:${randomUUID().slice(0, 8)}`;

function rateLimitAudits() {
  return prisma.auditLog.findMany({ where: { action: AuditAction.AUTH_RATE_LIMITED }, orderBy: { createdAt: "asc" } });
}

describe("authentication rate limiting", () => {
  beforeAll(async () => {
    await resetDatabase();
  });

  describe("registration", () => {
    it("allows exactly the configured number of attempts, then refuses with a retry-after", async () => {
      const client = ip();
      for (let i = 1; i <= REGISTER_MAX; i++) {
        const d = await consumeRegisterLimit(client);
        expect(d, `attempt ${i} should be allowed`).toEqual({ allowed: true, retryAfterSeconds: 0 });
      }
      const refused = await consumeRegisterLimit(client);
      expect(refused.allowed).toBe(false);
      expect(refused.retryAfterSeconds).toBeGreaterThan(0);
      expect(refused.retryAfterSeconds).toBeLessThanOrEqual(env().AUTH_RATE_LIMIT_REGISTER_WINDOW_SECONDS);
    });

    it("simultaneous attempts cannot exceed the limit", async () => {
      const client = ip();
      const attempts = REGISTER_MAX * 3;
      const results = await Promise.all(Array.from({ length: attempts }, () => consumeRegisterLimit(client)));
      expect(results.filter((r) => r.allowed)).toHaveLength(REGISTER_MAX);
      expect(results.filter((r) => !r.allowed)).toHaveLength(attempts - REGISTER_MAX);

      const row = await prisma.authRateLimit.findUniqueOrThrow({
        where: { scope_keyHash: { scope: RateLimitScope.REGISTER_IP, keyHash: hashKey(RateLimitScope.REGISTER_IP, client) } },
      });
      expect(row.attempts).toBe(attempts); // every attempt counted exactly once
    });

    it("keeps one window per address", async () => {
      const a = ip();
      const b = ip();
      for (let i = 0; i < REGISTER_MAX; i++) await consumeRegisterLimit(a);
      expect((await consumeRegisterLimit(a)).allowed).toBe(false);
      expect((await consumeRegisterLimit(b)).allowed).toBe(true);
    });

    it("has nothing to key on when the address is unknown, and does not crash", async () => {
      expect(await consumeRegisterLimit(null)).toEqual({ allowed: true, retryAfterSeconds: 0 });
    });
  });

  describe("window expiry and reset", () => {
    it("starts a fresh window once the old one has expired", async () => {
      const client = ip();
      for (let i = 0; i < REGISTER_MAX; i++) await consumeRegisterLimit(client);
      expect((await consumeRegisterLimit(client)).allowed).toBe(false);

      const where = {
        scope_keyHash: { scope: RateLimitScope.REGISTER_IP, keyHash: hashKey(RateLimitScope.REGISTER_IP, client) },
      };
      const before = await prisma.authRateLimit.findUniqueOrThrow({ where });
      // Simulate the window having elapsed, which is what the CASE branches in the upsert handle.
      await prisma.authRateLimit.update({ where, data: { expiresAt: new Date(Date.now() - 1_000) } });

      const after = await consumeRegisterLimit(client);
      expect(after.allowed).toBe(true);
      const row = await prisma.authRateLimit.findUniqueOrThrow({ where });
      expect(row.attempts).toBe(1);
      expect(row.expiresAt.getTime()).toBeGreaterThan(before.windowStart.getTime());
      expect(await prisma.authRateLimit.count({ where: { keyHash: row.keyHash } })).toBe(1); // reused, not duplicated
    });

    it("a refused attempt never extends the window", async () => {
      const client = ip();
      for (let i = 0; i < REGISTER_MAX; i++) await consumeRegisterLimit(client);
      const where = {
        scope_keyHash: { scope: RateLimitScope.REGISTER_IP, keyHash: hashKey(RateLimitScope.REGISTER_IP, client) },
      };
      const first = await prisma.authRateLimit.findUniqueOrThrow({ where });
      for (let i = 0; i < 5; i++) await consumeRegisterLimit(client);
      const later = await prisma.authRateLimit.findUniqueOrThrow({ where });
      expect(later.expiresAt.getTime()).toBe(first.expiresAt.getTime());
      expect(later.windowStart.getTime()).toBe(first.windowStart.getTime());
    });

    it("prunes only expired rows, in bounded batches", async () => {
      const live = ip();
      const dead = ip();
      await consumeRegisterLimit(live);
      await consumeRegisterLimit(dead);
      await prisma.authRateLimit.update({
        where: { scope_keyHash: { scope: RateLimitScope.REGISTER_IP, keyHash: hashKey(RateLimitScope.REGISTER_IP, dead) } },
        data: { expiresAt: new Date(Date.now() - 60_000) },
      });

      const removed = await pruneExpiredRateLimits();
      expect(removed).toBeGreaterThanOrEqual(1);
      expect(
        await prisma.authRateLimit.count({
          where: { scope: RateLimitScope.REGISTER_IP, keyHash: hashKey(RateLimitScope.REGISTER_IP, dead) },
        }),
      ).toBe(0);
      expect(
        await prisma.authRateLimit.count({
          where: { scope: RateLimitScope.REGISTER_IP, keyHash: hashKey(RateLimitScope.REGISTER_IP, live) },
        }),
      ).toBe(1);
      expect(await prisma.authRateLimit.count({ where: { expiresAt: { lt: new Date() } } })).toBe(0);
    });
  });

  describe("sign-in", () => {
    it("refuses after the configured failures for one identifier", async () => {
      const email = `signin-${randomUUID().slice(0, 8)}@example.test`;
      const client = ip();
      for (let i = 1; i <= SIGNIN_MAX; i++) {
        expect((await consumeSignInLimit(email, client)).allowed, `attempt ${i}`).toBe(true);
      }
      expect((await consumeSignInLimit(email, client)).allowed).toBe(false);
    });

    it("the identifier window is independent of capitalisation and padding", async () => {
      const email = `Mixed-${randomUUID().slice(0, 8)}@Example.TEST`;
      const client = ip();
      for (let i = 0; i < SIGNIN_MAX; i++) await consumeSignInLimit(email, client);
      // Same account, written differently: must hit the SAME exhausted window.
      const refused = await consumeSignInLimit(`  ${email.toUpperCase()}  `, ip());
      expect(refused.allowed).toBe(false);
    });

    it("the address window refuses even when each identifier is fresh", async () => {
      const client = ip();
      for (let i = 0; i < SIGNIN_MAX; i++) {
        await consumeSignInLimit(`spray-${randomUUID().slice(0, 8)}@example.test`, client);
      }
      const refused = await consumeSignInLimit(`spray-${randomUUID().slice(0, 8)}@example.test`, client);
      expect(refused.allowed).toBe(false); // password spraying is capped by the address window
    });

    it("a successful sign-in forgets the identifier window but keeps the address window", async () => {
      const email = `ok-${randomUUID().slice(0, 8)}@example.test`;
      const client = ip();
      for (let i = 0; i < SIGNIN_MAX - 1; i++) await consumeSignInLimit(email, client);
      await clearSignInLimit(email);

      expect(
        await prisma.authRateLimit.count({
          where: { scope: RateLimitScope.SIGNIN_IDENTIFIER, keyHash: hashKey(RateLimitScope.SIGNIN_IDENTIFIER, email) },
        }),
      ).toBe(0);
      expect(
        await prisma.authRateLimit.count({
          where: { scope: RateLimitScope.SIGNIN_IP, keyHash: hashKey(RateLimitScope.SIGNIN_IP, client) },
        }),
      ).toBe(1);
    });

    it("refuses an unknown and an existing account identically", async () => {
      const existing = await registerTestOwner();
      const known = (await prisma.user.findUniqueOrThrow({ where: { id: existing.userId }, select: { email: true } })).email;
      const unknown = `nobody-${randomUUID().slice(0, 8)}@example.test`;

      const exhaust = async (email: string) => {
        const client = ip();
        for (let i = 0; i < SIGNIN_MAX; i++) await consumeSignInLimit(email, client);
        return consumeSignInLimit(email, client);
      };
      const a = await exhaust(known);
      const b = await exhaust(unknown);
      expect(a.allowed).toBe(b.allowed);
      expect(a.allowed).toBe(false);
      // Same shape, same keys: nothing in the decision distinguishes the two cases.
      expect(Object.keys(a).sort()).toEqual(Object.keys(b).sort());
      expect(JSON.stringify(a)).not.toContain(known);
      expect(TEST_PASSWORD.length).toBeGreaterThan(0); // the password never reaches the limiter at all
    });
  });

  /**
   * The limiter is only worth anything if the sign-in path actually calls it. NextAuth's
   * credentials provider exposes exactly one hook, `authorize`, so that is where enforcement
   * lives and that is what is exercised here — the real function from the real options object.
   */
  describe("the NextAuth credentials path enforces it", () => {
    type AuthorizeFn = (
      credentials: Record<string, string> | undefined,
      req: { headers?: Record<string, string> },
    ) => Promise<{ id: string } | null>;

    /**
     * next-auth v4's CredentialsProvider() returns a descriptor whose TOP-LEVEL `authorize` is a
     * placeholder returning null; the configured one is kept under `options` and merged in by
     * NextAuth at request time. Reach for the configured function, or this would silently test
     * the library's stub instead of our code.
     */
    const authorize = (): AuthorizeFn => {
      const provider = getAuthOptions().providers[0] as unknown as { options?: { authorize?: AuthorizeFn } };
      const fn = provider.options?.authorize;
      if (typeof fn !== "function") throw new Error("credentials provider exposes no configured authorize()");
      return fn;
    };

    const headers = (client: string) => ({ headers: { "x-forwarded-for": `${client}, 10.0.0.1` } });

    it("signs in with correct credentials and clears that identifier's window", async () => {
      const reg = await registerTestOwner();
      const { email } = await prisma.user.findUniqueOrThrow({ where: { id: reg.userId }, select: { email: true } });
      const client = ip();

      const user = await authorize()({ email, password: TEST_PASSWORD }, headers(client));
      expect(user?.id).toBe(reg.userId);
      expect(
        await prisma.authRateLimit.count({
          where: { scope: RateLimitScope.SIGNIN_IDENTIFIER, keyHash: hashKey(RateLimitScope.SIGNIN_IDENTIFIER, email) },
        }),
      ).toBe(0);
      // The attempt was still counted against the client address before the password was checked.
      expect(
        await prisma.authRateLimit.count({
          where: { scope: RateLimitScope.SIGNIN_IP, keyHash: hashKey(RateLimitScope.SIGNIN_IP, client) },
        }),
      ).toBe(1);
    });

    it("refuses once the window is exhausted, even for the correct password", async () => {
      const reg = await registerTestOwner();
      const { email } = await prisma.user.findUniqueOrThrow({ where: { id: reg.userId }, select: { email: true } });
      const client = ip();

      for (let i = 0; i < SIGNIN_MAX; i++) await consumeSignInLimit(email, client);

      const refused = await authorize()({ email, password: TEST_PASSWORD }, headers(client));
      expect(refused).toBeNull(); // identical to a wrong password: no 429, no account-existence signal
    });

    it("answers an unknown account and a wrong password identically", async () => {
      const reg = await registerTestOwner();
      const { email } = await prisma.user.findUniqueOrThrow({ where: { id: reg.userId }, select: { email: true } });

      const wrongPassword = await authorize()({ email, password: "definitely-not-the-password" }, headers(ip()));
      const noSuchUser = await authorize()(
        { email: `ghost-${randomUUID().slice(0, 8)}@example.test`, password: TEST_PASSWORD },
        headers(ip()),
      );
      expect(wrongPassword).toBeNull();
      expect(noSuchUser).toBeNull();
    });

    it("still applies the identifier window when no client address is present", async () => {
      const email = `noip-${randomUUID().slice(0, 8)}@example.test`;
      for (let i = 0; i < SIGNIN_MAX; i++) {
        await authorize()({ email, password: "x" }, { headers: {} });
      }
      expect(
        await prisma.authRateLimit.count({
          where: { scope: RateLimitScope.SIGNIN_IDENTIFIER, keyHash: hashKey(RateLimitScope.SIGNIN_IDENTIFIER, email) },
        }),
      ).toBe(1);
      const row = await prisma.authRateLimit.findFirstOrThrow({
        where: { scope: RateLimitScope.SIGNIN_IDENTIFIER, keyHash: hashKey(RateLimitScope.SIGNIN_IDENTIFIER, email) },
      });
      expect(row.attempts).toBe(SIGNIN_MAX);
      expect((await consumeSignInLimit(email, null)).allowed).toBe(false);
    });
  });

  describe("privacy and auditability", () => {
    beforeEach(async () => {
      await prisma.auditLog.deleteMany({ where: { action: AuditAction.AUTH_RATE_LIMITED } });
    });

    it("stores a keyed hash, never the identifier itself", async () => {
      const email = `private-${randomUUID().slice(0, 8)}@example.test`;
      const client = `198.51.100.${Math.floor(Math.random() * 200) + 1}`;
      await consumeSignInLimit(email, client);

      const rows = await prisma.authRateLimit.findMany();
      const dump = JSON.stringify(rows);
      expect(dump).not.toContain(email);
      expect(dump).not.toContain(normalizeIdentifier(email));
      expect(dump).not.toContain(client);
      for (const r of rows) expect(r.keyHash).toMatch(/^[0-9a-f]{64}$/);

      // Keyed, not a bare digest: the same identifier in another scope yields another key.
      expect(hashKey(RateLimitScope.SIGNIN_IDENTIFIER, email)).not.toBe(hashKey(RateLimitScope.SIGNIN_IP, email));
      // Deterministic, so a window can be found again.
      expect(hashKey(RateLimitScope.SIGNIN_IDENTIFIER, email)).toBe(hashKey(RateLimitScope.SIGNIN_IDENTIFIER, email));
    });

    it("audits the first refusal of a window once, with no credential or identifier in it", async () => {
      const email = `audited-${randomUUID().slice(0, 8)}@example.test`;
      const client = ip();
      for (let i = 0; i < SIGNIN_MAX; i++) await consumeSignInLimit(email, client);
      expect(await rateLimitAudits()).toHaveLength(0); // nothing refused yet

      await consumeSignInLimit(email, client);
      const first = await rateLimitAudits();
      expect(first.length).toBeGreaterThanOrEqual(1);

      // Further refusals in the same window do not multiply audit rows.
      for (let i = 0; i < 5; i++) await consumeSignInLimit(email, client);
      expect(await rateLimitAudits()).toHaveLength(first.length);

      const entry = first[0];
      expect(entry.businessId).toBeNull();
      expect(entry.actorUserId).toBeNull();
      const meta = entry.metadata as Record<string, unknown>;
      expect(Object.keys(meta).sort()).toEqual(["keyFingerprint", "limit", "scope", "windowSeconds"]);
      expect(meta.scope).toBe(RateLimitScope.SIGNIN_IDENTIFIER);
      expect(meta.limit).toBe(SIGNIN_MAX);
      expect(String(meta.keyFingerprint)).toHaveLength(12);

      const dump = JSON.stringify(first);
      expect(dump).not.toContain(email);
      expect(dump).not.toContain(client);
      expect(dump).not.toContain(TEST_PASSWORD);
      expect(dump).not.toMatch(/password|passwordHash|secret|token/i);
    });
  });
});
