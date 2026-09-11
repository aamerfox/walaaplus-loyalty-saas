import { config as loadDotenv } from "dotenv";

/**
 * Integration tests use TWO connection strings to the SAME disposable database, mirroring
 * production (docs/PHASE-0-IMPLEMENTATION.md §4 "Database roles"):
 *
 *   TEST_MIGRATE_DATABASE_URL  migrator/owner role: applies migrations, creates the runtime role,
 *                              truncates between test files (the harness only).
 *   TEST_DATABASE_URL          restricted runtime role: what every Vitest worker — and therefore
 *                              every service under test — connects as, exactly like web and worker.
 *
 * Loads `.env` (git-ignored, developer-local), then validates both URLs are safe to wipe.
 */
export interface TestDatabaseUrls {
  /** Owner / migrator role. */
  owner: string;
  /** Restricted runtime role. */
  runtime: string;
}

function parse(name: string, url: string): URL {
  if (!/^postgres(ql)?:\/\//.test(url)) throw new Error(`${name} must be a postgresql:// URL.`);
  const parsed = new URL(url);
  const dbName = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  // Guard rails: the harness truncates every table. Never let that hit a real database.
  if (!/test/i.test(dbName)) {
    throw new Error(`Refusing to run integration tests: ${name} database name "${dbName}" does not contain "test".`);
  }
  return parsed;
}

export function resolveTestDatabaseUrls(): TestDatabaseUrls {
  loadDotenv({ quiet: true });

  const owner = process.env.TEST_MIGRATE_DATABASE_URL;
  const runtime = process.env.TEST_DATABASE_URL;
  if (!owner || !runtime) {
    throw new Error(
      "TEST_MIGRATE_DATABASE_URL (migrator role) and TEST_DATABASE_URL (runtime role) must both be set. " +
        "Integration tests need a disposable PostgreSQL: run `npm run db:test:up` and see .env.example.",
    );
  }
  const o = parse("TEST_MIGRATE_DATABASE_URL", owner);
  const r = parse("TEST_DATABASE_URL", runtime);

  if (o.host !== r.host || o.pathname !== r.pathname) {
    throw new Error("TEST_MIGRATE_DATABASE_URL and TEST_DATABASE_URL must point at the same host and database.");
  }
  if (o.username === r.username) {
    throw new Error(
      `TEST_DATABASE_URL must use a DIFFERENT role from TEST_MIGRATE_DATABASE_URL ("${o.username}"): ` +
        "the tests run as the restricted runtime role and prove it cannot bypass the ledger.",
    );
  }
  // Never wipe the developer's application database, whichever role names it.
  if (process.env.__WALAAPLUS_TEST_ENV_APPLIED !== "1") {
    const appUrls = { DATABASE_URL: process.env.DATABASE_URL, MIGRATE_DATABASE_URL: process.env.MIGRATE_DATABASE_URL };
    for (const [name, value] of Object.entries(appUrls)) {
      if (value && (value === owner || value === runtime)) {
        throw new Error(`Refusing to run integration tests: ${name} equals a test database URL.`);
      }
    }
  }
  return { owner, runtime };
}

/**
 * Applies the test environment to the current process (each Vitest worker, once). Values that
 * look like secrets are deterministic TEST FIXTURES, not credentials, and are only set when absent.
 */
export function applyTestProcessEnv(): TestDatabaseUrls {
  const urls = resolveTestDatabaseUrls();
  process.env.DATABASE_URL = urls.runtime; // services under test connect as the RUNTIME role
  process.env.MIGRATE_DATABASE_URL = urls.owner;
  process.env.__WALAAPLUS_TEST_ENV_APPLIED = "1";
  Object.assign(process.env, { NODE_ENV: "test" }); // NODE_ENV is typed read-only in @types/node 24
  process.env.NEXTAUTH_URL ??= "http://localhost:3000";
  // 48-character fixture so env validation (min 32) passes. Not a secret; never used outside tests.
  process.env.NEXTAUTH_SECRET ??= "test-fixture-not-a-secret-".padEnd(48, "x");
  process.env.WORKER_HEALTH_PORT ??= "0"; // 0 = ephemeral port in tests
  return urls;
}
