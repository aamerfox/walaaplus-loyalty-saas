import { PrismaClient, type Prisma } from "@prisma/client";
import { env } from "./env";

/**
 * Single PrismaClient per process, built from the VALIDATED environment — lazily.
 *
 * The client is created on first use, not at import time. `next build` evaluates server modules
 * (route handlers import services, services import this file) while collecting page data, and a
 * build must succeed with NO environment at all: the Docker build stage has no `.env`, and no
 * secret may be required to produce an image. Startup validation still happens before any request
 * is served (`src/instrumentation.ts`, `src/worker/index.ts`), so a misconfigured deployment still
 * fails at boot with variable names, never at the first query.
 *
 * Only `src/server/**` may import this. Pages and route handlers call services; they never
 * touch Prisma directly for business-sensitive operations (docs/PRODUCT-SPEC.md §2.6).
 */
const globalForPrisma = globalThis as unknown as { __walaaplusPrisma?: PrismaClient };

function createClient(): PrismaClient {
  const e = env();
  return new PrismaClient({
    datasourceUrl: e.DATABASE_URL,
    log: e.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  });
}

function getClient(): PrismaClient {
  if (!globalForPrisma.__walaaplusPrisma) {
    const client = createClient();
    // In production each process holds exactly one client too; the global only exists so that
    // development hot-reloads do not leak connections. Caching on the global is harmless in both.
    globalForPrisma.__walaaplusPrisma = client;
  }
  return globalForPrisma.__walaaplusPrisma;
}

/**
 * Transparent proxy to the lazily created client. Property reads, `in` checks and method calls
 * behave exactly as on the real client (methods are bound to it), so `prisma.user.findMany()`,
 * `prisma.$transaction(...)` and `"$transaction" in prisma` all work unchanged.
 */
export const prisma: PrismaClient = new Proxy({} as PrismaClient, {
  get(_target, prop) {
    const client = getClient();
    const value = Reflect.get(client, prop, client) as unknown;
    return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(client) : value;
  },
  has(_target, prop) {
    return Reflect.has(getClient(), prop);
  },
  set(_target, prop, value) {
    return Reflect.set(getClient(), prop, value);
  },
  ownKeys() {
    return Reflect.ownKeys(getClient());
  },
  getOwnPropertyDescriptor(_target, prop) {
    const d = Reflect.getOwnPropertyDescriptor(getClient(), prop);
    return d ? { ...d, configurable: true } : undefined;
  },
});

/** Interactive-transaction client. Services accept `DbClient` so they compose inside one transaction. */
export type Tx = Prisma.TransactionClient;
export type DbClient = PrismaClient | Tx;
