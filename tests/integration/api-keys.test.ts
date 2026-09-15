import { createHash, randomBytes } from "node:crypto";
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

import { authenticateApiKey, hasScope, touchKey } from "@/server/api/auth";
import { apiUnauthorized } from "@/server/api/contract";
import {
  createKey,
  KEY_TTL_DAYS,
  listKeys,
  MAX_ACTIVE_KEYS_PER_BUSINESS,
  revokeKey,
  rotateKey,
} from "@/server/api/keys";
import { consumeApiRateLimit } from "@/server/api/rate-limit";
import { MembershipRole } from "@prisma/client";
import { ForbiddenError } from "@/server/errors";
import {
  createStampCafe,
  migratorPrisma,
  resetDatabase,
  type StampCafeFixture,
} from "../setup/fixtures";

/**
 * API keys through the services, and `X-API-Key` through the authenticator.
 *
 * `api-key-integrity.test.ts` proves the database refuses a wrong row; `api-key-concurrency.test.ts`
 * proves the ceiling holds under overlapping transactions. This proves the services write the right
 * row, hand the value over exactly once, and that the authenticator tells a caller nothing it should
 * not know.
 */

const DAY = 24 * 60 * 60 * 1000;

let cafe: StampCafeFixture;

beforeEach(async () => {
  await resetDatabase();
  cafe = await createStampCafe({ name: "API café" });
  session.userId = cafe.userId;
});

afterEach(() => {
  session.userId = null;
});

describe("creating a key", () => {
  it("returns the value once, stores only a digest, and never the value", async () => {
    const created = await createKey(cafe.ctx, { name: "Reporting" });

    expect(created.apiKey).toMatch(/^wpk_[0-9a-f]{8}_[A-Za-z0-9_-]{43}$/);
    expect(created.key.keyPrefix).toBe(created.apiKey.slice(0, 12));
    expect(created.key.scope).toBe("EVENTS_READ");
    expect(created.key.state).toBe("ACTIVE");
    expect(created.key.usable).toBe(true);

    // Ninety days, give or take the second the test took.
    const ttlDays = Math.round((created.key.expiresAt.getTime() - created.key.issuedAt.getTime()) / DAY);
    expect(ttlDays).toBe(KEY_TTL_DAYS);

    // The stored row holds the digest and NOT the value — read as the migrator, which can see
    // every column, so this is not a claim about the projection.
    const row = await migratorPrisma().apiKey.findFirstOrThrow({
      where: { id: created.key.id },
      select: { keyDigest: true, keyPrefix: true },
    });
    expect(row.keyDigest).toBe(createHash("sha256").update(created.apiKey, "utf8").digest("hex"));
    expect(row.keyDigest).not.toContain(created.apiKey);

    // The whole row, serialised, contains no part of the secret half.
    const whole = await migratorPrisma().apiKey.findFirstOrThrow({ where: { id: created.key.id } });
    const secretHalf = created.apiKey.slice(13);
    expect(JSON.stringify(whole)).not.toContain(secretHalf);
  });

  it("never hands the value back afterwards, from any read this product offers", async () => {
    const created = await createKey(cafe.ctx, { name: "Once" });
    const secretHalf = created.apiKey.slice(13);

    const listed = JSON.stringify(await listKeys(cafe.ctx));
    expect(listed).not.toContain(created.apiKey);
    expect(listed).not.toContain(secretHalf);
    // The digest is not in the owner's projection either: it is a target for anybody who later
    // obtains a candidate value.
    expect(listed).not.toContain("keyDigest");
  });

  it("gives two keys different values and different prefixes", async () => {
    const a = await createKey(cafe.ctx, { name: "First" });
    const b = await createKey(cafe.ctx, { name: "Second" });
    expect(a.apiKey).not.toBe(b.apiKey);
    expect(a.key.keyPrefix).not.toBe(b.key.keyPrefix);
  });

  it("refuses a duplicate name within the business, and allows it across businesses", async () => {
    await createKey(cafe.ctx, { name: "Ops" });
    await expect(createKey(cafe.ctx, { name: "Ops" })).rejects.toThrow(/already in use/);

    const other = await createStampCafe({ name: "Their café" });
    session.userId = other.userId;
    const theirs = await createKey(other.ctx, { name: "Ops" });
    expect(theirs.apiKey).toBeTruthy();
  });

  it("refuses a sixth active key, and says why", async () => {
    for (let i = 0; i < MAX_ACTIVE_KEYS_PER_BUSINESS; i += 1) {
      await createKey(cafe.ctx, { name: `Key ${i}` });
    }
    await expect(createKey(cafe.ctx, { name: "Too many" })).rejects.toThrow(/at most 5 active API keys/);
  });
});

