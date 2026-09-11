#!/usr/bin/env node
/**
 * `npm run gate` — the single engineering-gate command.
 *
 * Runs, in order and stopping at the first failure:
 *   1. prisma generate      (types must exist before lint/typecheck can be trusted)
 *   2. lint
 *   3. typecheck
 *   4. prisma validate
 *   5. unit tests
 *   6. disposable test database up   (skipped when GATE_SKIP_DOCKER=1, e.g. CI service container)
 *   7. prisma migrate deploy  → test database, as the MIGRATOR role (TEST_MIGRATE_DATABASE_URL)
 *   8. prisma migrate status  → must report "up to date"
 *   9. runtime role grants    → scripts/db-roles.mjs creates the restricted role in TEST_DATABASE_URL
 *  10. integration tests      (real PostgreSQL, connected as the RUNTIME role)
 *  11. worker build           (esbuild bundle the worker container runs)
 *  12. production build
 *
 * Playwright end-to-end tests are intentionally excluded; they are slow and belong to
 * `npm run test:e2e` from Phase 1a onwards.
 *
 * Exit code is non-zero on any failure. Output is a per-step table so the evidence file
 * can quote one command and one result.
 */
import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { config as loadDotenv } from "dotenv";

loadDotenv({ quiet: true });

// Stale `.next/**/types` from a previous dev/build session reference deleted routes and would
// fail typecheck. A gate is a clean build by definition.
rmSync(".next", { recursive: true, force: true });

const isWin = process.platform === "win32";
const skipDocker = process.env.GATE_SKIP_DOCKER === "1";

const testOwnerUrl = process.env.TEST_MIGRATE_DATABASE_URL;
const testRuntimeUrl = process.env.TEST_DATABASE_URL;
if (!testOwnerUrl || !testRuntimeUrl) {
  console.error("gate: TEST_MIGRATE_DATABASE_URL (migrator role) and TEST_DATABASE_URL (runtime role) must be set. See .env.example.");
  process.exit(2);
}
// Migrations and grants run as the migrator; everything under test connects as the runtime role.
const testEnv = { ...process.env, MIGRATE_DATABASE_URL: testOwnerUrl, DATABASE_URL: testRuntimeUrl, NODE_ENV: "test" };

const steps = [
  // Zero critical/high vulnerabilities in PRODUCTION dependencies. Dev-only tooling is audited
  // separately by `npm audit` (full) and tracked in docs; nothing is allowlisted here.
  { name: "dependency audit (prod, high+)", cmd: "npm audit --omit=dev --audit-level=high" },
  { name: "prisma generate", cmd: "npx prisma generate" },
  // --max-warnings=0: a warning is a defect that has not been triaged yet. Letting them
  // accumulate is how a codebase stops reading its own linter output.
  { name: "lint", cmd: "npx eslint . --max-warnings=0" },
  { name: "typecheck", cmd: "npx tsc --noEmit" },
  { name: "prisma validate", cmd: "npx prisma validate" },
  { name: "unit tests", cmd: "npx vitest run --project unit" },
  ...(skipDocker
    ? []
    : [{ name: "test db up", cmd: "docker compose up -d --wait test-db" }]),
  { name: "migrate deploy (test db, migrator role)", cmd: "node scripts/db-migrate.mjs deploy", env: testEnv },
  {
    name: "migrate status (test db)",
    cmd: "node scripts/db-migrate.mjs status",
    env: testEnv,
    expectOutput: /Database schema is up to date/,
  },
  {
    name: "runtime role grants (test db)",
    cmd: "node scripts/db-roles.mjs",
    env: testEnv,
    expectOutput: /db-roles: OK role/,
  },
  { name: "integration tests", cmd: "npx vitest run --project integration" },
  { name: "worker build", cmd: "node scripts/build-worker.mjs" },
  { name: "production build", cmd: "npx next build" },
  // Builds the `migrate` target and checks INSIDE the image. A staging deployment once died in
  // that container with ERR_MODULE_NOT_FOUND while every source-tree check here was green: the
  // Dockerfile copied two scripts and not the lib directory one of them imports. A source tree
  // cannot answer whether an image is complete, so this step asks the image.
  { name: "migrate image dependencies", cmd: "node scripts/check-migrate-image.mjs" },
];

const results = [];
const started = Date.now();

for (const step of steps) {
  const t0 = Date.now();
  process.stdout.write(`\n── gate: ${step.name} ── $ ${step.cmd}\n`);
  const res = spawnSync(step.cmd, {
    shell: isWin ? "cmd.exe" : true,
    stdio: step.expectOutput ? ["inherit", "pipe", "inherit"] : "inherit",
    env: step.env ?? process.env,
    encoding: "utf8",
  });
  let ok = res.status === 0;
  if (ok && step.expectOutput) {
    const out = res.stdout ?? "";
    process.stdout.write(out);
    ok = step.expectOutput.test(out);
    if (!ok) process.stderr.write(`gate: expected output matching ${step.expectOutput}\n`);
  }
  results.push({ step: step.name, ok, ms: Date.now() - t0 });
  if (!ok) break;
}

const width = Math.max(...results.map((r) => r.step.length));
console.log("\n" + "=".repeat(width + 22));
console.log("GATE SUMMARY");
console.log("=".repeat(width + 22));
for (const r of results) {
  console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.step.padEnd(width)}  ${String(r.ms).padStart(6)} ms`);
}
const failed = results.some((r) => !r.ok) || results.length !== steps.length;
console.log("-".repeat(width + 22));
console.log(
  `${failed ? "GATE FAILED" : "GATE PASSED"} in ${((Date.now() - started) / 1000).toFixed(1)}s ` +
    `(${results.filter((r) => r.ok).length}/${steps.length} steps)`,
);
process.exit(failed ? 1 : 0);
