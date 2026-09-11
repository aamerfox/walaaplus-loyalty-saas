import { PgBoss } from "pg-boss";
import { env } from "../server/env";

/**
 * pg-boss keeps its own tables in the `pgboss` schema of the application database.
 *
 * The schema itself is created — owned by the restricted runtime role — by `scripts/db-roles.mjs`,
 * so the worker needs no CREATE privilege on the database: `createSchema: false` stops pg-boss
 * from issuing `CREATE SCHEMA IF NOT EXISTS`, which PostgreSQL refuses for a role without database
 * CREATE even when the schema already exists. pg-boss still creates and migrates its own tables
 * inside the schema it owns.
 */
export const PGBOSS_SCHEMA = "pgboss";

export function createBoss(connectionString: string = env().DATABASE_URL): PgBoss {
  return new PgBoss({
    connectionString,
    schema: PGBOSS_SCHEMA,
    createSchema: false,
    application_name: "walaaplus-worker",
    // Conservative maintenance defaults; tuned in Phase 1.5 when real jobs exist.
    maintenanceIntervalSeconds: 120,
  });
}
