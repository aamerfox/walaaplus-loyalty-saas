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
 * ## Why this file exists rather than another `Promise.all`
 *
 * The first version of this rule was a `BEFORE INSERT` trigger running `SELECT ... EXISTS`, and it
 * was claimed to be concurrency-safe. It is not. That check reads only **committed** rows, so under
 * READ COMMITTED two overlapping transactions each find nothing, each pass, and each commit — two
 * waiting tests, which is the thing the rule exists to prevent.
 *
 * The test that "proved" the trigger was `Promise.all` of two Prisma creates. Prisma issues those
 * as two autocommit statements over **one** connection pool, so they serialize: the second really
 * does see the first's committed row. That demonstrated **sequential** refusal and was read as
 * concurrency safety. A test that cannot fail for the reason you care about is not evidence about
 * that reason.
 *
 * ## What this does instead
 *
 * Two `PrismaClient` instances, so two independent connection pools, and the first transaction is
 * **held open on purpose**:
 *
 *   1. client A opens an interactive transaction and inserts a pending test — **not committed**;
 *   2. client B, on its own connection, attempts the same insert — this must **block**, and the
 *      test asserts it is still unsettled while A holds the row;
 *   3. A commits — B must then be **refused** with a unique violation naming the index;
 *   4. and the mirror: if A **rolls back**, B must be allowed through, because the rule is "one
 *      waiting test", not "one attempt ever".
 *
 * Both clients connect as the **restricted runtime role** — what `web` and `worker` hold.
 *
 * The guarantee under test is the partial unique index `WebhookDelivery_one_pending_test_key`
 * (migration 17). The trigger rule is still present and still useful — it gives the sequential case
 * a readable sentence instead of a duplicate-key error — but it is not what makes this file pass,
 * and removing the index makes it fail.
 */

/** Long enough that a non-blocking insert would certainly have finished; short enough to be cheap. */
const BLOCK_OBSERVATION_MS = 750;

/** Prisma aborts an interactive transaction on its own after this; A is held for far less. */
const HOLD_TIMEOUT_MS = 20_000;

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

  // Two clients, so two pools. This is the whole point of the file: one pool would serialize them
  // and the test would pass without proving anything about concurrency.
  const { runtime } = resolveTestDatabaseUrls();
  a = new PrismaClient({ datasources: { db: { url: runtime } } });
  b = new PrismaClient({ datasources: { db: { url: runtime } } });

  /*
   * Warm both pools before anything is timed.
   *
   * This is not tidiness, it is the difference between a real result and a fake one. A fresh
   * `PrismaClient`'s first query includes connecting and starting a query engine, which took long
   * enough that the FIRST version of this file mistook it for blocking: B was still connecting
   * during the observation window, A committed, and B's trigger then saw a committed row and
   * refused with `check_violation` - so the test "passed" its blocking assertion without B ever
   * having reached the index. Warmed up, B's INSERT reaches the trigger in milliseconds, passes it
   * because A's row is uncommitted, and then blocks where it is supposed to.
   */
  await Promise.all([a.$queryRaw`SELECT 1`, b.$queryRaw`SELECT 1`]);
});

afterEach(async () => {
  await Promise.allSettled([a.$disconnect(), b.$disconnect()]);
});

/**
 * Is some backend waiting on a lock right now?
 *
 * Asked of the MIGRATOR connection, which is not part of the race. "Has not settled yet" is weak
 * evidence - a slow client looks the same - so the test also reads `pg_locks` and requires an
 * ungranted lock to exist. An insert waiting on another transaction's uncommitted index entry waits
 * on that transaction's id, which appears here as an ungranted `transactionid` lock.
 */
async function someoneIsWaitingOnALock(): Promise<boolean> {
  const rows = await migratorPrisma().$queryRaw<{ waiting: bigint }[]>`
    SELECT count(*) AS waiting FROM pg_locks WHERE NOT granted
  `;
  return Number(rows[0].waiting) > 0;
}

/** Has this promise settled? Used to prove B is genuinely waiting rather than merely slow. */
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
  // The caller observes the rejection; this only records that it happened.
  result.catch(() => undefined);
  return { isSettled: () => done, result };
}

/**
 * Open a transaction on `a`, insert a pending test, and hold it open until the returned handle is
 * told to finish. Resolving commits; rejecting rolls back.
 */
