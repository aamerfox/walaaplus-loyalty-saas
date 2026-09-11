import path from "node:path";
import { defineConfig } from "vitest/config";

const rootDir = import.meta.dirname;

/**
 * Two test projects:
 *
 *  unit         pure logic, no database, fast. tests/unit/**
 *  integration  real PostgreSQL via TEST_DATABASE_URL, migrations applied once
 *               per run by tests/setup/integration-global.ts. tests/integration/**
 *
 * Playwright end-to-end tests are deliberately NOT part of Vitest or `npm run gate`;
 * they run through `npm run test:e2e` in later phases.
 */
export default defineConfig({
  resolve: {
    alias: { "@": path.resolve(rootDir, "src") },
  },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          environment: "node",
          include: ["tests/unit/**/*.test.ts"],
        },
      },
      {
        extends: true,
        test: {
          name: "integration",
          environment: "node",
          include: ["tests/integration/**/*.test.ts"],
          globalSetup: ["tests/setup/integration-global.ts"],
          setupFiles: ["tests/setup/integration-env.ts"],
          // One database, so test files run sequentially; tests inside a file may still be concurrent.
          fileParallelism: false,
          testTimeout: 30_000,
          hookTimeout: 90_000,
        },
      },
    ],
  },
});
