import { config as loadDotenv } from "dotenv";

/**
 * Loads `.env` (git-ignored, developer-local) so TEST_DATABASE_URL is available, then
 * validates that the URL is safe to truncate. Used by both the global setup process and
 * every Vitest worker.
 */
export function resolveTestDatabaseUrl(): string {
  loadDotenv({ quiet: true });

  const url = process.env.TEST_DATABASE_URL;
  if (!url) {
    throw new Error(
      "TEST_DATABASE_URL is not set. Integration tests need a disposable PostgreSQL. " +
        "Run `npm run db:test:up` and set TEST_DATABASE_URL in .env (see .env.example).",
    );
  }
  if (!/^postgres(ql)?:\/\//.test(url)) {
    throw new Error("TEST_DATABASE_URL must be a postgresql:// URL.");
  }
  // Guard rails: the harness truncates every table. Never let that hit a real database.
  const dbName = url.split("/").pop()?.split("?")[0] ?? "";
  if (!/test/i.test(dbName)) {
    throw new Error(
      `Refusing to run integration tests: database name "${dbName}" does not contain "test".`,
    );
  }
  if (process.env.DATABASE_URL && process.env.DATABASE_URL === url) {
    throw new Error("Refusing to run integration tests: TEST_DATABASE_URL equals DATABASE_URL.");
  }
  return url;
}

/**
 * Applies the test environment to the current process. Values that look like secrets are
 * deterministic TEST FIXTURES, not credentials, and are only ever set when absent.
 */
export function applyTestProcessEnv(): void {
  const url = resolveTestDatabaseUrl();
  process.env.DATABASE_URL = url;
  Object.assign(process.env, { NODE_ENV: "test" }); // NODE_ENV is typed read-only in @types/node 24
  process.env.NEXTAUTH_URL ??= "http://localhost:3000";
  // 48-character fixture so env validation (min 32) passes. Not a secret; never used outside tests.
  process.env.NEXTAUTH_SECRET ??= "test-fixture-not-a-secret-".padEnd(48, "x");
  process.env.WORKER_HEALTH_PORT ??= "0"; // 0 = ephemeral port in tests
}
