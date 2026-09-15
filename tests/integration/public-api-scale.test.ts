import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import { signCursor } from "@/server/api/cursor";
import { listApiEvents } from "@/server/api/events";
import { touchKey } from "@/server/api/auth";
import { createKey } from "@/server/api/keys";
import { createStampCafe, migratorPrisma, resetDatabase, type StampCafeFixture } from "../setup/fixtures";
import type { ApiContext } from "@/server/api/auth";
import { ApiScope, PrismaClient } from "@prisma/client";

/**
 * What `/api/v1` costs at volume, measured rather than asserted in prose.
 *
 * The other public-API suites prove the answers are correct. This one proves the work done to
 * produce them does not grow with how far into the feed a consumer has walked, and that a busy key
 * does not turn its own rate limit into a write storm.
 */

const ROOT = join(import.meta.dirname, "..", "..");
const EVENTS = 20_000;

let cafe: StampCafeFixture;

beforeEach(async () => {
  await resetDatabase();
  cafe = await createStampCafe({ name: "Scale café" });
});

/**
 * Bulk-load an event history.
 *
 * Inserted directly with the triggers off, and that is the point of the comment rather than a
 * shortcut: what is under test here is the PLANNER, and twenty thousand real redemptions would take
 * minutes to build and prove nothing extra about an index.
 * `integration-events-integrity.test.ts` owns the triggers.
 */
async function seedEvents(businessId: string, count = EVENTS): Promise<void> {
  const m = migratorPrisma();
  for (const t of ["integration_event_append_only", "integration_event_validate"]) {
    await m.$executeRawUnsafe(`ALTER TABLE "IntegrationEvent" DISABLE TRIGGER ${t}`);
  }
  try {
    await m.$executeRawUnsafe(
      `INSERT INTO "IntegrationEvent"
         ("id","businessId","envelopeVersion","eventType","entityType","entityId","occurredAt","createdAt")
       SELECT gen_random_uuid()::text, $1::text, 1, 'PROMOTION_REDEMPTION_RECORDED', 'PROMOTION_REDEMPTION',
              gen_random_uuid()::text, now() - (g || ' seconds')::interval, now()
         FROM generate_series(1, ${count}) g`,
      businessId,
    );
  } finally {
    for (const t of ["integration_event_append_only", "integration_event_validate"]) {
      await m.$executeRawUnsafe(`ALTER TABLE "IntegrationEvent" ENABLE TRIGGER ${t}`);
    }
  }
  await m.$executeRawUnsafe(`ANALYZE "IntegrationEvent"`);
}

function apiCtx(businessId: string): ApiContext {
  return { businessId, apiKeyId: "unused-here", scopes: new Set([ApiScope.EVENTS_READ]) };
}

