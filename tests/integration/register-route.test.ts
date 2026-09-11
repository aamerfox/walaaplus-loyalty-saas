/**
 * Phase 0.3 security remediation — the public registration boundary.
 *
 * Two blockers are covered here, at the ROUTE, because both are properties of the HTTP response
 * rather than of the service beneath it:
 *
 *   1. A submission for an email that already has an account must be indistinguishable from one
 *      that creates a new account. Anything else turns this endpoint into a customer list.
 *   2. A forged X-Forwarded-For must not let one caller look like many clients. Forwarding
 *      headers are believed only when TRUST_PROXY_HEADERS says a proxy overwrites them.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { POST } from "@/app/api/auth/register/route";
import { prisma } from "@/server/db";
import { env, resetEnvCacheForTests } from "@/server/env";
import { RateLimitScope, hashKey } from "@/server/security/rate-limit";
import { registerTestOwner, resetDatabase, TEST_PASSWORD } from "../setup/fixtures";

const REGISTER_MAX = env().AUTH_RATE_LIMIT_REGISTER_MAX;

interface Answer {
  status: number;
  body: unknown;
  headers: Record<string, string>;
}

function newEmail(prefix = "route") {
  return `${prefix}-${randomUUID().slice(0, 12)}@example.test`;
}

function payload(email: string) {
  return {
    email,
    password: TEST_PASSWORD,
    firstName: "Route",
    lastName: "Tester",
    businessName: `Biz ${randomUUID().slice(0, 6)}`,
  };
}

async function post(body: unknown, headers: Record<string, string> = {}): Promise<Answer> {
  const res = await POST(
    new Request("http://localhost:3000/api/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    }),
  );
  return {
    status: res.status,
    body: await res.json(),
    headers: Object.fromEntries(res.headers.entries()),
  };
}

/** Flip the proxy-trust setting for one assertion and put it back. */
function withProxyTrust<T>(trusted: boolean, fn: () => Promise<T>): Promise<T> {
  const previous = process.env.TRUST_PROXY_HEADERS;
  process.env.TRUST_PROXY_HEADERS = trusted ? "true" : "false";
  resetEnvCacheForTests();
  return fn().finally(() => {
    if (previous === undefined) delete process.env.TRUST_PROXY_HEADERS;
    else process.env.TRUST_PROXY_HEADERS = previous;
    resetEnvCacheForTests();
  });
}

