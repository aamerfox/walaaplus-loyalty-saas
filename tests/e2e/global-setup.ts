import { execSync } from "node:child_process";
import { resolveTestDatabaseUrls } from "../setup/test-env";

/**
 * Bring the disposable test database up to date before the browser run.
 *
 * The same two steps the integration harness performs, for the same reason: an end-to-end run
 * that assumes someone else migrated first fails in a way that looks like a product bug. Both run
 * as the MIGRATOR role; the application server under test connects as the restricted runtime role.
 */
export default function globalSetup(): void {
  const { owner, runtime } = resolveTestDatabaseUrls();
  const redacted = owner.replace(/\/\/[^@]*@/, "//<redacted>@");
  process.stdout.write(`[e2e] preparing ${redacted}\n`);

  const env = { ...process.env, MIGRATE_DATABASE_URL: owner, DATABASE_URL: runtime };
  execSync("node scripts/db-migrate.mjs deploy", { stdio: "inherit", env });
  execSync("node scripts/db-roles.mjs", { stdio: "inherit", env });
}
