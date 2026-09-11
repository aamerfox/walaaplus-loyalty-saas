#!/usr/bin/env node
/**
 * `npm run db:migrate [deploy|status|dev ...]` — run Prisma Migrate AS THE MIGRATOR ROLE.
 *
 * Prisma reads its datasource from DATABASE_URL, which in this project is the RESTRICTED RUNTIME
 * role (it cannot create or alter tables). Migrations must run as the owner/migrator role held in
 * MIGRATE_DATABASE_URL. This wrapper re-points DATABASE_URL at MIGRATE_DATABASE_URL for the Prisma
 * CLI process only; the calling shell's environment is untouched.
 *
 *   node scripts/db-migrate.mjs deploy            # apply committed migrations (the only shared-db command)
 *   node scripts/db-migrate.mjs status            # must print "Database schema is up to date"
 *   node scripts/db-migrate.mjs dev --name xyz    # local only
 *
 * Tests and the gate call it with MIGRATE_DATABASE_URL=$TEST_MIGRATE_DATABASE_URL.
 */
import { spawnSync } from "node:child_process";
import { config as loadDotenv } from "dotenv";

loadDotenv({ quiet: true });

const ALLOWED = new Set(["deploy", "status", "dev", "resolve", "diff"]);
const [sub = "deploy", ...rest] = process.argv.slice(2);
if (!ALLOWED.has(sub)) {
  process.stderr.write(`db-migrate: unknown subcommand "${sub}". Allowed: ${[...ALLOWED].join(", ")}\n`);
  process.exit(2);
}
if (rest.some((a) => /[\s"'`$;&|<>]/.test(a))) {
  process.stderr.write("db-migrate: arguments may not contain whitespace or shell metacharacters.\n");
  process.exit(2);
}

const migrateUrl = process.env.MIGRATE_DATABASE_URL;
if (!migrateUrl) {
  process.stderr.write(
    "db-migrate: MIGRATE_DATABASE_URL is not set. Migrations run as the migrator/owner role, " +
      "never as the runtime role. See .env.example.\n",
  );
  process.exit(2);
}

const res = spawnSync(["npx", "prisma", "migrate", sub, ...rest].join(" "), {
  shell: process.platform === "win32" ? "cmd.exe" : true,
  stdio: "inherit",
  env: { ...process.env, DATABASE_URL: migrateUrl },
});
process.exit(res.status ?? 1);
