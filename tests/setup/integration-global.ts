/**
 * Runs ONCE per integration-test run, in its own process.
 *
 * Responsibilities:
 *  1. Resolve TEST_DATABASE_URL and refuse to run against anything that is not clearly a test database.
 *  2. Apply the committed migrations to it with `prisma migrate deploy`.
 *
 * Environment for the worker processes is set in integration-env.ts (setupFiles), because
 * process.env changes made here do not propagate to Vitest workers.
 */
import { execSync } from "node:child_process";
import { resolveTestDatabaseUrl } from "./test-env";

export default function globalSetup(): void {
  const url = resolveTestDatabaseUrl();

  // Redact credentials before logging.
  const redacted = url.replace(/\/\/[^@]*@/, "//<redacted>@");
  process.stdout.write(`[integration] applying migrations to ${redacted}\n`);

  execSync("npx prisma migrate deploy", {
    stdio: "inherit",
    env: { ...process.env, DATABASE_URL: url },
  });
}
