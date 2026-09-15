import { randomBytes, randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

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

import { createDestination, setDestinationState } from "@/server/integrations/webhooks/destinations";
import { createStampCafe, migratorPrisma, resetDatabase, type StampCafeFixture } from "../setup/fixtures";
import { resolveTestDatabaseUrls } from "../setup/test-env";

/**
 * One waiting test delivery per destination, proved against **genuinely overlapping transactions**.
 *
 * ## Three versions of this proof, and why the first two were not proofs
 *
 * **First:** a `BEFORE INSERT` trigger running `SELECT ... EXISTS`, claimed to be concurrency-safe.
 * It is not — that check reads only **committed** rows, so two overlapping transactions each find
 * nothing, each pass, and each commit. The evidence offered was `Promise.all` of two Prisma
 * `create` calls, which Prisma issues as two autocommit statements over **one** pool: they
 * serialized, the second genuinely saw the first's committed row, and *sequential* refusal was read
 * as concurrency safety.
 *
 * **Second:** two pools and the first transaction held open, with "B blocked" inferred from a fixed
 * 750 ms sleep. A fresh `PrismaClient`'s first query includes connecting and starting a query
 * engine, and that alone outlasted the sleep — B was still connecting, A committed, and the
 * *trigger* then refused B. The blocking assertion passed with B never having reached the index.
 *
 * Then a third near-miss, fixed before it shipped: the sleep was replaced with
 * `SELECT count(*) FROM pg_locks WHERE NOT granted`, which proves *some* backend is waiting
 * somewhere — not that B is, and not that B is waiting on A.
 *
 * **This version** binds the claim to **B's own backend process**, and infers nothing from elapsed
 * time:
 *
 *   1. A opens an interactive transaction and inserts a waiting test — uncommitted;
 *   2. B opens its **own** interactive transaction, which pins one backend, and reads
 *      `pg_backend_pid()` **inside** it before submitting anything;
 *   3. B submits its INSERT;
 *   4. the **migrator** connection — a third backend, not in the race — polls `pg_locks` for
 *      **that exact PID** with `granted = false`, and requires a `transactionid` wait, which is
 *      what an inserter blocked on another transaction's uncommitted index entry waits on. It
 *      polls until B is demonstrably waiting, or gives up and fails saying so;
 *   5. with B confirmed waiting, its INSERT must still be unsettled;
 *   6. A commits → B is refused with **23505** from the partial unique index;
 *   7. and the mirror: A rolls back → B **succeeds**, because the rule is "one waiting test", not
 *      "one attempt ever".
 *
 * Both clients connect as the **restricted runtime role** — what `web` and `worker` hold.
 *
 * The guarantee under test is the partial unique index `WebhookDelivery_one_pending_test_key`
 * (migration 17). Dropping only that index makes B stop waiting and lets the duplicate through
 * despite the trigger — the red proof, and the original defect reproduced.
 */

/** How long to keep polling for B to appear as a waiter before declaring the proof failed. */
const WAIT_FOR_BLOCK_MS = 15_000;

/** Gap between polls. No assertion depends on this value — it is a poll interval, not a delay. */
const POLL_INTERVAL_MS = 25;

/** Interactive transactions here are held open deliberately; Prisma's default would abort them. */
const TX_TIMEOUT_MS = 30_000;

const INSERT = `INSERT INTO "WebhookDelivery" ("id", "businessId", "destinationId", "isTest", "status", "nextAttemptAt", "createdAt")
     VALUES ($1::text, $2::text, $3::text, true, 'PENDING', now(), now())`;

let savedKey: string | undefined;
let cafe: StampCafeFixture;
let destinationId: string;
let a: PrismaClient;
let b: PrismaClient;

beforeAll(() => {
  savedKey = process.env.INTEGRATION_ENCRYPTION_KEY;
  process.env.INTEGRATION_ENCRYPTION_KEY = randomBytes(32).toString("hex");
});

afterAll(() => {
  if (savedKey === undefined) delete process.env.INTEGRATION_ENCRYPTION_KEY;
  else process.env.INTEGRATION_ENCRYPTION_KEY = savedKey;
});

beforeEach(async () => {
  await resetDatabase();
  cafe = await createStampCafe({ name: "Concurrent café" });
  session.userId = cafe.userId;
  const created = await createDestination(cafe.ctx, { name: "Ops", url: "https://hooks.example.com/hook" });
  destinationId = created.destination.id;
  await setDestinationState(cafe.ctx, destinationId, "ENABLED");

  // Two clients, so two pools. One pool would serialize them and the test would prove nothing.
  const { runtime } = resolveTestDatabaseUrls();
  a = new PrismaClient({ datasources: { db: { url: runtime } } });
  b = new PrismaClient({ datasources: { db: { url: runtime } } });
  // Warm both. The PID check would catch connection latency anyway; this keeps a failure obvious
  // rather than clever.
  await Promise.all([a.$queryRaw`SELECT 1`, b.$queryRaw`SELECT 1`]);
});

afterEach(async () => {
  await Promise.allSettled([a.$disconnect(), b.$disconnect()]);
});

/** Has this promise settled? Paired with the PID check, never used on its own. */
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

interface LockWait {
  locktype: string;
  mode: string;
}

/**
 * Poll the MIGRATOR connection until backend `pid` is waiting on an ungranted lock.
 *
 * Scoped to one PID on purpose. An earlier version asked
 * `SELECT count(*) FROM pg_locks WHERE NOT granted` and asserted it was above zero, which proves
 * *some* backend somewhere is waiting — not that B is, and not that B is waiting on A. Any
 * unrelated wait anywhere in the database would have satisfied it.
 */
async function waitUntilBlocked(pid: number): Promise<LockWait> {
  const deadline = Date.now() + WAIT_FOR_BLOCK_MS;
  for (;;) {
    const rows = await migratorPrisma().$queryRaw<LockWait[]>`
      SELECT locktype, mode
        FROM pg_locks
       WHERE pid = ${pid} AND NOT granted
    `;
    if (rows.length > 0) return rows[0];
    if (Date.now() > deadline) {
      throw new Error(`backend ${pid} never waited on a lock: nothing is serializing these inserts`);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

/** A's side: open a transaction, insert, and hold it open until told to commit or roll back. */
async function holdOpenInsertOnA(): Promise<{ commit: () => void; rollback: () => void; done: Promise<unknown> }> {
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
        await tx.$executeRawUnsafe(INSERT, randomUUID(), cafe.businessId, destinationId);
        inserted();
        if (!(await held)) throw new Error("deliberate rollback");
      },
      { timeout: TX_TIMEOUT_MS, maxWait: TX_TIMEOUT_MS },
    )
    .catch((e: unknown) => e);

  await hasInserted;
  return { commit: () => release(true), rollback: () => release(false), done };
}

interface BAttempt {
  pid: number;
  insert: { isSettled: () => boolean; result: Promise<unknown> };
  done: Promise<unknown>;
}

/**
 * B's side: its own interactive transaction, so it holds ONE backend for the whole attempt.
 *
 * The PID is read inside that transaction and handed out **before** the INSERT is submitted, so the
 * poller is watching the same backend that is about to block. That is the whole point of the file:
 * the proof is about this process, not about the database in general.
 */
async function insertOnBInItsOwnTransaction(destination: string = destinationId): Promise<BAttempt> {
  let pidReady!: (pid: number) => void;
  const pidPromise = new Promise<number>((resolve) => {
    pidReady = resolve;
  });
  /*
   * Boxed in an object on purpose. `await` on a `Promise<Promise<T>>` unwraps BOTH levels, so the
   * handle would arrive as the insert's eventual value instead of the insert itself - and the
   * caller could not then observe whether it had settled, which is the one thing this file needs.
   */
  let handOut!: (box: { submitted: Promise<unknown> }) => void;
  const insertHandle = new Promise<{ submitted: Promise<unknown> }>((resolve) => {
    handOut = resolve;
  });

  const done = b.$transaction(
    async (tx) => {
      const rows = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
      pidReady(Number(rows[0].pid));
      const submitted = tx.$executeRawUnsafe(INSERT, randomUUID(), cafe.businessId, destination);
      handOut({ submitted });
      // Rejecting here rolls B's transaction back, which is correct for the refusal case.
      await submitted;
      return "committed";
    },
    { timeout: TX_TIMEOUT_MS, maxWait: TX_TIMEOUT_MS },
  );
  done.catch(() => undefined);

  return { pid: await pidPromise, insert: watch((await insertHandle).submitted), done };
}

function pendingTests(): Promise<number> {
  return migratorPrisma().webhookDelivery.count({
    where: { businessId: cafe.businessId, isTest: true, status: "PENDING" },
  });
}

describe("two overlapping transactions cannot both queue a waiting test", () => {
  it("blocks B specifically, then refuses it from the unique index once A commits", async () => {
    const first = await holdOpenInsertOnA();
    const second = await insertOnBInItsOwnTransaction();

    /*
     * The assertion neither earlier version could make: THIS backend is waiting, and it is waiting
     * on a transaction id — what an inserter blocked on another transaction's uncommitted unique
     * index entry waits on. Not a sleep, not a global count.
     */
    const wait = await waitUntilBlocked(second.pid);
    expect(wait.locktype, "B is waiting, but not on another transaction").toBe("transactionid");
    expect(second.insert.isSettled(), "B is recorded as waiting yet its INSERT already finished").toBe(false);

    first.commit();
    await first.done;

    /*
     * Refused by the INDEX, not by the trigger. The trigger cannot have decided this: it ran before
     * A committed and saw nothing. A `check_violation` here would mean B never reached the index.
     */
    await expect(second.insert.result).rejects.toThrow(/23505/);
    await expect(second.insert.result).rejects.toThrow(/already exists/);
    // One column in the key identifies WHICH unique index fired: the other partial unique index on
    // this table is on ("destinationId", "integrationEventId") and names both.
    await expect(second.insert.result).rejects.toThrow(/Key \("destinationId"\)=/);
    await expect(second.insert.result).rejects.not.toThrow(/a test is already queued for this destination/);

    await second.done.catch(() => undefined);
    expect(await pendingTests()).toBe(1);
  }, 60_000);

  it("lets B through if A rolls back, because the rule is about what is WAITING", async () => {
    const first = await holdOpenInsertOnA();
    const second = await insertOnBInItsOwnTransaction();

    const wait = await waitUntilBlocked(second.pid);
    expect(wait.locktype).toBe("transactionid");
    expect(second.insert.isSettled()).toBe(false);

    // A changes its mind. B's wait ends in success, not in a refusal.
    first.rollback();
    await first.done;
    await second.insert.result;
    await expect(second.done).resolves.toBe("committed");

    expect(await pendingTests()).toBe(1);
  }, 60_000);

  it("does not make one destination's test wait behind another's", async () => {
    // The index is partial and keyed on the destination, so unrelated work must not serialize.
    const other = await createDestination(cafe.ctx, { name: "Second", url: "https://hooks.example.com/other" });
    await setDestinationState(cafe.ctx, other.destination.id, "ENABLED");

    const first = await holdOpenInsertOnA();
    const second = await insertOnBInItsOwnTransaction(other.destination.id);

    // No wait to observe: it simply completes while A still holds its own row.
    await second.insert.result;
    await expect(second.done).resolves.toBe("committed");

    first.commit();
    await first.done;
    expect(await pendingTests()).toBe(2);
  }, 60_000);

  it("stops constraining a destination once its waiting test has settled", async () => {
    const first = await holdOpenInsertOnA();
    first.commit();
    await first.done;

    // Settle it the way the worker would. The index sees only PENDING rows.
    await b.$executeRawUnsafe(
      `UPDATE "WebhookDelivery"
          SET "status" = 'REFUSED', "settledAt" = now(), "nextAttemptAt" = NULL,
              "lastErrorClass" = 'HTTP_CLIENT_ERROR'
        WHERE "destinationId" = $1::text AND "isTest" AND "status" = 'PENDING'`,
      destinationId,
    );

    const second = await insertOnBInItsOwnTransaction();
    await second.insert.result;
    await expect(second.done).resolves.toBe("committed");

    expect(await pendingTests()).toBe(1);
    expect(
      await migratorPrisma().webhookDelivery.count({ where: { businessId: cafe.businessId, isTest: true } }),
    ).toBe(2);
  }, 60_000);
});