describe("only the owner may manage keys", () => {
  it("refuses a manager and a cashier", async () => {
    // Built by narrowing the owner's context, the same way every other suite in this repo does it.
    const manager = { ...cafe.ctx, role: MembershipRole.MANAGER };
    const cashier = { ...cafe.ctx, role: MembershipRole.CASHIER };
    for (const ctx of [manager, cashier]) {
      await expect(createKey(ctx, { name: "Nope" })).rejects.toBeInstanceOf(ForbiddenError);
      await expect(listKeys(ctx)).rejects.toBeInstanceOf(ForbiddenError);
    }
  });

  it("refuses an owner of another business, and does not confirm the key exists", async () => {
    const created = await createKey(cafe.ctx, { name: "Mine" });
    const other = await createStampCafe({ name: "Elsewhere" });
    session.userId = other.userId;
    // "Not found", not "forbidden": another tenant's key does not exist for this caller.
    await expect(revokeKey(other.ctx, created.key.id)).rejects.toThrow(/not found/i);
    await expect(rotateKey(other.ctx, created.key.id, "Theirs")).rejects.toThrow(/not found/i);
  });
});

describe("revoking and rotating", () => {
  it("revokes once and refuses a second revocation", async () => {
    const created = await createKey(cafe.ctx, { name: "Doomed" });
    const revoked = await revokeKey(cafe.ctx, created.key.id);
    expect(revoked.state).toBe("REVOKED");
    expect(revoked.usable).toBe(false);
    expect(revoked.revokedAt).not.toBeNull();
    await expect(revokeKey(cafe.ctx, created.key.id)).rejects.toThrow(/already revoked/);
  });

  it("rotates to a new value and kills the old one in the same breath", async () => {
    const original = await createKey(cafe.ctx, { name: "Before" });
    const rotated = await rotateKey(cafe.ctx, original.key.id, "After");

    expect(rotated.apiKey).not.toBe(original.apiKey);
    expect(rotated.key.id).not.toBe(original.key.id);

    // The old value authenticates nothing, immediately. No grace period.
    await expect(authenticateApiKey(original.apiKey)).resolves.toMatchObject({ ok: false, reason: "REVOKED" });
    await expect(authenticateApiKey(rotated.apiKey)).resolves.toMatchObject({ ok: true });

    // Provenance is recorded, and it is not a secret.
    const row = await migratorPrisma().apiKey.findFirstOrThrow({
      where: { id: rotated.key.id },
      select: { rotatedFromId: true },
    });
    expect(row.rotatedFromId).toBe(original.key.id);
  });

  it("refuses to rotate a key that is not active", async () => {
    const created = await createKey(cafe.ctx, { name: "Gone" });
    await revokeKey(cafe.ctx, created.key.id);
    await expect(rotateKey(cafe.ctx, created.key.id, "Again")).rejects.toThrow(/only an active key/i);
  });

  it("frees the ceiling when a key is revoked", async () => {
    const keys = [];
    for (let i = 0; i < MAX_ACTIVE_KEYS_PER_BUSINESS; i += 1) {
      keys.push(await createKey(cafe.ctx, { name: `Key ${i}` }));
    }
    await expect(createKey(cafe.ctx, { name: "Sixth" })).rejects.toThrow(/at most/);
    await revokeKey(cafe.ctx, keys[0].key.id);
    const replacement = await createKey(cafe.ctx, { name: "Sixth" });
    expect(replacement.apiKey).toBeTruthy();
  });
});

