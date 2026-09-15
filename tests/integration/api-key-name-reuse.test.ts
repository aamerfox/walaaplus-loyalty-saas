import { ApiKeyState } from "@prisma/client";
import { beforeEach, describe, expect, it } from "vitest";

import { createKey, MAX_ACTIVE_KEYS_PER_BUSINESS, revokeKey, rotateKey } from "@/server/api/keys";
import { prisma } from "@/server/db";
import { createStampCafe, migratorPrisma, resetDatabase, type StampCafeFixture } from "../setup/fixtures";

/**
 * A key's name is unique among ACTIVE keys, and only among those — migration 19.
 *
 * ## What migration 18 got wrong
 *
 * `ApiKey_businessId_name_key` was unconditional, and the release gate found it by doing the
 * obvious thing: rotating a key without renaming it.
 *
 * `rotateKey` revokes the predecessor and inserts the replacement in ONE transaction, and the
 * predecessor's row stays — that is the no-delete rule working as designed. Against an
 * unconditional index the replacement collided with the row it was replacing. The owner screen
 * pre-fills the replacement name with the current name, so the **default** path through the
 * rotation flow failed every time, with "That name is already in use".
 *
 * The second half was quieter and worse over time: revoking a key burned its name permanently.
 * Keys expire after ninety days, so a business rotating on schedule would have accumulated dead
 * names for as long as it used the product.
 */

/**
 * The index migration 19 creates. Named once so the tests and the migration cannot drift apart
 * quietly, and spelled both ways because one form goes in a string literal and the other in DDL.
 */
const INDEX_NAME = "ApiKey_businessId_activeName_key";
const INDEX_SQL = `'${INDEX_NAME}'`;
const INDEX_SQL_IDENT = `"${INDEX_NAME}"`;

let cafe: StampCafeFixture;

beforeEach(async () => {
  await resetDatabase();
  cafe = await createStampCafe({ name: "Name café" });
});

describe("rotation keeps its own name", () => {
  it("rotates without renaming — the default path through the screen", async () => {
    const created = await createKey(cafe.ctx, { name: "Reporting" });

    // The owner presses Replace, leaves the pre-filled name alone, and presses Replace it.
    const rotated = await rotateKey(cafe.ctx, created.key.id, "Reporting");

    expect(rotated.apiKey).not.toBe(created.apiKey);
    expect(rotated.key.name).toBe("Reporting");
    expect(rotated.key.id).not.toBe(created.key.id);

    // Two rows, one name, one of them live. The predecessor is kept, as the no-delete rule requires.
    const rows = await migratorPrisma().apiKey.findMany({
      where: { businessId: cafe.businessId, name: "Reporting" },
      select: { id: true, state: true },
    });
    expect(rows).toHaveLength(2);
    expect(rows.filter((r) => r.state === ApiKeyState.ACTIVE)).toHaveLength(1);
    expect(rows.filter((r) => r.state === ApiKeyState.REVOKED)).toHaveLength(1);
  });

  it("survives being rotated repeatedly under one name", async () => {
    // A business that rotates quarterly for three years does this twelve times.
    let current = await createKey(cafe.ctx, { name: "Nightly export" });
    for (let i = 0; i < 12; i += 1) {
      current = await rotateKey(cafe.ctx, current.key.id, "Nightly export");
    }
    const rows = await migratorPrisma().apiKey.findMany({
      where: { businessId: cafe.businessId, name: "Nightly export" },
      select: { state: true },
    });
    expect(rows).toHaveLength(13);
    expect(rows.filter((r) => r.state === ApiKeyState.ACTIVE)).toHaveLength(1);

    // And the ceiling is not consumed by the twelve retired rows — only the live one holds a slot.
    const slots = await migratorPrisma().apiKey.count({
      where: { businessId: cafe.businessId, activeSlot: { not: null } },
    });
    expect(slots).toBe(1);
  });
});

describe("a name is released when the key holding it ends", () => {
  it("can be reused after a revocation", async () => {
    const first = await createKey(cafe.ctx, { name: "Reporting" });
    await revokeKey(cafe.ctx, first.key.id);

    const second = await createKey(cafe.ctx, { name: "Reporting" });
    expect(second.key.name).toBe("Reporting");
    expect(second.key.id).not.toBe(first.key.id);
  });

  it("can be reused after the lazy sweep expires the key holding it", async () => {
    const first = await createKey(cafe.ctx, { name: "Seasonal" });
    await lapse(first.key.id);
    // Issuing anything runs `releaseExpiredSlots`, which is what moves the lapsed key to EXPIRED.
    await createKey(cafe.ctx, { name: "The sweep" });
    expect(
      (await migratorPrisma().apiKey.findFirstOrThrow({ where: { id: first.key.id }, select: { state: true } })).state,
    ).toBe(ApiKeyState.EXPIRED);

    const reused = await createKey(cafe.ctx, { name: "Seasonal" });
    expect(reused.key.name).toBe("Seasonal");
  });

  it("still refuses a second LIVE key with the same name", async () => {
    // The constraint that matters is not weakened: an owner cannot have two live keys they cannot
    // tell apart, which is the entire reason the name is unique at all.
    await createKey(cafe.ctx, { name: "Reporting" });
    await expect(createKey(cafe.ctx, { name: "Reporting" })).rejects.toThrow(/already in use/);
  });

  it("keeps names independent across businesses", async () => {
    await createKey(cafe.ctx, { name: "Reporting" });
    const other = await createStampCafe({ name: "Other café" });
    const theirs = await createKey(other.ctx, { name: "Reporting" });
    expect(theirs.key.name).toBe("Reporting");
  });
});

