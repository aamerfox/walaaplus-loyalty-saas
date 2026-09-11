/**
 * Vitest setupFile for the integration project: runs in EVERY worker before test files load,
 * so `@/server/env` and Prisma see the test database, not the developer's dev database.
 */
import { applyTestProcessEnv } from "./test-env";

applyTestProcessEnv();
