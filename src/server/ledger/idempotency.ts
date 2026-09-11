import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma, type Tx } from "../db";
import { IdempotencyConflictError } from "../errors";

/**
 * Idempotency for every write that may be retried (scanner double-tap, flaky mobile network,
 * webhook redelivery, API client retry).
 *
 * Contract (docs/PRODUCT-SPEC.md §2.3):
 *  - same (businessId, key) + same payload  → the ORIGINAL stored response, no new work;
 *  - same (businessId, key) + different payload → IdempotencyConflictError;
 *  - two concurrent first attempts → exactly one executes; the other replays its result.
 *
 * How concurrency is made safe: the record is INSERTED FIRST, inside the same transaction as the
 * work. PostgreSQL blocks a second insert on the unique index until the first transaction ends,
 * so the loser sees a unique violation, never a missing row, and never runs the work twice.
 */

/** Deterministic JSON: object keys sorted recursively, so hashing is order-independent. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[k];
      if (v !== undefined) out[k] = sortKeys(v);
    }
    return out;
  }
  return value;
}

export function hashPayload(payload: unknown): string {
  return createHash("sha256").update(canonicalJson(payload), "utf8").digest("hex");
}

export interface IdempotentExecution<T extends Prisma.InputJsonValue> {
  result: T;
  transactionGroupId?: string;
}

export interface IdempotentOutcome<T> {
  result: T;
  /** true when this call returned a previously stored response instead of executing. */
  replayed: boolean;
}

export interface RunIdempotentArgs<T extends Prisma.InputJsonValue> {
  businessId: string;
  key: string;
  payload: unknown;
  /** The work. Receives the transaction the idempotency record was reserved in. */
  execute: (tx: Tx) => Promise<IdempotentExecution<T>>;
}

const PENDING_RESPONSE = { pending: true } as const;

export async function runIdempotent<T extends Prisma.InputJsonValue>(args: RunIdempotentArgs<T>): Promise<IdempotentOutcome<T>> {
  const payloadHash = hashPayload(args.payload);
  const where = { businessId_key: { businessId: args.businessId, key: args.key } };

  // Fast path: a committed record already exists.
  const existing = await prisma.idempotencyRecord.findUnique({ where });
  if (existing) return replay(existing.payloadHash, payloadHash, existing.response as T);

  try {
    const result = await prisma.$transaction(
      async (tx) => {
        // Reserve the key FIRST. A concurrent twin blocks here until we commit or roll back.
        await tx.idempotencyRecord.create({
          data: { businessId: args.businessId, key: args.key, payloadHash, response: PENDING_RESPONSE },
        });
        const out = await args.execute(tx);
        await tx.idempotencyRecord.update({
          where,
          data: { response: out.result, transactionGroupId: out.transactionGroupId ?? null },
        });
        return out.result;
      },
      // maxWait: see the note in ledger.ts. Concurrent first attempts on one key deliberately
      // serialise on the unique index, so waiting for a connection is the normal path here.
      { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, timeout: 20_000, maxWait: 10_000 },
    );
    return { result, replayed: false };
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      // Lost the race: the twin committed first. Replay its response.
      const winner = await prisma.idempotencyRecord.findUnique({ where });
      if (winner) return replay(winner.payloadHash, payloadHash, winner.response as T);
    }
    throw e;
  }
}

function replay<T>(storedHash: string, incomingHash: string, response: T): IdempotentOutcome<T> {
  if (storedHash !== incomingHash) throw new IdempotencyConflictError();
  return { result: response, replayed: true };
}