describe("X-API-Key authentication tells a caller nothing", () => {
  it("accepts a live key and reports the business it belongs to", async () => {
    const created = await createKey(cafe.ctx, { name: "Live" });
    const result = await authenticateApiKey(created.apiKey);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.ctx.businessId).toBe(cafe.businessId);
    expect(result.ctx.apiKeyId).toBe(created.key.id);
    expect(hasScope(result.ctx, "EVENTS_READ")).toBe(true);
  });

  it("refuses missing, malformed, unknown, revoked and expired — all five", async () => {
    const live = await createKey(cafe.ctx, { name: "Live" });
    const revoked = await createKey(cafe.ctx, { name: "Revoked" });
    await revokeKey(cafe.ctx, revoked.key.id);

    const expired = await createKey(cafe.ctx, { name: "Expired" });
    await migratorPrisma().$executeRawUnsafe('ALTER TABLE "ApiKey" DISABLE TRIGGER api_key_guard');
    try {
      await migratorPrisma().$executeRawUnsafe(
        `UPDATE "ApiKey" SET "issuedAt" = now() - interval '100 days', "expiresAt" = now() - interval '1 day'
          WHERE "id" = $1::text`,
        expired.key.id,
      );
    } finally {
      await migratorPrisma().$executeRawUnsafe('ALTER TABLE "ApiKey" ENABLE TRIGGER api_key_guard');
    }

    const cases: [string, string | null, string][] = [
      ["missing", null, "MISSING"],
      ["empty", "", "MISSING"],
      ["malformed", "not-a-key", "MALFORMED"],
      ["wrong shape", "wpk_zzzzzzzz_" + "a".repeat(43), "MALFORMED"],
      ["huge", "wpk_00000000_" + "a".repeat(5000), "MALFORMED"],
      ["unknown", `wpk_${randomBytes(4).toString("hex")}_${randomBytes(32).toString("base64url")}`, "UNKNOWN"],
      ["revoked", revoked.apiKey, "REVOKED"],
      ["expired", expired.apiKey, "EXPIRED"],
    ];

    for (const [label, value, reason] of cases) {
      const result = await authenticateApiKey(value);
      expect(result.ok, label).toBe(false);
      if (!result.ok) expect(result.reason, label).toBe(reason);
    }

    // And the live one still works, so the refusals above are about those keys and not the clock.
    await expect(authenticateApiKey(live.apiKey)).resolves.toMatchObject({ ok: true });
  });

  it("gives every one of those the SAME answer on the wire", async () => {
    /*
     * The internal `reason` exists so the tests above can tell the five conditions apart. What a
     * caller gets has no such field: one status, one code, one message, and no parameter through
     * which a future edit could pass the reason.
     */
    const body = apiUnauthorized();
    expect(body.error.code).toBe("UNAUTHORIZED");
    expect(JSON.stringify(body)).not.toMatch(/revoked|expired|unknown|malformed|missing/i);
    expect(apiUnauthorized.length).toBe(0);
  });

  it("does not confirm a value by accepting a variant of it", async () => {
    const created = await createKey(cafe.ctx, { name: "Exact" });
    for (const variant of [
      ` ${created.apiKey}`,
      `${created.apiKey} `,
      created.apiKey.toUpperCase(),
      created.apiKey.slice(0, -1),
      `${created.apiKey}x`,
    ]) {
      await expect(authenticateApiKey(variant), variant.slice(0, 16)).resolves.toMatchObject({ ok: false });
    }
  });

  it("does not touch the database for a malformed value", async () => {
    // Shape first, lookup second: an unauthenticated caller cannot turn arbitrary strings into
    // indexed reads, let alone into rows.
    const before = await migratorPrisma().authRateLimit.count();
    for (let i = 0; i < 20; i += 1) await authenticateApiKey(`garbage-${i}`);
    expect(await migratorPrisma().authRateLimit.count()).toBe(before);
  });
});

