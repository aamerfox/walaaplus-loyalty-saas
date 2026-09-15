import { createHash, randomBytes, randomUUID } from "node:crypto";
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

import { prisma } from "@/server/db";
import { MAX_ACTIVE_KEYS_PER_BUSINESS } from "@/server/api/keys";
import { createStampCafe, migratorPrisma, resetDatabase, type StampCafeFixture } from "../setup/fixtures";

/**
 * What the DATABASE refuses about an API key, with no service in the way.
 *
 * `api-keys.test.ts` proves the services write correct rows; this proves a correct row is the only
 * kind the database accepts. Every write below goes through `prisma`, the **restricted runtime
 * client** — the same role `web` and `worker` hold — exactly as a second service, a backfill script
 * or a console session would.
 *
 * A key is a bearer credential. The rules that matter most are the ones a foreign key cannot
 * express: that the business it belongs to can never change, that the digest can never be swapped
 * for another, and that there are only ever five active at once however many callers ask at the
 * same moment.
 */

const DAY = 24 * 60 * 60 * 1000;

let cafe: StampCafeFixture;

beforeEach(async () => {
  await resetDatabase();
  cafe = await createStampCafe({ name: "Key café" });
  session.userId = cafe.userId;
});

afterEach(() => {
  session.userId = null;
});

function digestOf(raw: string): string {
  return createHash("sha256").update(raw, "utf8").digest("hex");
}

/** A well-formed row, through the runtime role. Overrides let each test break exactly one rule. */
function keyRow(overrides: Record<string, unknown> = {}) {
  const raw = `wpk_${randomBytes(4).toString("hex")}_${randomBytes(32).toString("base64url")}`;
  return {
    businessId: cafe.businessId,
    name: `Key ${randomUUID().slice(0, 8)}`,
    keyPrefix: raw.slice(0, 12),
    keyDigest: digestOf(raw),
    scope: "EVENTS_READ" as const,
    activeSlot: 1,
    issuedAt: new Date(),
    expiresAt: new Date(Date.now() + 90 * DAY),
    createdByUserId: cafe.userId,
    ...overrides,
  };
}

function create(overrides: Record<string, unknown> = {}) {
  return prisma.apiKey.create({ data: keyRow(overrides), select: { id: true } });
}

describe("a key has to be the right shape", () => {
  it("accepts a well-formed key", async () => {
    const row = await create();
    expect(row.id).toBeTruthy();
  });

  it("refuses a digest that is not a sha256", async () => {
    // The likeliest thing in this column that is not a digest is the key itself.
    for (const keyDigest of ["not-a-digest", "ABCDEF0123456789".repeat(4), "0".repeat(63), "0".repeat(65), ""]) {
      await expect(create({ keyDigest }), keyDigest.slice(0, 12)).rejects.toThrow();
    }
  });

  it("refuses a prefix that could hold a secret", async () => {
    for (const keyPrefix of [`wpk_${randomBytes(32).toString("base64url")}`, "wpk_", "sk_live_abcd", "wpk_ZZZZZZZZ"]) {
      await expect(create({ keyPrefix }), keyPrefix.slice(0, 16)).rejects.toThrow();
    }
  });

  it("refuses two keys sharing a digest", async () => {
    const shared = digestOf("a-value");
    await create({ keyDigest: shared });
    await expect(create({ keyDigest: shared, activeSlot: 2 })).rejects.toThrow();
  });

  it("refuses a key that expires before it was issued, or is already expired", async () => {
    await expect(create({ expiresAt: new Date(Date.now() - DAY) })).rejects.toThrow();
  });

  it("refuses a blank or over-long name", async () => {
    await expect(create({ name: "   " })).rejects.toThrow();
    await expect(create({ name: "x".repeat(61) })).rejects.toThrow();
  });

  it("refuses one created already revoked, already used, or not active", async () => {
    await expect(create({ state: "REVOKED", activeSlot: null, revokedAt: new Date() })).rejects.toThrow(/new key is active/);
    await expect(create({ state: "EXPIRED", activeSlot: null })).rejects.toThrow(/new key is active/);
    await expect(create({ lastUsedAt: new Date() })).rejects.toThrow(/not been used or revoked/);
  });

  it("assigns the issue time itself", async () => {
    const supplied = new Date(Date.now() - 365 * DAY);
    const row = await prisma.apiKey.create({ data: keyRow({ issuedAt: supplied }), select: { issuedAt: true } });
    expect(row.issuedAt.getTime()).not.toBe(supplied.getTime());
  });

  it("refuses an active key with no slot, and a dead key holding one", async () => {
    await expect(create({ activeSlot: null })).rejects.toThrow();
    await expect(create({ activeSlot: MAX_ACTIVE_KEYS_PER_BUSINESS + 1 })).rejects.toThrow();
    await expect(create({ activeSlot: 0 })).rejects.toThrow();
  });

  it("refuses a rotation that names another business's key", async () => {
    const theirs = await createStampCafe({ name: "Other café" });
    session.userId = theirs.userId;
    const theirKey = await prisma.apiKey.create({
      data: {
        businessId: theirs.businessId,
        name: "Theirs",
        keyPrefix: "wpk_00000001",
        keyDigest: digestOf("theirs"),
        scope: "EVENTS_READ",
        activeSlot: 1,
        issuedAt: new Date(),
        expiresAt: new Date(Date.now() + 90 * DAY),
      },
      select: { id: true },
    });
    session.userId = cafe.userId;
    await expect(create({ rotatedFromId: theirKey.id })).rejects.toThrow(/does not belong to this business/);
  });
});