describe("the database holds the partial form, not the unconditional one", () => {
  it("is a partial unique index predicated on ACTIVE, under its own stable name", async () => {
    /*
     * Read from `pg_indexes` rather than trusted from the migration file: what matters is the shape
     * the database actually has after every migration has run, and `prisma/schema.prisma` cannot
     * express a partial index so it does not declare one at all.
     *
     * The name is `ApiKey_businessId_activeName_key`, not migration 18's
     * `ApiKey_businessId_name_key`. Migration 19 creates the replacement under a NEW name and drops
     * the old one afterwards; reusing the old name would have meant either dropping first — putting
     * the blocking lock in front of the build — or a rename, which buys nothing but another catalog
     * lock. The name says what the index is.
     */
    const [index] = await migratorPrisma().$queryRawUnsafe<{ indexdef: string }[]>(
      `SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = ${INDEX_SQL}`,
    );
    expect(index, "the active-name index must exist").toBeTruthy();
    expect(index.indexdef).toMatch(/CREATE UNIQUE INDEX/);
    expect(index.indexdef).toMatch(/\("?businessId"?, "?name"?\)/);
    expect(index.indexdef, "must be predicated on ACTIVE").toMatch(/WHERE \(?"?state"?[^)]*'ACTIVE'/);
  });

  it("has removed migration 18's unconditional index", async () => {
    // Leaving it behind would silently restore the defect: the stricter rule would still refuse a
    // rotation that keeps its name, and the new index would look like it was working.
    const rows = await migratorPrisma().$queryRawUnsafe<{ indexname: string }[]>(
      `SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'ApiKey_businessId_name_key'`,
    );
    expect(rows).toHaveLength(0);
  });

  it("accepts the new index on data that satisfied the OLD unconditional rule", async () => {
    /*
     * Migration 19's central safety claim, exercised rather than asserted.
     *
     * The claim is that the new index is STRICTLY WEAKER: any table that satisfied unconditional
     * uniqueness satisfies uniqueness over the ACTIVE subset, so the CREATE cannot fail on existing
     * rows in any environment. This builds a realistic pre-migration table — live keys, revoked
     * predecessors, expired ones, several businesses — then replays both index regimes over it.
     */
    const other = await createStampCafe({ name: "Second café" });
    for (const ctx of [cafe.ctx, other.ctx]) {
      const a = await createKey(ctx, { name: "Reporting" });
      await revokeKey(ctx, a.key.id);
      const b = await createKey(ctx, { name: "Analytics" });
      await lapse(b.key.id);
      await createKey(ctx, { name: "Nightly" });
    }
    await createKey(cafe.ctx, { name: "Extra" });

    const m = migratorPrisma();
    // The data satisfies migration 18's rule: the unconditional index builds over it.
    await m.$executeRawUnsafe(`DROP INDEX ${INDEX_SQL_IDENT}`);
    await m.$executeRawUnsafe(
      `CREATE UNIQUE INDEX "ApiKey_businessId_name_key" ON "ApiKey"("businessId", "name")`,
    );

    // And therefore migration 19's CREATE succeeds over exactly the same rows. This is the step a
    // deployment performs against real data.
    await m.$executeRawUnsafe(
      `CREATE UNIQUE INDEX ${INDEX_SQL_IDENT} ON "ApiKey"("businessId", "name") WHERE "state" = 'ACTIVE'`,
    );
    await m.$executeRawUnsafe(`DROP INDEX "ApiKey_businessId_name_key"`);

    // Back to the migrated shape, and still enforcing.
    await expect(createKey(cafe.ctx, { name: "Nightly" })).rejects.toThrow(/already in use/);
  });

  it("never leaves a committed window in which a duplicate ACTIVE name is possible", async () => {
    /*
     * The ordering guarantee, walked one statement at a time.
     *
     * Migration 19 creates the replacement and only then drops the original, both inside Prisma's
     * single migration transaction. So at every instant at least one index constrains an ACTIVE
     * name: the old one before and during the build, both once the build is valid, the new one
     * after the drop.
     *
     * This replays that sequence and attempts the duplicate after each step. The attempts run on the
     * same connection as the DDL, which is what lets them observe the intermediate states at all —
     * another connection would simply block on the locks, which is the behaviour the migration
     * comment describes and not what is under test here.
     */
    const live = await createKey(cafe.ctx, { name: "Contested" });
    expect(live.key.state).toBe(ApiKeyState.ACTIVE);
    const m = migratorPrisma();

    async function duplicateActiveNameIsRefused(stage: string): Promise<void> {
      const attempt = m.$executeRawUnsafe(
        `INSERT INTO "ApiKey" ("id","businessId","name","keyPrefix","keyDigest","scope","state","activeSlot","issuedAt","expiresAt","createdAt")
         VALUES (gen_random_uuid()::text, $1::text, 'Contested', 'wpk_deadbeef', repeat('b', 64), 'EVENTS_READ'::"ApiScope",
                 'ACTIVE', 4, now(), now() + interval '90 days', now())`,
        cafe.businessId,
      );
      await expect(attempt, stage).rejects.toThrow(/23505|duplicate key|already exists/i);
    }

    // Start from migration 18's arrangement.
    await m.$executeRawUnsafe(`DROP INDEX ${INDEX_SQL_IDENT}`);
    await m.$executeRawUnsafe(
      `CREATE UNIQUE INDEX "ApiKey_businessId_name_key" ON "ApiKey"("businessId", "name")`,
    );
    await duplicateActiveNameIsRefused("before the migration, by the unconditional index");

    // Statement one: the replacement is built while the original still stands.
    await m.$executeRawUnsafe(
      `CREATE UNIQUE INDEX ${INDEX_SQL_IDENT} ON "ApiKey"("businessId", "name") WHERE "state" = 'ACTIVE'`,
    );
    await duplicateActiveNameIsRefused("mid-migration, with both indexes present");

    // Statement two: the original goes, and the replacement is already carrying the rule.
    await m.$executeRawUnsafe(`DROP INDEX "ApiKey_businessId_name_key"`);
    await duplicateActiveNameIsRefused("after the migration, by the partial index");
  });

  it("refuses a duplicate live name for the RESTRICTED RUNTIME ROLE, not just for the migrator", async () => {
    /*
     * The runtime role is what serves every request, so the guarantee has to hold for it. A rule
     * that only the table owner is subject to is a rule the application never meets.
     */
    const live = await createKey(cafe.ctx, { name: "Runtime" });
    const row = await migratorPrisma().apiKey.findFirstOrThrow({
      where: { id: live.key.id },
      select: { keyPrefix: true, scope: true, activeSlot: true },
    });

    const attempt = prisma.$executeRawUnsafe(
      `INSERT INTO "ApiKey" ("id","businessId","name","keyPrefix","keyDigest","scope","state","activeSlot","issuedAt","expiresAt","createdAt")
       VALUES (gen_random_uuid()::text, $1::text, 'Runtime', $2::text, repeat('a', 64), $3::"ApiScope", 'ACTIVE', $4::int,
               now(), now() + interval '90 days', now())`,
      cafe.businessId,
      row.keyPrefix,
      row.scope,
      row.activeSlot === 1 ? 2 : 1,
    );
    // 23505: the partial unique index, reached by the role the application connects as.
    await expect(attempt).rejects.toThrow(/23505|duplicate key|already exists/i);
  });

  it("permits a duplicate name once the holder is no longer ACTIVE, for the runtime role too", async () => {
    const live = await createKey(cafe.ctx, { name: "Recycled" });
    await revokeKey(cafe.ctx, live.key.id);
    // The same role that was refused above now succeeds, which is the whole change.
    const second = await createKey(cafe.ctx, { name: "Recycled" });
    expect(second.key.state).toBe(ApiKeyState.ACTIVE);
  });

  it("does not let the release of a name raise the active ceiling", async () => {
    // Guard against the obvious way to get this wrong: reusing names must not become a way to hold
    // more than five live keys.
    for (let i = 0; i < MAX_ACTIVE_KEYS_PER_BUSINESS; i += 1) {
      await createKey(cafe.ctx, { name: `Key ${i}` });
    }
    await expect(createKey(cafe.ctx, { name: "Sixth" })).rejects.toThrow(/at most/);
  });
});

/** Move a key's dates into the past, leaving `state` alone. `api_key_guard` freezes both columns. */
async function lapse(id: string): Promise<void> {
  await migratorPrisma().$executeRawUnsafe('ALTER TABLE "ApiKey" DISABLE TRIGGER api_key_guard');
  try {
    await migratorPrisma().$executeRawUnsafe(
      `UPDATE "ApiKey" SET "issuedAt" = now() - interval '100 days', "expiresAt" = now() - interval '1 day'
        WHERE "id" = $1::text`,
      id,
    );
  } finally {
    await migratorPrisma().$executeRawUnsafe('ALTER TABLE "ApiKey" ENABLE TRIGGER api_key_guard');
  }
}
