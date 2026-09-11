import { config as loadDotenv } from "dotenv";
import { defineConfig, devices } from "@playwright/test";

/**
 * End-to-end configuration.
 *
 * Deliberately separate from `npm run gate`: a browser run needs a build and a server, takes
 * minutes rather than seconds, and would make the fast local loop unusable. CI runs it as its own
 * job (`.github/workflows/e2e.yml`); developers run `npm run test:e2e`.
 *
 * Two things here are correctness, not preference:
 *
 *  - `testDir` points at `tests/e2e`, and `testMatch` is `*.spec.ts`. Playwright's default match
 *    is `**\/*.@(spec|test).ts`, which would otherwise sweep up every Vitest file under `tests/`
 *    and run the whole unit and integration suite inside a browser runner.
 *  - the server under test is pointed at the DISPOSABLE TEST DATABASE, never the developer's own.
 *    The spec seeds a café through the real services, so both processes must agree on which
 *    database that is.
 */
loadDotenv({ quiet: true });

const PORT = Number(process.env.E2E_PORT ?? 3100);
const BASE_URL = `http://127.0.0.1:${PORT}`;

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
if (!testDatabaseUrl) {
  throw new Error("TEST_DATABASE_URL is required for end-to-end tests. Run `npm run db:test:up`; see .env.example.");
}
// The spec file seeds through the same services the app uses, so this process must talk to the
// same database the server under test does. `__WALAAPLUS_TEST_ENV_APPLIED` is the harness's own
// marker meaning "pointing at the test database is deliberate here" — without it, the guard in
// tests/setup/test-env.ts refuses, which is exactly what should happen to an accidental setting.
process.env.DATABASE_URL = testDatabaseUrl;
process.env.__WALAAPLUS_TEST_ENV_APPLIED = "1";

export default defineConfig({
  testDir: "./tests/e2e",
  globalSetup: "./tests/e2e/global-setup.ts",
  testMatch: "**/*.spec.ts",
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"], ["html", { outputFolder: "playwright-report", open: "never" }]],
  use: {
    baseURL: BASE_URL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    headless: true,
    // The café loop is a phone product: test it at a phone's size.
    ...devices["Pixel 7"],
  },
  projects: [{ name: "mobile-chromium", use: { ...devices["Pixel 7"] } }],
  outputDir: "playwright-results",
  webServer: {
    // The STANDALONE build, which is the artifact the Dockerfile ships and `next start` refuses to
    // serve. A production build also avoids `next dev` compiling routes on first hit, which makes
    // the first assertion of every spec a timeout race.
    command: "npm run build && node scripts/e2e-server.mjs",
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 300_000,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      PORT: String(PORT),
      DATABASE_URL: testDatabaseUrl,
      NEXTAUTH_URL: BASE_URL,
      NEXTAUTH_SECRET: process.env.NEXTAUTH_SECRET ?? "e2e-fixture-secret-not-a-real-secret-000000",
      NEXT_TELEMETRY_DISABLED: "1",
      // The e2e journey signs in and enrols repeatedly; the production defaults would refuse a
      // rerun within the window. Raised only for this server, never in the app's own defaults.
      AUTH_RATE_LIMIT_SIGNIN_MAX: "1000",
      AUTH_RATE_LIMIT_REGISTER_MAX: "1000",
      ENROLL_RATE_LIMIT_IP_MAX: "1000",
      ENROLL_RATE_LIMIT_LINK_MAX: "1000",
    },
  },
});
