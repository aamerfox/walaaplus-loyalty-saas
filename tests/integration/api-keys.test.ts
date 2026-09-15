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
import { ApiKeyState, MembershipRole } from "@prisma/client";
import { AuditAction } from "@/server/audit/audit";
import { ConflictCode, ConflictError, ForbiddenError } from "@/server/errors";
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

/**
 * Age a key in the database, behind the guard.
 *
 * `api_key_guard` refuses a change to `issuedAt` or `expiresAt` from anybody, which is the point of
 * it — so ageing one is a migrator act with the trigger off, not something a service can do. Both
 * timestamps move together because `ApiKey_expires_after_issue` is a table CHECK and stays on.
 */
async function ageKey(id: string, alsoSet = ""): Promise<void> {
  await migratorPrisma().$executeRawUnsafe('ALTER TABLE "ApiKey" DISABLE TRIGGER api_key_guard');
  try {
    await migratorPrisma().$executeRawUnsafe(
      `UPDATE "ApiKey" SET "issuedAt" = now() - interval '100 days',
         "expiresAt" = now() - interval '1 day'${alsoSet} WHERE "id" = $1::text`,
      id,
    );
  } finally {
    await migratorPrisma().$executeRawUnsafe('ALTER TABLE "ApiKey" ENABLE TRIGGER api_key_guard');
  }
}

/** Past its expiry AND swept: the terminal state. The slot goes, as `ApiKey_slot_iff_active` demands. */
const expireKey = (id: string) => ageKey(id, `, "state" = 'EXPIRED', "activeSlot" = NULL`);

/**
 * Past its expiry but NOT swept: `state` is still ACTIVE and the slot is still held.
 *
 * This is the ordinary condition of a lapsed key rather than a contrived one — the sweep runs only
 * when a key is issued, so a business that stops issuing leaves its lapsed keys exactly here.
 */
const lapseKey = (id: string) => ageKey(id);

/** Every audit action recorded about one key, oldest first. */
async function auditFor(keyId: string): Promise<string[]> {
  const rows = await migratorPrisma().auditLog.findMany({
    where: { entityType: "ApiKey", entityId: keyId },
    orderBy: { createdAt: "asc" },
    select: { action: true },
  });
  return rows.map((r) => r.action);
}

