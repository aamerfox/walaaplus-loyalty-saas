/**
 * Runs ONCE per integration-test run, in its own process.
 *
 * Responsibilities, all as the MIGRATOR role (TEST_MIGRATE_DATABASE_URL):
 *  1. Validate both test URLs and refuse anything that is not clearly a disposable test database.
 *  2. Apply the committed migrations with `prisma migrate deploy`.
 *  3. Create/refresh the restricted RUNTIME role and its grants (`scripts/db-roles.mjs`), so the
 *     Vitest workers can connect as it (TEST_DATABASE_URL) exactly like web and worker do.
 *
 * Environment for the worker processes is set in integration-env.ts (setupFiles), because
 * process.env changes made here do not propagate to Vitest workers.
 */
import { execSync } from "node:child_process";
import { resolveTestDatabaseUrls } from "./test-env";

export default function globalSetup(): void {
  const { owner, runtime } = resolveTestDatabaseUrls();

  // Redact credentials before logging.
  const redacted = owner.replace(/\/\/[^@]*@/, "//<redacted>@");
  process.stdout.write(`[integration] applying migrations to ${redacted} as the migrator role\n`);

  const env = { ...process.env, MIGRATE_DATABASE_URL: owner, DATABASE_URL: runtime };
  execSync("node scripts/db-migrate.mjs deploy", { stdio: "inherit", env });
  execSync("node scripts/db-roles.mjs", { stdio: "inherit", env });
}