describe("what a key IS cannot change", () => {
  let keyId: string;

  beforeEach(async () => {
    keyId = (await create()).id;
  });

  it("refuses a changed business, digest, prefix, scope, name or either time", async () => {
    const other = await createStampCafe({ name: "Elsewhere" });
    for (const data of [
      { businessId: other.businessId },
      { keyDigest: digestOf("something-else") },
      { keyPrefix: "wpk_deadbeef" },
      { name: "Renamed" },
      { issuedAt: new Date(Date.now() - DAY) },
      { expiresAt: new Date(Date.now() + 365 * DAY) },
    ]) {
      await expect(
        prisma.apiKey.update({ where: { id: keyId }, data }),
        JSON.stringify(Object.keys(data)),
      ).rejects.toThrow(/cannot change, only how it is going/);
    }
  });

  it("refuses an active key changing the slot it was issued", async () => {
    await expect(
      prisma.apiKey.update({ where: { id: keyId }, data: { activeSlot: 3 } }),
    ).rejects.toThrow(/keeps the slot it was issued/);
  });

  it("revokes exactly once, and stamps its own time", async () => {
    const revoked = await prisma.apiKey.update({
      where: { id: keyId },
      data: { state: "REVOKED", activeSlot: null },
      select: { revokedAt: true, state: true },
    });
    expect(revoked.state).toBe("REVOKED");
    expect(revoked.revokedAt).not.toBeNull();

    // Terminal. Nothing brings it back, and nothing rewrites when it happened.
    await expect(
      prisma.apiKey.update({ where: { id: keyId }, data: { state: "ACTIVE", activeSlot: 1 } }),
    ).rejects.toThrow(/is a rest state/);
    await expect(
      prisma.apiKey.update({ where: { id: keyId }, data: { revokedAt: new Date(Date.now() - DAY) } }),
    ).rejects.toThrow(/written once/);
  });

  it("refuses a dead key that keeps its slot", async () => {
    await expect(
      prisma.apiKey.update({ where: { id: keyId }, data: { state: "REVOKED" } }),
    ).rejects.toThrow(/holds no slot/);
  });

  it("moves lastUsedAt forward only, and never back to nothing", async () => {
    const t1 = new Date();
    await prisma.apiKey.update({ where: { id: keyId }, data: { lastUsedAt: t1 } });
    await prisma.apiKey.update({ where: { id: keyId }, data: { lastUsedAt: new Date(t1.getTime() + 1000) } });

    await expect(
      prisma.apiKey.update({ where: { id: keyId }, data: { lastUsedAt: new Date(t1.getTime() - 1000) } }),
    ).rejects.toThrow(/forward only/);
    await expect(
      prisma.apiKey.update({ where: { id: keyId }, data: { lastUsedAt: null } }),
    ).rejects.toThrow(/never unrecorded/);
  });

  it("is never deleted or truncated — and each layer is asserted separately", async () => {
    /*
     * TWO protections, asserted apart rather than together.
     *
     * The first version of this accepted `/never removed|permission denied/i` from either caller,
     * which meant the grant satisfied it while the trigger was missing - and the red proof for the
     * delete trigger came back GREEN, because the assertion could not tell the layers apart. An
     * assertion that passes when either of two protections is present tests neither.
     *
     * So: the runtime role is stopped by the GRANT, and the migrator - which owns the table and
     * does hold DELETE - is stopped by the TRIGGER.
     */
    await expect(prisma.apiKey.delete({ where: { id: keyId } })).rejects.toThrow(/permission denied/i);
    await expect(prisma.$executeRawUnsafe('DELETE FROM "ApiKey"')).rejects.toThrow(/permission denied/i);

    await expect(
      migratorPrisma().$executeRawUnsafe(`DELETE FROM "ApiKey" WHERE "id" = $1::text`, keyId),
    ).rejects.toThrow(/never removed/);
    await expect(migratorPrisma().$executeRawUnsafe('TRUNCATE TABLE "ApiKey"')).rejects.toThrow(/never removed/);
  });
});

