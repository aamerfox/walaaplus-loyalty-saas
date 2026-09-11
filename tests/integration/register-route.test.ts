/**
 * Phase 0.3 security remediation — the public registration boundary.
 *
 * A submission for an email that already has an account must be indistinguishable from one that
 * creates a new account. Anything else turns this endpoint into a customer list. This is a
 * property of the HTTP response, so it is tested at the ROUTE rather than at the service.
 */
import { randomUUID } from "node:crypto";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { POST } from "@/app/api/auth/register/route";
import { prisma } from "@/server/db";
import { registerTestOwner, resetDatabase, TEST_PASSWORD } from "../setup/fixtures";

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

describe("POST /api/auth/register", () => {
  beforeAll(async () => {
    await resetDatabase();
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
});
