import { PrismaClient, type Prisma } from "@prisma/client";
import { env } from "./env";

/**
 * Single PrismaClient per process, built from the VALIDATED environment.
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

export const prisma: PrismaClient = globalForPrisma.__walaaplusPrisma ?? createClient();

if (env().NODE_ENV !== "production") globalForPrisma.__walaaplusPrisma = prisma;

/** Interactive-transaction client. Services accept `DbClient` so they compose inside one transaction. */
export type Tx = Prisma.TransactionClient;
export type DbClient = PrismaClient | Tx;