async function holdOpenInsertOnA(): Promise<{ commit: () => void; rollback: () => void; done: Promise<unknown> }> {
  let release: (commit: boolean) => void;
  const held = new Promise<boolean>((resolve) => {
    release = resolve;
  });
  let inserted: () => void;
  const hasInserted = new Promise<void>((resolve) => {
    inserted = resolve;
  });

  const done = a
    .$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe(INSERT, randomUUID(), cafe.businessId, destinationId);
        inserted();
        const shouldCommit = await held;
        // Throwing is how an interactive transaction is rolled back.
        if (!shouldCommit) throw new Error("deliberate rollback");
      },
      { timeout: HOLD_TIMEOUT_MS, maxWait: HOLD_TIMEOUT_MS },
    )
    .catch((e: unknown) => e);

  // Do not hand the caller a handle until A's row actually exists inside its transaction.
  await hasInserted;
  return { commit: () => release(true), rollback: () => release(false), done };
}

function insertOnB(): Promise<unknown> {
  return b.$executeRawUnsafe(INSERT, randomUUID(), cafe.businessId, destinationId);
}

function pendingTests(): Promise<number> {
  return migratorPrisma().webhookDelivery.count({
    where: { businessId: cafe.businessId, isTest: true, status: "PENDING" },
  });
}

describe("two overlapping transactions cannot both queue a waiting test", () => {
  it("blocks the second insert while the first transaction is open, then refuses it on commit", async () => {
    const first = await holdOpenInsertOnA();
    const second = watch(insertOnB());

    /*
     * The assertion the old test could not make. B's INSERT has been sent on its own connection and
     * must be WAITING on A's uncommitted index entry. Without the index — with only the trigger's
     * `EXISTS`, which reads committed rows — this would have completed immediately, because A's row
     * is invisible to it.
     *
     * Two observations, because one of them is weak on its own: the promise has not settled, AND
     * the database reports an ungranted lock. A client that is merely slow satisfies the first and
     * not the second.
     */
    await new Promise((resolve) => setTimeout(resolve, BLOCK_OBSERVATION_MS));
    expect(second.isSettled(), "the second insert did not block; nothing is serializing these").toBe(false);
    expect(await someoneIsWaitingOnALock(), "nothing is waiting on a lock, so B is slow rather than blocked").toBe(
      true,
    );

    first.commit();
    await first.done;

    /*
     * Refused by the INDEX, not by the trigger.
     *
     * This distinction is the whole point of the file. The trigger cannot have decided this: it ran
     * before A committed and saw nothing. A `check_violation` here would mean B never reached the
     * index and the test had proved nothing about concurrency — which is exactly how the first
     * version of this file failed.
     */
    await expect(second.result).rejects.toThrow(/23505/);
    await expect(second.result).rejects.toThrow(/already exists/);
    /*
     * One column in the key, which is what identifies WHICH unique index refused. The only other
     * unique index on this table is the partial one on ("destinationId", "integrationEventId"), and
     * a violation of that one names both columns.
     *
     * Prisma surfaces PostgreSQL's DETAIL line rather than its MESSAGE, so the index name itself is
     * not in the string. `webhook-release-gate.test.ts` asserts the index object exists with the
     * right name and predicate; this asserts which one fired.
     */
    await expect(second.result).rejects.toThrow(/Key \("destinationId"\)=/);
    await expect(second.result).rejects.not.toThrow(/a test is already queued for this destination/);

    expect(await pendingTests()).toBe(1);
  }, 60_000);

  it("lets the second through if the first rolls back, because the rule is about what is WAITING", async () => {
    const first = await holdOpenInsertOnA();
    const second = watch(insertOnB());

    await new Promise((resolve) => setTimeout(resolve, BLOCK_OBSERVATION_MS));
    expect(second.isSettled()).toBe(false);
    expect(await someoneIsWaitingOnALock()).toBe(true);

    // A changes its mind. B's wait ends in success, not in a refusal.
    first.rollback();
    await first.done;
    await second.result;

    expect(await pendingTests()).toBe(1);
  }, 60_000);

  it("does not serialize unrelated destinations", async () => {
    // The index is partial and keyed on the destination: it must not make one destination's test
    // wait behind another's.
    const other = await createDestination(cafe.ctx, { name: "Second", url: "https://hooks.example.com/other" });
    await setDestinationState(cafe.ctx, other.destination.id, "ENABLED");

    const first = await holdOpenInsertOnA();
    // B inserts for the OTHER destination while A still holds its row. This must not block.
    const second = watch(b.$executeRawUnsafe(INSERT, randomUUID(), cafe.businessId, other.destination.id));
    await second.result;

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

    await insertOnB();

    expect(await pendingTests()).toBe(1);
    expect(
      await migratorPrisma().webhookDelivery.count({ where: { businessId: cafe.businessId, isTest: true } }),
    ).toBe(2);
  }, 60_000);
});
