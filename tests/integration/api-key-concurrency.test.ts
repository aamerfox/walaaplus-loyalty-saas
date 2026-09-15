import { createHash, randomBytes, randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
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

import { createKey, MAX_ACTIVE_KEYS_PER_BUSINESS, revokeKey } from "@/server/api/keys";
import { createStampCafe, migratorPrisma, resetDatabase, type StampCafeFixture } from "../setup/fixtures";
import { resolveTestDatabaseUrls } from "../setup/test-env";

/**
 * The active-key ceiling and the revoke/rotate races, against **genuinely overlapping
 * transactions**.
 *
 * ## Why this file is separate, and why it is shaped this way
 *
 * Phase 3B taught this codebase the lesson the hard way, twice. A `SELECT count(*)` inside a
 * `BEFORE INSERT` trigger is **not** a ceiling: it reads only committed rows, so two overlapping
 * transactions each count four, each pass, and each commit. And a `Promise.all` of two Prisma
 * calls does **not** test that, because Prisma issues them as autocommit statements over one pool,
 * so they serialize and the second really does see the first's committed row.
 *
 * So the ceiling here is a **partial unique index over five slots**, and the proof holds one
 * transaction open on its own connection while another tries for the same slot — and binds the
 * claim to the second connection's own backend PID rather than to a global lock count or a sleep.
 *
 * `docs/evidence/phase-3b-prompt-3.md` §15 is the write-up of how those two mistakes were found.
 */

const WAIT_FOR_BLOCK_MS = 15_000;
const POLL_INTERVAL_MS = 25;
const TX_TIMEOUT_MS = 30_000;

let cafe: StampCafeFixture;
let a: PrismaClient;
let b: PrismaClient;

beforeEach(async () => {
  await resetDatabase();
  cafe = await createStampCafe({ name: "Race café" });
  session.userId = cafe.userId;

  const { runtime } = resolveTestDatabaseUrls();
  a = new PrismaClient({ datasources: { db: { url: runtime } } });
  b = new PrismaClient({ datasources: { db: { url: runtime } } });
  // Warm both pools, so a fresh client's connection setup can never be mistaken for blocking.
  await Promise.all([a.$queryRaw`SELECT 1`, b.$queryRaw`SELECT 1`]);
});

afterEach(async () => {
  session.userId = null;
  await Promise.allSettled([a.$disconnect(), b.$disconnect()]);
});

function insertSql(): string {
  return `INSERT INTO "ApiKey" ("id","businessId","name","keyPrefix","keyDigest","scope","state","activeSlot","issuedAt","expiresAt","createdAt")
     VALUES ($1::text, $2::text, $3::text, $4::text, $5::text, 'EVENTS_READ', 'ACTIVE', $6::int, now(), now() + interval '90 days', now())`;
}

function args(slot: number, name?: string): [string, string, string, string, string, number] {
  const raw = `wpk_${randomBytes(4).toString("hex")}_${randomBytes(32).toString("base64url")}`;
  return [
    randomUUID(),
    cafe.businessId,
    name ?? `Key ${randomUUID().slice(0, 8)}`,
    raw.slice(0, 12),
    createHash("sha256").update(raw, "utf8").digest("hex"),
    slot,
  ];
}

function watch<T>(promise: Promise<T>): { isSettled: () => boolean; result: Promise<T> } {
  let done = false;
  const result = promise.then(
    (v) => {
      done = true;
      return v;
    },
    (e: unknown) => {
      done = true;
      throw e;
    },
  );
  result.catch(() => undefined);
  return { isSettled: () => done, result };
}

/**
 * Poll the migrator connection until `pid` is waiting on an ungranted lock.
 *
 * Scoped to one PID. A global `WHERE NOT granted` count proves some backend somewhere is waiting,
 * which is not the claim.
 */
async function waitUntilBlocked(pid: number): Promise<{ locktype: string }> {
  const deadline = Date.now() + WAIT_FOR_BLOCK_MS;
  for (;;) {
    const rows = await migratorPrisma().$queryRaw<{ locktype: string }[]>`
      SELECT locktype FROM pg_locks WHERE pid = ${pid} AND NOT granted
    `;
    if (rows.length > 0) return rows[0];
    if (Date.now() > deadline) {
      throw new Error(`backend ${pid} never waited on a lock: nothing is serializing these inserts`);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

/** A holds slot `slot` in an open transaction until told to finish. */
async function holdSlotOnA(
  slot: number,
  name?: string,
): Promise<{ commit: () => void; rollback: () => void; done: Promise<unknown> }> {
  let release!: (commit: boolean) => void;
  const held = new Promise<boolean>((resolve) => {
    release = resolve;
  });
  let inserted!: () => void;
  const hasInserted = new Promise<void>((resolve) => {
    inserted = resolve;
  });

  const done = a
    .$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe(insertSql(), ...args(slot, name));
        inserted();
        if (!(await held)) throw new Error("deliberate rollback");
      },
      { timeout: TX_TIMEOUT_MS, maxWait: TX_TIMEOUT_MS },
    )
    .catch((e: unknown) => e);

  await hasInserted;
  return { commit: () => release(true), rollback: () => release(false), done };
}

/** B tries for the same slot, in its own transaction, reporting its PID before it submits. */
async function trySlotOnB(slot: number, name?: string): Promise<{
  pid: number;
  insert: { isSettled: () => boolean; result: Promise<unknown> };
  done: Promise<unknown>;
}> {
  let pidReady!: (pid: number) => void;
  const pidPromise = new Promise<number>((resolve) => {
    pidReady = resolve;
  });
  // Boxed: `await` on a Promise<Promise<T>> unwraps both levels and the handle would arrive as the
  // insert's eventual value rather than the insert itself.
  let handOut!: (box: { submitted: Promise<unknown> }) => void;
  const handle = new Promise<{ submitted: Promise<unknown> }>((resolve) => {
    handOut = resolve;
  });

  const done = b.$transaction(
    async (tx) => {
      const rows = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
      pidReady(Number(rows[0].pid));
      const submitted = tx.$executeRawUnsafe(insertSql(), ...args(slot, name));
      handOut({ submitted });
      await submitted;
      return "committed";
    },
    { timeout: TX_TIMEOUT_MS, maxWait: TX_TIMEOUT_MS },
  );
  done.catch(() => undefined);

  return { pid: await pidPromise, insert: watch((await handle).submitted), done };
}

function activeKeys(): Promise<number> {
  return migratorPrisma().apiKey.count({ where: { businessId: cafe.businessId, state: "ACTIVE" } });
}

describe("two overlapping transactions cannot both take one slot", () => {
  it("blocks B specifically, then refuses it from the slot index once A commits", async () => {
    const first = await holdSlotOnA(1);
    const second = await trySlotOnB(1);

    const wait = await waitUntilBlocked(second.pid);
    expect(wait.locktype, "B is waiting, but not on another transaction").toBe("transactionid");
    expect(second.insert.isSettled(), "B is recorded as waiting yet its INSERT already finished").toBe(false);

    first.commit();
    await first.done;

    // Refused by the INDEX. The trigger cannot have decided this: it ran before A committed.
    await expect(second.insert.result).rejects.toThrow(/23505/);
    await expect(second.insert.result).rejects.toThrow(/Key \("businessId", "activeSlot"\)=/);

    await second.done.catch(() => undefined);
    expect(await activeKeys()).toBe(1);
  }, 60_000);

  it("lets B have the slot if A rolls back", async () => {
    const first = await holdSlotOnA(1);
    const second = await trySlotOnB(1);

    const wait = await waitUntilBlocked(second.pid);
    expect(wait.locktype).toBe("transactionid");
    expect(second.insert.isSettled()).toBe(false);

    first.rollback();
    await first.done;
    await second.insert.result;
    await expect(second.done).resolves.toBe("committed");

    expect(await activeKeys()).toBe(1);
  }, 60_000);

  it("does not serialize different slots against each other", async () => {
    const first = await holdSlotOnA(1);
    const second = await trySlotOnB(2);
    // No wait to observe: a different slot is a different index entry.
    await second.insert.result;
    await expect(second.done).resolves.toBe("committed");
    first.commit();
    await first.done;
    expect(await activeKeys()).toBe(2);
  }, 60_000);
});

describe("two overlapping transactions cannot both take one live NAME", () => {
  /*
   * Migration 19's guarantee, under real concurrency.
   *
   * The active-name rule used to be an unconditional unique index; migration 19 replaced it with a
   * partial one predicated on ACTIVE. A partial unique index is still serialized by PostgreSQL —
   * the second inserter blocks on the first's uncommitted entry — and this proves it rather than
   * assuming it, because the whole reason the ceiling is an index and not a trigger is that a
   * trigger reading committed rows would let both through.
   *
   * **The two inserts use DIFFERENT SLOTS on purpose.** Same slot would be serialized by
   * `ApiKey_businessId_activeSlot_key`, and the test would pass while proving nothing about the
   * name. Different slots means the only thing that can serialize them is the name index.
   */
  it("blocks B specifically, then refuses it from the active-name index once A commits", async () => {
    const first = await holdSlotOnA(1, "Contested");
    const second = await trySlotOnB(2, "Contested");

    const wait = await waitUntilBlocked(second.pid);
    expect(wait.locktype, "B is waiting, but not on another transaction").toBe("transactionid");
    expect(second.insert.isSettled(), "B is recorded as waiting yet its INSERT already finished").toBe(false);

    first.commit();
    await first.done;

    // Refused by the NAME index, named in the error. Not the slot index: the slots differ.
    await expect(second.insert.result).rejects.toThrow(/23505/);
    /*
     * PostgreSQL quotes only the identifiers that need it, so the detail reads
     * `Key ("businessId", name)=` - camelCase quoted, `name` bare. Matched as the database actually
     * writes it, and still specific enough to distinguish this from the slot index's
     * `("businessId", "activeSlot")`.
     */
    await expect(second.insert.result).rejects.toThrow(/Key \("businessId", "?name"?\)=/);

    await second.done.catch(() => undefined);
    expect(await activeKeys()).toBe(1);
  });

  it("lets B have the name if A rolls back", async () => {
    const first = await holdSlotOnA(1, "Contested");
    const second = await trySlotOnB(2, "Contested");

    await waitUntilBlocked(second.pid);
    first.rollback();
    await first.done;

    // A's entry never committed, so the name was never taken.
    await expect(second.insert.result).resolves.toBeDefined();
    await second.done;
    expect(await activeKeys()).toBe(1);
  });

  it("does not serialize two different names against each other", async () => {
    // The control. If this blocked, the index would be constraining more than it should and the
    // test above would be proving something other than what it claims.
    const first = await holdSlotOnA(1, "One");
    const second = await trySlotOnB(2, "Two");

    await expect(second.insert.result).resolves.toBeDefined();
    first.commit();
    await first.done;
    await second.done;
    expect(await activeKeys()).toBe(2);
  });

  it("stops constraining a name once the holder leaves ACTIVE, even under contention", async () => {
    /*
     * The other half of the partial predicate. A revoked row keeps its name but leaves the index,
     * so a concurrent insert of that name must NOT block on it — which is exactly what makes
     * same-name rotation work.
     */
    const created = await createKey(cafe.ctx, { name: "Recycled" });
    await revokeKey(cafe.ctx, created.key.id);

    const first = await holdSlotOnA(1, "Recycled");
    // A holds an uncommitted ACTIVE "Recycled"; the revoked row is irrelevant to both.
    const second = await trySlotOnB(2, "Recycled");
    await waitUntilBlocked(second.pid);
    first.commit();
    await first.done;
    await expect(second.insert.result).rejects.toThrow(/23505/);
    await second.done.catch(() => undefined);

    // One live "Recycled" plus the revoked predecessor.
    expect(await activeKeys()).toBe(1);
    expect(await migratorPrisma().apiKey.count({ where: { businessId: cafe.businessId, name: "Recycled" } })).toBe(2);
  });
});

describe("the ceiling holds when every caller asks at once", () => {
  it("never issues more than the maximum, however many create concurrently", async () => {
    /*
     * Twelve simultaneous `createKey` calls against a ceiling of five. Each one reads the free
     * slots, picks the lowest and inserts; the losers retry against a different slot and the ones
     * with nowhere to go are told the ceiling is reached.
     *
     * The assertion is not "exactly five succeeded" - it is that **never more than five** did and
     * that the database agrees, because over-issue is the failure that matters. Under-issue would
     * be a usability bug; over-issue is a credential the ceiling was supposed to prevent.
     */
    const attempts = await Promise.allSettled(
      Array.from({ length: 12 }, (_, i) => createKey(cafe.ctx, { name: `Concurrent ${i}` })),
    );
    const issued = attempts.filter((r) => r.status === "fulfilled").length;

    expect(issued).toBeGreaterThan(0);
    expect(issued).toBeLessThanOrEqual(MAX_ACTIVE_KEYS_PER_BUSINESS);
    expect(await activeKeys()).toBe(issued);
    expect(await activeKeys()).toBeLessThanOrEqual(MAX_ACTIVE_KEYS_PER_BUSINESS);

    /*
     * Every failure is a refusal this product chose.
     *
     * This assertion found a real defect: before the fix, a caller still WAITING on another
     * transaction's slot entry when its own interactive transaction timed out surfaced a raw
     * transaction error rather than a message. The safety property held throughout - never more
     * than five - but an owner could be shown the wrong thing. `isSlotRace` now treats contention
     * as a retry whichever of the two ways PostgreSQL reports it.
     */
    for (const attempt of attempts) {
      if (attempt.status === "rejected") {
        expect(String(attempt.reason)).toMatch(/active API keys|already in use/i);
      }
    }
  }, 60_000);
});

describe("revocation happens once, even from two callers at the same moment", () => {
  it("lets exactly one concurrent revoke succeed", async () => {
    const created = await createKey(cafe.ctx, { name: "Doomed" });
    const both = await Promise.allSettled([
      revokeKey(cafe.ctx, created.key.id),
      revokeKey(cafe.ctx, created.key.id),
    ]);
    expect(both.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(both.filter((r) => r.status === "rejected")).toHaveLength(1);

    const row = await migratorPrisma().apiKey.findFirstOrThrow({
      where: { id: created.key.id },
      select: { state: true, revokedAt: true, activeSlot: true },
    });
    expect(row.state).toBe("REVOKED");
    expect(row.revokedAt).not.toBeNull();
    expect(row.activeSlot).toBeNull();
  }, 60_000);

  it("leaves one live key after two concurrent rotations of the same key", async () => {
    /*
     * A rotation revokes the predecessor and issues a replacement in one transaction. Two of them
     * racing must not produce two live successors, and must not leave the original live either.
     */
    const { rotateKey } = await import("@/server/api/keys");
    const created = await createKey(cafe.ctx, { name: "Original" });

    const both = await Promise.allSettled([
      rotateKey(cafe.ctx, created.key.id, "Rotated A"),
      rotateKey(cafe.ctx, created.key.id, "Rotated B"),
    ]);
    const succeeded = both.filter((r) => r.status === "fulfilled").length;
    expect(succeeded).toBe(1);

    const original = await migratorPrisma().apiKey.findFirstOrThrow({
      where: { id: created.key.id },
      select: { state: true },
    });
    expect(original.state).toBe("REVOKED");
    expect(await activeKeys()).toBe(1);
  }, 60_000);
});

describe("expiry frees a slot without a scheduled job", () => {
  it("lets a business at its ceiling issue again once a key has lapsed", async () => {
    for (let i = 0; i < MAX_ACTIVE_KEYS_PER_BUSINESS; i += 1) {
      await createKey(cafe.ctx, { name: `Full ${i}` });
    }
    await expect(createKey(cafe.ctx, { name: "One too many" })).rejects.toThrow(/active API keys/);

    // Age one key past its expiry. The migrator does it because `expiresAt` is frozen to everyone
    // else — which is itself the point: a key cannot extend or shorten its own life.
    const oldest = await migratorPrisma().apiKey.findFirstOrThrow({
      where: { businessId: cafe.businessId, state: "ACTIVE" },
      orderBy: { createdAt: "asc" },
      select: { id: true },
    });
    /*
     * The guard is turned off for exactly this statement, because `expiresAt` is frozen to
     * EVERYONE - the migrator included. That refusal is the guarantee working, not an obstacle: a
     * key cannot extend or shorten its own life, and neither can anything else. Ageing one is a
     * thing only a test has any business doing.
     */
    await migratorPrisma().$executeRawUnsafe('ALTER TABLE "ApiKey" DISABLE TRIGGER api_key_guard');
    try {
      /*
       * BOTH times move. `ApiKey_expires_after_issue` is a table CHECK rather than a trigger rule,
       * so disabling the guard does not bypass it - and rightly: a key that expires before it was
       * issued is not a key. Ageing one means making it genuinely old, which is what a lapsed key
       * actually looks like.
       */
      await migratorPrisma().$executeRawUnsafe(
        `UPDATE "ApiKey"
            SET "issuedAt"  = now() - interval '100 days',
                "expiresAt" = now() - interval '1 day'
          WHERE "id" = $1::text`,
        oldest.id,
      );
    } finally {
      await migratorPrisma().$executeRawUnsafe('ALTER TABLE "ApiKey" ENABLE TRIGGER api_key_guard');
    }

    const replacement = await createKey(cafe.ctx, { name: "After expiry" });
    expect(replacement.apiKey).toBeTruthy();

    const lapsed = await migratorPrisma().apiKey.findFirstOrThrow({
      where: { id: oldest.id },
      select: { state: true, activeSlot: true },
    });
    expect(lapsed.state).toBe("EXPIRED");
    expect(lapsed.activeSlot).toBeNull();
    expect(await activeKeys()).toBe(MAX_ACTIVE_KEYS_PER_BUSINESS);
  }, 60_000);
});