describe("the active-key ceiling is the database's, not the service's", () => {
  it("agrees with the constant the service uses", async () => {
    // The index has exactly this many slots; the CHECK names the same number. If somebody raises
    // the constant without the migration, this is what says so.
    const rows = await migratorPrisma().$queryRaw<{ def: string }[]>`
      SELECT pg_get_constraintdef(c.oid) AS def
        FROM pg_constraint c
        JOIN pg_class t ON t.oid = c.conrelid
       WHERE t.relname = 'ApiKey' AND c.conname = 'ApiKey_slot_iff_active'
    `;
    expect(rows).toHaveLength(1);
    // PostgreSQL stores BETWEEN normalised into two comparisons, so the assertion reads the form
    // the database actually holds rather than the form the migration was written in.
    expect(rows[0].def).toContain('("activeSlot" >= 1)');
    expect(rows[0].def).toContain(`("activeSlot" <= ${MAX_ACTIVE_KEYS_PER_BUSINESS})`);
  });

  it("carries the partial unique index that enforces it", async () => {
    const rows = await migratorPrisma().$queryRaw<{ indexdef: string }[]>`
      SELECT indexdef FROM pg_indexes
       WHERE schemaname = 'public' AND tablename = 'ApiKey'
         AND indexname = 'ApiKey_businessId_activeSlot_key'
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0].indexdef).toContain("CREATE UNIQUE INDEX");
    expect(rows[0].indexdef).toContain('"businessId"');
    expect(rows[0].indexdef).toMatch(/WHERE .*"activeSlot" IS NOT NULL/);
  });

  it("refuses a sixth active key, sequentially", async () => {
    for (let slot = 1; slot <= MAX_ACTIVE_KEYS_PER_BUSINESS; slot += 1) await create({ activeSlot: slot });
    // Every slot is taken; there is no sixth number the CHECK allows.
    await expect(create({ activeSlot: MAX_ACTIVE_KEYS_PER_BUSINESS + 1 })).rejects.toThrow();
    await expect(create({ activeSlot: 1 })).rejects.toThrow();
  });

  it("frees a slot when a key is revoked, and not before", async () => {
    const first = await create({ activeSlot: 1 });
    await expect(create({ activeSlot: 1 })).rejects.toThrow();
    await prisma.apiKey.update({ where: { id: first.id }, data: { state: "REVOKED", activeSlot: null } });
    const replacement = await create({ activeSlot: 1 });
    expect(replacement.id).toBeTruthy();
  });

  it("bounds each business independently", async () => {
    for (let slot = 1; slot <= MAX_ACTIVE_KEYS_PER_BUSINESS; slot += 1) await create({ activeSlot: slot });
    const other = await createStampCafe({ name: "Their café" });
    const theirs = await prisma.apiKey.create({
      data: {
        businessId: other.businessId,
        name: "Theirs",
        keyPrefix: "wpk_11111111",
        keyDigest: digestOf("theirs-1"),
        scope: "EVENTS_READ",
        activeSlot: 1,
        issuedAt: new Date(),
        expiresAt: new Date(Date.now() + 90 * DAY),
      },
      select: { id: true },
    });
    expect(theirs.id).toBeTruthy();
  });
});