describe("the feed is a seek, not a scan", () => {
  it("reads an index range rather than filtering the whole business's history", async () => {
    /*
     * The finding this exists for.
     *
     * The cursor predicate used to be `at < X OR (at = X AND id < Y)`, which is what a Prisma
     * `where` can express. PostgreSQL cannot push an OR across two columns into an index range, so
     * it read every newer row in the business's feed and discarded it — the exact behaviour the
     * cursor was documented to avoid, growing with depth precisely as `OFFSET` does. At depth
     * 10,000 of a 20,000-row feed it discarded 10,001 rows to return 26.
     *
     * `("occurredAt", "id") < (X, Y)` IS pushed into the index. This asserts the plan, because the
     * plan is the thing that was wrong — a correctness test passed the whole time.
     */
    await seedEvents(cafe.businessId);
    const m = migratorPrisma();

    const [deep] = await m.$queryRawUnsafe<{ occurredAt: Date; id: string }[]>(
      `SELECT "occurredAt","id" FROM "IntegrationEvent" WHERE "businessId" = $1::text
        ORDER BY "occurredAt" DESC, "id" DESC OFFSET ${EVENTS / 2} LIMIT 1`,
      cafe.businessId,
    );

    const plan = (
      await m.$queryRawUnsafe<Record<string, string>[]>(
        `EXPLAIN (ANALYZE, BUFFERS) SELECT "id","eventType","entityType","entityId","occurredAt","envelopeVersion"
           FROM "IntegrationEvent"
          WHERE "businessId" = $1::text AND ("occurredAt","id") < ($2::timestamp, $3::text)
          ORDER BY "occurredAt" DESC, "id" DESC LIMIT 26`,
        cafe.businessId,
        deep.occurredAt.toISOString(),
        deep.id,
      )
    )
      .map((row) => Object.values(row)[0])
      .join("\n");

    // The index is used, and the cursor is part of the RANGE rather than a filter applied after it.
    expect(plan).toMatch(/Index Scan using "IntegrationEvent_businessId_occurredAt_idx"/);
    expect(plan, "the cursor must narrow the index range").toMatch(/Index Cond:[^\n]*occurredAt/);

    /*
     * The number that matters. A scan discards everything between the top of the feed and the
     * cursor; a seek discards at most the tie group it lands in. Ten is far above what this can
     * legitimately be and far below the 10,001 the OR form discarded, so it fails loudly on a
     * regression without being brittle about exact plan shape.
     */
    const discarded = Number(/Rows Removed by Filter: (\d+)/.exec(plan)?.[1] ?? 0);
    expect(discarded, `discarded ${discarded} rows reaching a cursor at depth ${EVENTS / 2}`).toBeLessThan(10);
  }, 120_000);

  it("sends a statement PostgreSQL turns into an index range — capturing the SERVICE's own SQL", async () => {
    /*
     * The real regression guard.
     *
     * Two earlier attempts at this test were wrong, and both were wrong in the same instructive
     * way — they passed whether or not the fix was present:
     *
     *   1. EXPLAINing a hand-written statement of the same shape proved what PostgreSQL does with
     *      the predicate and nothing about what the service sends.
     *   2. Reading `pg_stat_user_tables.idx_tup_fetch` around a service call measured nothing at
     *      all: those stats are per-backend and pending, the service runs on the application pool,
     *      and `pg_stat_force_next_flush()` only flushes the connection that calls it. The delta
     *      was zero in both states, so every assertion passed vacuously.
     *
     * So this captures the statement the service actually sends, and EXPLAINs THAT.
     *
     * `src/server/db.ts` builds its client lazily and caches it on `globalThis.__walaaplusPrisma`
     * — a global that exists so development hot-reloads do not leak connections. Assigning a
     * query-logging client to it before the service is called is enough to see every statement,
     * and it changes no shipped code and no shipped behaviour.
     */
    await seedEvents(cafe.businessId);
    const m = migratorPrisma();

    const [deep] = await m.$queryRawUnsafe<{ occurredAt: Date; id: string }[]>(
      `SELECT "occurredAt","id" FROM "IntegrationEvent" WHERE "businessId" = $1::text
        ORDER BY "occurredAt" DESC, "id" DESC OFFSET ${EVENTS - 100} LIMIT 1`,
      cafe.businessId,
    );

    const holder = globalThis as unknown as { __walaaplusPrisma?: PrismaClient };
    const previous = holder.__walaaplusPrisma;
    const listening = new PrismaClient({
      datasourceUrl: process.env.DATABASE_URL,
      log: [{ emit: "event", level: "query" }],
    });
    const seen: { query: string; params: string }[] = [];
    listening.$on("query", (e) => seen.push({ query: e.query, params: e.params }));
    holder.__walaaplusPrisma = listening;

    try {
      const page = await listApiEvents(apiCtx(cafe.businessId), {
        size: 25,
        cursor: { at: deep.occurredAt.toISOString(), id: deep.id },
      });
      expect(page.items.length).toBeGreaterThan(0);
    } finally {
      holder.__walaaplusPrisma = previous;
      await listening.$disconnect();
    }

    const feed = seen.find((q) => q.query.includes(`"IntegrationEvent"`));
    expect(feed, "the service must have queried the event table").toBeTruthy();

    // The predicate, read off the wire rather than out of the source file.
    expect(feed!.query, feed!.query).toMatch(/\("occurredAt",\s*"id"\)\s*<\s*\(/);
    expect(feed!.query).not.toMatch(/"occurredAt"\s*<\s*\$\d+::timestamp\s+OR/);

    /*
     * And what PostgreSQL makes of that exact statement. Prisma reports parameters as a JSON array
     * in the same order the placeholders appear.
     */
    const params = JSON.parse(feed!.params) as unknown[];
    const plan = (
      await m.$queryRawUnsafe<Record<string, string>[]>(
        `EXPLAIN (ANALYZE, BUFFERS) ${feed!.query}`,
        ...params,
      )
    )
      .map((row) => Object.values(row)[0])
      .join("\n");

    expect(plan, plan).toMatch(/Index Scan using "IntegrationEvent_businessId_occurredAt_idx"/);
    // The cursor narrows the index RANGE. Under the OR form the range was `businessId` alone.
    expect(plan, plan).toMatch(/Index Cond:[^\n]*occurredAt/);

    const discarded = Number(/Rows Removed by Filter: (\d+)/.exec(plan)?.[1] ?? 0);
    expect(discarded, `discarded ${discarded} rows reaching depth ${EVENTS - 100}`).toBeLessThan(10);
  }, 180_000);

  it("emits the row-value form rather than the OR form", () => {
    /*
     * A source assertion ALONGSIDE the measurement above, not instead of it: this one names the
     * defect so a reader knows what regressed, and the measurement is what actually catches it.
     */
    const source = readFileSync(join(ROOT, "src", "server", "api", "events.ts"), "utf8");
    expect(source).toMatch(/\("occurredAt", "id"\) < \(\$\{at\}::timestamp, \$\{cursor\.id\}\)/);
    expect(source).not.toMatch(/"occurredAt" < \$\{at\}::timestamp OR/);
    expect(source).not.toMatch(/OR:\s*\[\{\s*occurredAt/);
  });

  it("still paginates correctly at depth, with no duplicate and no gap", async () => {
    // The plan is worthless if the answers changed. Walk the tail of a large feed and check it.
    await seedEvents(cafe.businessId, 500);
    const ctx = apiCtx(cafe.businessId);

    const seen: string[] = [];
    let cursor: { at: string; id: string } | null = null;
    for (let page = 0; page < 12; page += 1) {
      const result = await listApiEvents(ctx, { size: 50, cursor });
      seen.push(...result.items.map((i) => i.id));
      if (result.page.nextCursor === null) break;
      // Round-trip through the real signer, exactly as the route does.
      cursor = { at: result.items[result.items.length - 1].occurredAt, id: result.items[result.items.length - 1].id };
      expect(signCursor(cursor, { businessId: cafe.businessId })).toBe(result.page.nextCursor);
    }

    expect(seen).toHaveLength(500);
    expect(new Set(seen).size, "no row may appear twice").toBe(500);

    const expected = (
      await migratorPrisma().integrationEvent.findMany({
        where: { businessId: cafe.businessId },
        orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
        select: { id: true },
      })
    ).map((e) => e.id);
    expect(seen).toEqual(expected);
  }, 120_000);

  it("keeps the tenant filter bound, not interpolated", async () => {
    // Raw SQL is where an injection gets in. Every value is a template parameter; nothing is
    // concatenated into the statement.
    const source = readFileSync(join(ROOT, "src", "server", "api", "events.ts"), "utf8");
    expect(source).toMatch(/\$queryRaw</);
    expect(source).toMatch(/"businessId" = \$\{ctx\.businessId\}/);
    // `$queryRawUnsafe` would take a string; this file must never use it.
    expect(source).not.toContain("$queryRawUnsafe");
    // The size is a bound parameter too, and it was already clamped by `pageSize`.
    expect(source).toMatch(/LIMIT \$\{options\.size \+ 1\}/);
  });
});

describe("a busy key does not become a write storm", () => {
  it("writes lastUsedAt once, then not again within the resolution window", async () => {
    /*
     * The finding this exists for.
     *
     * `touchKey` used to write on EVERY request. The rate limit permits 600 a minute per key, so
     * that was ten UPDATEs a second against one row: ten row locks that every other request for
     * that key queues behind, ten dead tuples a second, and a round-trip awaited on the latency
     * path of every read — to move a timestamp nobody reads more than once a day.
     */
    const created = await createKey(cafe.ctx, { name: "Busy" });
    const row = () =>
      migratorPrisma().apiKey.findFirstOrThrow({
        where: { id: created.key.id },
        select: { lastUsedAt: true },
      });

    expect((await row()).lastUsedAt).toBeNull();

    await touchKey(created.key.id);
    const first = (await row()).lastUsedAt;
    expect(first).not.toBeNull();

    // Fifty more requests in the same window.
    for (let i = 0; i < 50; i += 1) await touchKey(created.key.id);
    const after = (await row()).lastUsedAt;
    expect(after!.getTime(), "the timestamp must not have moved").toBe(first!.getTime());
  });

  it("performs no row version bump for the requests it skips", async () => {
    /*
     * Stronger than comparing the timestamp: `xmin` is the transaction that last wrote the row, so
     * this catches an UPDATE that rewrote the row with the same value — which would still take the
     * lock and still leave a dead tuple, and which a timestamp comparison would call unchanged.
     */
    const created = await createKey(cafe.ctx, { name: "Version" });
    const version = async () => {
      const [r] = await migratorPrisma().$queryRawUnsafe<{ xmin: string }[]>(
        `SELECT xmin::text FROM "ApiKey" WHERE "id" = $1::text`,
        created.key.id,
      );
      return r.xmin;
    };

    await touchKey(created.key.id);
    const afterFirst = await version();

    for (let i = 0; i < 20; i += 1) await touchKey(created.key.id);
    expect(await version(), "twenty skipped touches must not rewrite the row").toBe(afterFirst);
  });

  it("does write again once the window has passed, and only ever forwards", async () => {
    const created = await createKey(cafe.ctx, { name: "Later" });
    await touchKey(created.key.id);
    const first = (
      await migratorPrisma().apiKey.findFirstOrThrow({
        where: { id: created.key.id },
        select: { lastUsedAt: true },
      })
    ).lastUsedAt!;

    // A request two minutes later. The clock is a parameter precisely so this needs no waiting.
    await touchKey(created.key.id, new Date(first.getTime() + 120_000));
    const second = (
      await migratorPrisma().apiKey.findFirstOrThrow({
        where: { id: created.key.id },
        select: { lastUsedAt: true },
      })
    ).lastUsedAt!;
    expect(second.getTime()).toBeGreaterThan(first.getTime());

    // And an out-of-order earlier request never drags it backwards.
    await touchKey(created.key.id, new Date(first.getTime() - 600_000));
    const third = (
      await migratorPrisma().apiKey.findFirstOrThrow({
        where: { id: created.key.id },
        select: { lastUsedAt: true },
      })
    ).lastUsedAt!;
    expect(third.getTime()).toBe(second.getTime());
  });
});
