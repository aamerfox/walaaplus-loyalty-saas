import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/db";
import { IdempotencyConflictError } from "@/server/errors";
import { canonicalJson, runIdempotent } from "@/server/ledger/idempotency";
import { registerTestOwner, resetDatabase } from "../setup/fixtures";

describe("runIdempotent", () => {
  let businessId: string;

  beforeAll(async () => {
    await resetDatabase();
    businessId = (await registerTestOwner()).businessId;
  });

  /** "Work" with a visible side effect we can count: one AuditLog row per execution. */
  function work(tag: string) {
    return async (tx: Parameters<Parameters<typeof runIdempotent>[0]["execute"]>[0]) => {
      await tx.auditLog.create({ data: { businessId, action: "test.work", entityType: "Test", entityId: tag } });
      return { result: { tag, at: 1 }, transactionGroupId: randomUUID() };
    };
  }
  const countWork = (tag: string) => prisma.auditLog.count({ where: { entityId: tag } });

  it("executes once and replays the stored response for the same key + payload", async () => {
    const key = randomUUID();
    const first = await runIdempotent({ businessId, key, payload: { a: 1 }, execute: work("once") });
    const second = await runIdempotent({ businessId, key, payload: { a: 1 }, execute: work("once") });

    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(true);
    expect(second.result).toEqual(first.result);
    expect(await countWork("once")).toBe(1);

    const rec = await prisma.idempotencyRecord.findUniqueOrThrow({ where: { businessId_key: { businessId, key } } });
    expect(rec.transactionGroupId).toBeTruthy();
    expect(rec.response).toEqual(first.result);
  });

  it("rejects the same key with a different payload and does not execute", async () => {
    const key = randomUUID();
    await runIdempotent({ businessId, key, payload: { amount: 5 }, execute: work("conflict") });
    await expect(
      runIdempotent({ businessId, key, payload: { amount: 6 }, execute: work("conflict") }),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
    expect(await countWork("conflict")).toBe(1);
  });

  it("payload key order does not matter", async () => {
    const key = randomUUID();
    await runIdempotent({ businessId, key, payload: { x: 1, y: 2 }, execute: work("order") });
    const r = await runIdempotent({ businessId, key, payload: { y: 2, x: 1 }, execute: work("order") });
    expect(r.replayed).toBe(true);
  });

  it("the same key in a different business is independent", async () => {
    const other = (await registerTestOwner()).businessId;
    const key = randomUUID();
    const a = await runIdempotent({ businessId, key, payload: {}, execute: work("tenant-a") });
    const b = await runIdempotent({ businessId: other, key, payload: {}, execute: async (tx) => {
      await tx.auditLog.create({ data: { businessId: other, action: "test.work", entityType: "Test", entityId: "tenant-b" } });
      return { result: { tag: "tenant-b", at: 1 } };
    } });
    expect(a.replayed).toBe(false);
    expect(b.replayed).toBe(false);
  });

  it("CONCURRENT first attempts execute exactly once; the rest replay", async () => {
    const key = randomUUID();
    const N = 8;
    const results = await Promise.all(
      Array.from({ length: N }, () => runIdempotent({ businessId, key, payload: { n: 1 }, execute: work("race") })),
    );
    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
    expect(results.filter((r) => r.replayed)).toHaveLength(N - 1);
    // jsonb normalises key order on the way back, so compare canonically, not by raw string.
    expect(new Set(results.map((r) => canonicalJson(r.result))).size).toBe(1);
    expect(await countWork("race")).toBe(1);
  });

  it("a failure inside the work leaves no record, so a retry executes again", async () => {
    const key = randomUUID();
    await expect(
      runIdempotent({
        businessId,
        key,
        payload: {},
        execute: async () => {
          throw new Error("downstream failure");
        },
      }),
    ).rejects.toThrow("downstream failure");
    expect(await prisma.idempotencyRecord.findUnique({ where: { businessId_key: { businessId, key } } })).toBeNull();

    const retry = await runIdempotent({ businessId, key, payload: {}, execute: work("retry") });
    expect(retry.replayed).toBe(false);
    expect(await countWork("retry")).toBe(1);
  });
});
