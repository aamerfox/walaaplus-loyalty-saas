import { MembershipRole } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const session = vi.hoisted(() => ({ userId: null as string | null }));

vi.mock("@/server/auth/session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/auth/session")>();
  const { UnauthorizedError } = await import("@/server/errors");
  return {
    ...actual,
    getCurrentUserId: async () => session.userId,
    requireUserId: async () => {
      if (!session.userId) throw new UnauthorizedError();
      return session.userId;
    },
  };
});

import { POST as apiKeysRoute } from "@/app/api/staff/api-keys/route";
import { authenticateApiKey } from "@/server/api/auth";
import { MAX_ACTIVE_KEYS_PER_BUSINESS } from "@/server/api/keys";
import {
  createCafeCashier,
  createStaff,
  createStampCafe,
  migratorPrisma,
  resetDatabase,
  type StampCafeFixture,
} from "../setup/fixtures";

/**
 * `POST /api/staff/api-keys` — the owner's key management, through the route the screen calls.
 *
 * `api-keys.test.ts` proves the services. This proves the HTTP boundary above them: that the right
 * people reach it, that the wrong ones learn nothing, that the raw value appears exactly where it
 * is supposed to and nowhere else, and that a terminal-state key produces our conflict rather than
 * PostgreSQL's.
 */

interface Answer {
  status: number;
  body: Record<string, unknown>;
}