describe("POST /api/auth/register", () => {
  beforeAll(async () => {
    await resetDatabase();
  });

  afterAll(() => {
    resetEnvCacheForTests();
  });

  describe("a duplicate email is indistinguishable from a new one", () => {
    beforeEach(async () => {
      await prisma.authRateLimit.deleteMany({});
    });

    it("answers both with the same status, body and headers", async () => {
      const existing = await registerTestOwner();
      const taken = (await prisma.user.findUniqueOrThrow({ where: { id: existing.userId }, select: { email: true } })).email;

      const duplicate = await post(payload(taken));
      const fresh = await post(payload(newEmail()));

      expect(duplicate.status).toBe(fresh.status);
      expect(duplicate.body).toEqual(fresh.body);
      // Header sets must match too: a differing Location or Retry-After would be an oracle.
      expect(Object.keys(duplicate.headers).sort()).toEqual(Object.keys(fresh.headers).sort());
      expect(duplicate.status).toBe(202);
    });

    it("says nothing about the account, and carries no identifier to compare", async () => {
      const existing = await registerTestOwner();
      const taken = (await prisma.user.findUniqueOrThrow({ where: { id: existing.userId }, select: { email: true } })).email;

      const answer = await post(payload(taken));
      const text = JSON.stringify(answer.body).toLowerCase();
      expect(text).not.toContain("already");
      expect(text).not.toContain("exists");
      expect(text).not.toContain("conflict");
      expect(text).not.toContain("duplicate");
      expect(text).not.toContain(taken.toLowerCase());
      expect(text).not.toContain(existing.businessId);
      expect(text).not.toContain(existing.userId);
      // No businessId is returned even on success, so there is nothing to diff between the two.
      expect(answer.body).not.toHaveProperty("businessId");
    });

    it("creates nothing for the duplicate, and exactly one account for the new email", async () => {
      const existing = await registerTestOwner();
      const taken = (await prisma.user.findUniqueOrThrow({ where: { id: existing.userId }, select: { email: true } })).email;
      const users = await prisma.user.count();
      const businesses = await prisma.business.count();

      await post(payload(taken));
      expect(await prisma.user.count()).toBe(users);
      expect(await prisma.business.count()).toBe(businesses);

      const fresh = newEmail();
      await post(payload(fresh));
      expect(await prisma.user.count()).toBe(users + 1);
      expect(await prisma.user.findUnique({ where: { email: fresh } })).not.toBeNull();
    });

    it("still reports malformed input as a validation error", async () => {
      // Input shape is about the request, not about who has an account: this must stay specific.
      const bad = await post({ ...payload(newEmail()), email: "not-an-email" });
      expect(bad.status).toBe(400);
      const missingBody = await POST(
        new Request("http://localhost:3000/api/auth/register", { method: "POST", headers: { "content-type": "application/json" }, body: "not json" }),
      );
      expect(missingBody.status).toBe(400);
    });
  });

  describe("a forged X-Forwarded-For cannot mint fresh rate-limit windows", () => {
    beforeEach(async () => {
      await prisma.authRateLimit.deleteMany({});
    });

    it("ignores the header entirely when no proxy is trusted", async () => {
      await withProxyTrust(false, async () => {
        for (let i = 0; i < 3; i++) {
          await post(payload(newEmail()), { "x-forwarded-for": `198.51.100.${i}`, "x-real-ip": `198.51.100.${i}` });
        }
        // Not one per-address window exists, so there was no address to key on and nothing an
        // attacker could vary. The per-email window is what limits registration here.
        expect(await prisma.authRateLimit.count({ where: { scope: RateLimitScope.REGISTER_IP } })).toBe(0);
        expect(await prisma.authRateLimit.count({ where: { scope: RateLimitScope.REGISTER_IDENTIFIER } })).toBe(3);
      });
    });

    it("keys on the address the proxy set, not the one the client prepended", async () => {
      await withProxyTrust(true, async () => {
        const real = "203.0.113.42";
        for (let i = 0; i < 3; i++) {
          // Exactly what the attack looks like: a different forged hop each time, with the
          // proxy's own value appended last.
          await post(payload(newEmail()), { "x-forwarded-for": `6.6.6.${i}, ${real}` });
        }
        const windows = await prisma.authRateLimit.findMany({ where: { scope: RateLimitScope.REGISTER_IP } });
        expect(windows).toHaveLength(1); // three forged prefixes, one real client
        expect(windows[0].keyHash).toBe(hashKey(RateLimitScope.REGISTER_IP, real));
        expect(windows[0].attempts).toBe(3);
        for (let i = 0; i < 3; i++) {
          expect(windows[0].keyHash).not.toBe(hashKey(RateLimitScope.REGISTER_IP, `6.6.6.${i}`));
        }
      });
    });

    it("refuses the caller once the address window is exhausted, whatever they forge", async () => {
      await withProxyTrust(true, async () => {
        const real = "203.0.113.77";
        const answers: Answer[] = [];
        for (let i = 0; i < REGISTER_MAX + 2; i++) {
          answers.push(await post(payload(newEmail()), { "x-forwarded-for": `10.0.0.${i}, ${real}` }));
        }
        const refused = answers.filter((a) => a.status === 429);
        expect(refused).toHaveLength(2);
        expect(refused[0].headers["retry-after"]).toMatch(/^\d+$/);
        expect(JSON.stringify(refused[0].body)).toContain("Too many attempts");
        // The refusal is generic: it names no window and no identifier.
        expect(JSON.stringify(refused[0].body)).not.toContain(real);
      });
    });

    it("limits registration per email even with no trusted address at all", async () => {
      await withProxyTrust(false, async () => {
        const email = newEmail("repeat");
        const answers: Answer[] = [];
        for (let i = 0; i < REGISTER_MAX + 1; i++) {
          answers.push(await post(payload(email), { "x-forwarded-for": `198.51.100.${i}` }));
        }
        expect(answers.filter((a) => a.status === 429)).toHaveLength(1);
        expect(await prisma.user.count({ where: { email } })).toBe(1); // only the first one created
      });
    });
  });
});