/** The row as the database holds it — not as a view chooses to present it. */
async function storedKey(id: string) {
  return migratorPrisma().apiKey.findFirstOrThrow({
    where: { id },
    select: { state: true, revokedAt: true, activeSlot: true },
  });
}

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
    // One revocation, one audit row. The refused second attempt adds nothing.
    expect(await auditFor(created.key.id)).toEqual([AuditAction.API_KEY_CREATED, AuditAction.API_KEY_REVOKED]);
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

  it("refuses an EXPIRED key the same way, and changes nothing doing it", async () => {
    /*
     * The regression this exists for.
     *
     * `revokeKey` used to guard only against REVOKED. An EXPIRED key walked past that clause into
     * the UPDATE and was stopped by `api_key_guard` as a rest-state transition — a raw database
     * error in the place a controlled conflict was intended. Both rest states are terminal, so both
     * produce the same conflict, and neither writes anything.
     */
    const created = await createKey(cafe.ctx, { name: "Lapsed and swept" });
    await expireKey(created.key.id);
    const before = await auditFor(created.key.id);

    const error = await revokeKey(cafe.ctx, created.key.id).catch((e: unknown) => e);
    // A conflict, not a database message: the trigger error would be a 500 on the owner route in
    // Prompt 2, carrying PostgreSQL's own words to whoever read it.
    expect(error).toBeInstanceOf(ConflictError);
    expect((error as ConflictError).code).toBe(ConflictCode.API_KEY_NOT_ACTIVE);
    expect((error as ConflictError).status).toBe(409);
    expect((error as ConflictError).message).toMatch(/expired/i);
    expect((error as ConflictError).message).not.toMatch(/rest state|check_violation|ApiKey:/);

    // Nothing moved: not the state, not the revocation stamp, not the slot.
    expect(await storedKey(created.key.id)).toEqual({
      state: ApiKeyState.EXPIRED,
      revokedAt: null,
      activeSlot: null,
    });
    // And no audit row, because a refused action is not an action.
    expect(await auditFor(created.key.id)).toEqual(before);
    expect(before).not.toContain(AuditAction.API_KEY_REVOKED);

    // The caller-facing answer is untouched by any of this: still refused, still one sentence.
    await expect(authenticateApiKey(created.apiKey)).resolves.toMatchObject({ ok: false, reason: "EXPIRED" });
    expect(JSON.stringify(apiUnauthorized())).not.toMatch(/revoked|expired|unknown|malformed|missing/i);
  });

  it("revokes a key whose expiry has passed but whose state is still ACTIVE", async () => {
    /*
     * The stated behaviour for the in-between state, and why it is that way.
     *
     * The sweep to EXPIRED is lazy, so a lapsed key keeps `state = ACTIVE` until this business
     * issues another. `revokeKey` decides on `state` alone — the same column `api_key_guard`
     * decides on — so it accepts this one. That is useful rather than merely permitted: it releases
     * the slot, and it records that the owner ended the key rather than let it run out.
     *
     * Access does not turn on it. The key was already refused before this call and is still refused
     * after, because `authenticateApiKey` reads `expiresAt` and does not trust `state`.
     */
    const created = await createKey(cafe.ctx, { name: "Lapsed, unswept" });
    await lapseKey(created.key.id);

    expect(await storedKey(created.key.id)).toMatchObject({ state: ApiKeyState.ACTIVE });
    await expect(authenticateApiKey(created.apiKey)).resolves.toMatchObject({ ok: false, reason: "EXPIRED" });

    const revoked = await revokeKey(cafe.ctx, created.key.id);
    expect(revoked.state).toBe(ApiKeyState.REVOKED);
    // `usable` was already false on the clock; now it is false on the state as well.
    expect(revoked.usable).toBe(false);
    expect(revoked.revokedAt).not.toBeNull();

    const stored = await storedKey(created.key.id);
    expect(stored.state).toBe(ApiKeyState.REVOKED);
    expect(stored.activeSlot).toBeNull();
    expect(await auditFor(created.key.id)).toEqual([AuditAction.API_KEY_CREATED, AuditAction.API_KEY_REVOKED]);

    // Refused before, refused after, and the wire answer never said which.
    await expect(authenticateApiKey(created.apiKey)).resolves.toMatchObject({ ok: false, reason: "REVOKED" });
    expect(JSON.stringify(apiUnauthorized())).not.toMatch(/revoked|expired|unknown|malformed|missing/i);

    // Terminal once it lands there: a second attempt is the conflict, not a second audit row.
    await expect(revokeKey(cafe.ctx, created.key.id)).rejects.toThrow(/already revoked/);
    expect(await auditFor(created.key.id)).toHaveLength(2);
  });

  it("stops accepting the revocation once the lazy sweep has run", async () => {
    /*
     * The documented wrinkle, tested rather than smoothed over: which sentence an owner reads for a
     * lapsed key depends on whether anything has issued a key since. Nothing security-relevant
     * differs — the key is unusable either way and its slot is free either way — but the product
     * says so out loud instead of pretending the two paths are identical.
     */
    const lapsed = await createKey(cafe.ctx, { name: "Lapsed" });
    await lapseKey(lapsed.key.id);

    // Issuing anything sweeps it. Issuing is the only thing that does.
    await createKey(cafe.ctx, { name: "The sweep" });
    expect(await storedKey(lapsed.key.id)).toEqual({
      state: ApiKeyState.EXPIRED,
      revokedAt: null,
      activeSlot: null,
    });

    const error = await revokeKey(cafe.ctx, lapsed.key.id).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConflictError);
    expect((error as ConflictError).code).toBe(ConflictCode.API_KEY_NOT_ACTIVE);
    expect((error as ConflictError).message).toMatch(/expired/i);
    expect(await auditFor(lapsed.key.id)).toEqual([AuditAction.API_KEY_CREATED]);
  });

  it("refuses to rotate an EXPIRED key, with the same conflict and no successor", async () => {
    const created = await createKey(cafe.ctx, { name: "Too late" });
    await expireKey(created.key.id);

    const error = await rotateKey(cafe.ctx, created.key.id, "Successor").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConflictError);
    expect((error as ConflictError).code).toBe(ConflictCode.API_KEY_NOT_ACTIVE);
    // And nothing was minted on the way to that refusal.
    expect((await listKeys(cafe.ctx)).map((k) => k.name)).toEqual(["Too late"]);
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

    // Lapsed but unswept, deliberately: `expiresAt` is the authority, not the bookkeeping state.
    const expired = await createKey(cafe.ctx, { name: "Expired" });
    await lapseKey(expired.key.id);

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

  it("has added exactly one public surface, and it is read-only", async () => {
    /*
     * Prompt 1's version of this asserted that `src/app/api/v1` did not exist, which was the right
     * assertion while the key had nothing to open. Prompt 2 mounts the surface, so the claim becomes
     * a bound on it: two GET routes, and no verb that could write.
     *
     * `tests/unit/api-contract.test.ts` holds the same bound by reading the source; this one holds it
     * by importing the modules, so a handler added at runtime rather than in a file would still be
     * caught.
     */
    const list = await import("@/app/api/v1/events/route");
    const single = await import("@/app/api/v1/events/[eventId]/route");
    for (const mod of [list, single]) {
      expect(Object.keys(mod).sort()).toEqual(["GET", "dynamic"]);
    }

    const { readdirSync } = await import("node:fs");
    // One resource under /api/v1, and it is `events`.
    expect(readdirSync("src/app/api/v1")).toEqual(["events"]);
  });
});