describe("a key sees exactly one business", () => {
  it("never carries another tenant's id, whatever the caller does", async () => {
    const mine = await createKey(cafe.ctx, { name: "Mine" });
    const other = await createStampCafe({ name: "Theirs" });
    session.userId = other.userId;
    const theirs = await createKey(other.ctx, { name: "Theirs" });

    const a = await authenticateApiKey(mine.apiKey);
    const b = await authenticateApiKey(theirs.apiKey);
    expect(a.ok && a.ctx.businessId).toBe(cafe.businessId);
    expect(b.ok && b.ctx.businessId).toBe(other.businessId);

    // There is no parameter through which a caller could ask for the other one: `ApiContext` has
    // exactly three fields and none of them is an input.
    if (a.ok) expect(Object.keys(a.ctx).sort()).toEqual(["apiKeyId", "businessId", "scopes"]);
  });
});

describe("the rate limit is per key, and costs an unknown caller nothing", () => {
  it("writes no counter row until a key is known valid", async () => {
    const before = await migratorPrisma().authRateLimit.count();
    for (let i = 0; i < 25; i += 1) {
      await authenticateApiKey(`wpk_${randomBytes(4).toString("hex")}_${randomBytes(32).toString("base64url")}`);
    }
    // Twenty-five well-formed but unknown keys. Had the window been consumed before the lookup,
    // this would be twenty-five rows of attacker-chosen noise.
    expect(await migratorPrisma().authRateLimit.count()).toBe(before);
  });

  it("opens exactly one window for a valid key, whatever the request count", async () => {
    const created = await createKey(cafe.ctx, { name: "Busy" });
    const result = await authenticateApiKey(created.apiKey);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const before = await migratorPrisma().authRateLimit.count();
    for (let i = 0; i < 5; i += 1) {
      const decision = await consumeApiRateLimit(result.ctx);
      expect(decision.allowed).toBe(true);
    }
    expect(await migratorPrisma().authRateLimit.count()).toBe(before + 1);
  });

  it("keys the window on the key's id and never on its value", async () => {
    const created = await createKey(cafe.ctx, { name: "Keyed" });
    const result = await authenticateApiKey(created.apiKey);
    if (!result.ok) throw new Error("expected a valid key");
    await consumeApiRateLimit(result.ctx);

    const rows = await migratorPrisma().authRateLimit.findMany({ where: { scope: "api.key" } });
    const serialised = JSON.stringify(rows);
    expect(serialised).not.toContain(created.apiKey);
    expect(serialised).not.toContain(created.apiKey.slice(13));
  });
});

describe("last use moves forward and is not a security decision", () => {
  it("records a use and never moves it backwards", async () => {
    const created = await createKey(cafe.ctx, { name: "Used" });
    const t1 = new Date();
    await touchKey(created.key.id, t1);
    await touchKey(created.key.id, new Date(t1.getTime() - 60_000));

    const row = await migratorPrisma().apiKey.findFirstOrThrow({
      where: { id: created.key.id },
      select: { lastUsedAt: true },
    });
    expect(row.lastUsedAt?.getTime()).toBe(t1.getTime());
  });
});

