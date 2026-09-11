import { PgBoss } from "pg-boss";
import { env } from "../server/env";

/** pg-boss keeps its own tables in the `pgboss` schema of the application database. */
export const PGBOSS_SCHEMA = "pgboss";

export function createBoss(connectionString: string = env().DATABASE_URL): PgBoss {
  return new PgBoss({
    connectionString,
    schema: PGBOSS_SCHEMA,
    application_name: "walaaplus-worker",
    // Conservative maintenance defaults; tuned in Phase 1.5 when real jobs exist.
    maintenanceIntervalSeconds: 120,
  });
}