async function call(body: unknown): Promise<Answer> {
  const res = await apiKeysRoute(
    new Request("http://localhost/api/staff/api-keys", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  return { status: res.status, body: ((await res.json().catch(() => null)) ?? {}) as Record<string, unknown> };
}

function errorCode(a: Answer): string | undefined {
  return (a.body.error as { code?: string } | undefined)?.code;
}

let cafe: StampCafeFixture;

beforeEach(async () => {
  await resetDatabase();
  cafe = await createStampCafe({ name: "Key café" });
  session.userId = cafe.userId;
});

afterEach(() => {
  session.userId = null;
});

describe("creating a key through the route", () => {
  it("returns the value once, with a 201, and it authenticates", async () => {
    const created = await call({ action: "create", businessId: cafe.businessId, name: "Reporting" });
    expect(created.status).toBe(201);

    const raw = String((created.body as { apiKey: string }).apiKey);
    expect(raw).toMatch(/^wpk_[0-9a-f]{8}_[A-Za-z0-9_-]{43}$/);
    await expect(authenticateApiKey(raw)).resolves.toMatchObject({ ok: true });

    // The metadata beside it carries the PUBLIC prefix and no digest.
    const key = created.body.key as Record<string, unknown>;
    expect(Object.keys(key)).not.toContain("keyDigest");
    expect(String(key.keyPrefix)).toBe(raw.slice(0, 12));
    expect(key.state).toBe("ACTIVE");
  });

  it("never returns the value again, from any later response", async () => {
    const created = await call({ action: "create", businessId: cafe.businessId, name: "Once" });
    const raw = String((created.body as { apiKey: string }).apiKey);
    const keyId = String((created.body.key as { id: string }).id);

    const revoked = await call({ action: "revoke", businessId: cafe.businessId, keyId });
    expect(revoked.status).toBe(200);
    expect(JSON.stringify(revoked.body)).not.toContain(raw);
    expect(JSON.stringify(revoked.body)).not.toContain(raw.slice(13));
    expect(revoked.body).not.toHaveProperty("apiKey");

    // And there is no action that could ask for it back.
    for (const action of ["reveal", "show", "get", "read", "delete", "list"]) {
      const attempt = await call({ action, businessId: cafe.businessId, keyId });
      expect(attempt.status, action).toBe(400);
    }
  });

  it("refuses a duplicate name and the sixth active key with their own codes", async () => {
    await call({ action: "create", businessId: cafe.businessId, name: "Reporting" });
    const duplicate = await call({ action: "create", businessId: cafe.businessId, name: "Reporting" });
    expect(duplicate.status).toBe(409);
    expect(errorCode(duplicate)).toBe("NAME_TAKEN");

    for (let i = 1; i < MAX_ACTIVE_KEYS_PER_BUSINESS; i += 1) {
      expect((await call({ action: "create", businessId: cafe.businessId, name: `Key ${i}` })).status).toBe(201);
    }
    const sixth = await call({ action: "create", businessId: cafe.businessId, name: "One too many" });
    expect(sixth.status).toBe(409);
    expect(errorCode(sixth)).toBe("API_KEY_LIMIT_REACHED");
  });

  it("refuses a body that is not one of the three actions", async () => {
    for (const body of [
      {},
      { action: "create" as const, businessId: cafe.businessId },
      { action: "create" as const, businessId: cafe.businessId, name: "" },
      { action: "create" as const, businessId: cafe.businessId, name: "x".repeat(61) },
      { action: "create" as const, businessId: cafe.businessId, name: "Fine", scope: "EVENTS_WRITE" },
      { action: "revoke" as const, businessId: cafe.businessId },
    ]) {
      const a = await call(body);
      expect(a.status, JSON.stringify(body).slice(0, 40)).toBe(400);
    }
  });
});

describe("rotating and revoking through the route", () => {
  it("rotates to a new value and kills the old one at once", async () => {
    const original = await call({ action: "create", businessId: cafe.businessId, name: "Before" });
    const originalRaw = String((original.body as { apiKey: string }).apiKey);
    const keyId = String((original.body.key as { id: string }).id);

    const rotated = await call({ action: "rotate", businessId: cafe.businessId, keyId, name: "After" });
    expect(rotated.status).toBe(201);
    const newRaw = String((rotated.body as { apiKey: string }).apiKey);
    expect(newRaw).not.toBe(originalRaw);

    await expect(authenticateApiKey(originalRaw)).resolves.toMatchObject({ ok: false, reason: "REVOKED" });
    await expect(authenticateApiKey(newRaw)).resolves.toMatchObject({ ok: true });
  });

  it("gives the controlled conflict for an EXPIRED key, never a database message", async () => {
    /*
     * The Prompt 1 correction, carried through the HTTP boundary.
     *
     * `api_key_guard` treats EXPIRED as a rest state, so an UPDATE reaching it raises `23514`. The
     * service refuses first, which is what turns a 500 carrying PostgreSQL's words into a 409 the
     * screen knows how to translate.
     */
    const created = await call({ action: "create", businessId: cafe.businessId, name: "Lapsed" });
    const keyId = String((created.body.key as { id: string }).id);

    await migratorPrisma().$executeRawUnsafe('ALTER TABLE "ApiKey" DISABLE TRIGGER api_key_guard');
    try {
      await migratorPrisma().$executeRawUnsafe(
        `UPDATE "ApiKey" SET "issuedAt" = now() - interval '100 days', "expiresAt" = now() - interval '1 day',
           "state" = 'EXPIRED', "activeSlot" = NULL WHERE "id" = $1::text`,
        keyId,
      );
    } finally {
      await migratorPrisma().$executeRawUnsafe('ALTER TABLE "ApiKey" ENABLE TRIGGER api_key_guard');
    }

    // `revoke` takes no name and the schema is strict, so each action sends its own body.
    for (const body of [
      { action: "revoke", businessId: cafe.businessId, keyId },
      { action: "rotate", businessId: cafe.businessId, keyId, name: "Successor" },
    ]) {
      const action = body.action;
      const a = await call(body);
      expect(a.status, action).toBe(409);
      expect(errorCode(a), action).toBe("API_KEY_NOT_ACTIVE");
      expect(JSON.stringify(a.body), action).not.toMatch(/rest state|check_violation|23514|ApiKey:/);
    }

    // And nothing moved on the way to those refusals.
    const row = await migratorPrisma().apiKey.findFirstOrThrow({
      where: { id: keyId },
      select: { state: true, revokedAt: true },
    });
    expect(row).toEqual({ state: "EXPIRED", revokedAt: null });
  });

  it("records the three lifecycle actions in the audit, with no key material", async () => {
    const created = await call({ action: "create", businessId: cafe.businessId, name: "Audited" });
    const raw = String((created.body as { apiKey: string }).apiKey);
    const keyId = String((created.body.key as { id: string }).id);
    const rotated = await call({ action: "rotate", businessId: cafe.businessId, keyId, name: "Rotated" });
    await call({
      action: "revoke",
      businessId: cafe.businessId,
      keyId: String((rotated.body.key as { id: string }).id),
    });

    const audits = await migratorPrisma().auditLog.findMany({
      where: { businessId: cafe.businessId, entityType: "ApiKey" },
    });
    expect(audits.map((a) => a.action).sort()).toEqual(["api_key.created", "api_key.revoked", "api_key.rotated"]);

    const serialised = JSON.stringify(audits);
    expect(serialised).not.toContain(raw);
    expect(serialised).not.toContain(raw.slice(13));
    for (const row of await migratorPrisma().apiKey.findMany({ select: { keyDigest: true } })) {
      expect(serialised).not.toContain(row.keyDigest);
    }
  });
});

describe("who may reach this route", () => {
  it("refuses a manager and a cashier", async () => {
    const manager = await createStaff(cafe, MembershipRole.MANAGER);
    const cashier = await createCafeCashier(cafe);

    for (const staff of [manager, cashier]) {
      session.userId = staff.userId;
      const a = await call({ action: "create", businessId: cafe.businessId, name: "Not for you" });
      expect(a.status).toBe(403);
    }
    // Nothing was created by either attempt.
    expect(await migratorPrisma().apiKey.count({ where: { businessId: cafe.businessId } })).toBe(0);
  });

  it("refuses an unauthenticated caller", async () => {
    session.userId = null;
    const a = await call({ action: "create", businessId: cafe.businessId, name: "Anonymous" });
    expect(a.status).toBe(401);
  });

  it("does not let one owner touch another business's key, or confirm it exists", async () => {
    const mine = await call({ action: "create", businessId: cafe.businessId, name: "Mine" });
    const keyId = String((mine.body.key as { id: string }).id);

    const other = await createStampCafe({ name: "Other café" });
    session.userId = other.userId;

    // Their own business, somebody else's key id: the key does not exist for them.
    const stolen = await call({ action: "revoke", businessId: other.businessId, keyId });
    expect(stolen.status).toBe(404);
    expect(JSON.stringify(stolen.body)).not.toContain(keyId);

    // Naming the other business outright is refused by the context resolver, not by the service.
    const impersonated = await call({ action: "revoke", businessId: cafe.businessId, keyId });
    expect([403, 404]).toContain(impersonated.status);

    // Still active, still theirs.
    const row = await migratorPrisma().apiKey.findFirstOrThrow({ where: { id: keyId }, select: { state: true } });
    expect(row.state).toBe("ACTIVE");
  });
});