describe("nothing a key touches ever records the key", () => {
  it("keeps it out of audit rows entirely", async () => {
    const created = await createKey(cafe.ctx, { name: "Audited" });
    await rotateKey(cafe.ctx, created.key.id, "Rotated");
    const second = await listKeys(cafe.ctx);
    await revokeKey(cafe.ctx, second[0].id);

    const audits = await migratorPrisma().auditLog.findMany({
      where: { businessId: cafe.businessId, entityType: "ApiKey" },
    });
    expect(audits.length).toBeGreaterThanOrEqual(3);
    expect(audits.map((a) => a.action).sort()).toEqual(
      ["api_key.created", "api_key.revoked", "api_key.rotated"].sort(),
    );

    const serialised = JSON.stringify(audits);
    expect(serialised).not.toContain(created.apiKey);
    expect(serialised).not.toContain(created.apiKey.slice(13));
    // Not the digest either: an audit row outlives the request that wrote it.
    const row = await migratorPrisma().apiKey.findFirstOrThrow({
      where: { id: created.key.id },
      select: { keyDigest: true },
    });
    expect(serialised).not.toContain(row.keyDigest);
    // The PUBLIC prefix is there, because that is what lets an owner recognise the entry.
    expect(serialised).toContain(created.key.keyPrefix);
  });

  it("writes no audit row for a read", async () => {
    const created = await createKey(cafe.ctx, { name: "Reader" });
    const before = await migratorPrisma().auditLog.count({ where: { businessId: cafe.businessId } });
    for (let i = 0; i < 10; i += 1) {
      const result = await authenticateApiKey(created.apiKey);
      if (result.ok) await touchKey(result.ctx.apiKeyId);
    }
    // Ten authentications, zero rows. One row per read would let a key holder turn their own rate
    // limit into unbounded writes to the audit table.
    expect(await migratorPrisma().auditLog.count({ where: { businessId: cafe.businessId } })).toBe(before);
  });

  it("puts nothing of the key in a refusal an owner might paste into a ticket", async () => {
    const created = await createKey(cafe.ctx, { name: "Erroring" });
    await revokeKey(cafe.ctx, created.key.id);
    let message = "";
    try {
      await rotateKey(cafe.ctx, created.key.id, "Nope");
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toBeTruthy();
    expect(message).not.toContain(created.apiKey);
    expect(message).not.toContain(created.apiKey.slice(13));
    expect(message).not.toContain(created.key.keyPrefix);
  });
});

describe("the key path cannot reach a staff service", () => {
  it("produces a context that is not a TenantContext", async () => {
    /*
     * The structural guarantee. An `ApiContext` has no `userId`, no `membershipId`, no role and no
     * permission set, so nothing that takes a `TenantContext` can be handed one — it does not
     * type-check, which is stronger than a review comment. This asserts the shape at runtime so a
     * future edit that widened it would be caught even if the types were loosened.
     */
    const created = await createKey(cafe.ctx, { name: "Narrow" });
    const result = await authenticateApiKey(created.apiKey);
    if (!result.ok) throw new Error("expected a valid key");
    const keys = Object.keys(result.ctx);
    expect(keys).not.toContain("userId");
    expect(keys).not.toContain("membershipId");
    expect(keys).not.toContain("role");
    expect(keys).not.toContain("permissions");
    expect(keys).not.toContain("locationIds");
  });
});

describe("ordinary session authentication is unchanged", () => {
  it("still refuses a cashier the integrations history and still serves an owner", async () => {
    // A regression check on the path this prompt did not touch: adding a second way to authenticate
    // must not have changed the first.
    const { listIntegrationEvents } = await import("@/server/integrations/events");
    const manager = { ...cafe.ctx, role: MembershipRole.MANAGER };
    const cashier = { ...cafe.ctx, role: MembershipRole.CASHIER };
    await expect(listIntegrationEvents(cashier)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(listIntegrationEvents(cafe.ctx)).resolves.toEqual([]);
    await expect(listIntegrationEvents(manager)).resolves.toEqual([]);
  });

  it("leaves B7 answering a constant 410", async () => {
    const enroll = await import("@/app/api/enroll/route");
    expect((await enroll.GET()).status).toBe(410);
    expect((await enroll.POST()).status).toBe(410);
  });

  it("has added no public API route", async () => {
    // Prompt 1 builds the key and deliberately not the surface.
    const { existsSync } = await import("node:fs");
    expect(existsSync("src/app/api/v1")).toBe(false);
  });
});
