#!/usr/bin/env node
/**
 * Prove that the `migrate` IMAGE can actually run its own entrypoint.
 *
 *   node scripts/check-migrate-image.mjs            # build the target, then check inside it
 *   MIGRATE_IMAGE_TAG=x node scripts/check-migrate-image.mjs
 *   GATE_SKIP_DOCKER=1 node scripts/check-migrate-image.mjs   # skipped, exits 0
 *
 * WHY THIS EXISTS. A staging deployment reached the `migrate` container and died with
 *
 *   Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/app/scripts/lib/db-role-membership.mjs'
 *   imported from /app/scripts/db-roles.mjs
 *
 * The file was in the repository, every test passed, the gate was green, and the image was still
 * broken: the Dockerfile copied `scripts/db-migrate.mjs` and `scripts/db-roles.mjs` and nothing
 * else under `scripts/`. Every check we had ran against the SOURCE TREE, where the helper exists.
 * A source-tree test cannot catch this class of defect, by construction — so this one runs inside
 * the built artifact.
 *
 * It matters more here than for the other images because `migrate` gates the deployment: `web`
 * and `worker` wait on it completing successfully, so a broken migrate image is not a degraded
 * service, it is a deployment that cannot start.
 *
 * WHAT IT DOES, in order, and what it deliberately does not do:
 *
 *   1. builds `--target migrate`;
 *   2. lists `/app/scripts` inside the image and requires the helper to be present;
 *   3. imports the helper inside the image and requires its export to be a function — presence on
 *      disk is not the same as being resolvable by Node;
 *   4. RUNS `scripts/db-roles.mjs` inside the image with an empty environment and no network, and
 *      requires the failure to be the missing-variable message rather than ERR_MODULE_NOT_FOUND.
 *      Module resolution happens before any top-level code, so this proves the entire module
 *      graph links — the exact thing the deployment proved was broken.
 *
 * Every container runs with `--network none`, so nothing can reach a database. No environment
 * file is passed in, and the script under test prints variable NAMES only, never values.
 */
import { spawnSync } from "node:child_process";

const TAG = process.env.MIGRATE_IMAGE_TAG ?? "walaaplus-migrate:gate-check";
const HELPER = "/app/scripts/lib/db-role-membership.mjs";

if (process.env.GATE_SKIP_DOCKER === "1") {
  process.stdout.write("check-migrate-image: skipped (GATE_SKIP_DOCKER=1)\n");
  process.exit(0);
}

function fail(message, detail) {
  process.stderr.write(`check-migrate-image: FAIL - ${message}\n`);
  if (detail) process.stderr.write(`${String(detail).trim()}\n`);
  process.exit(1);
}

function run(args, { allowFailure = false } = {}) {
  const result = spawnSync("docker", args, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  if (result.error) fail(`could not run docker: ${result.error.message}`);
  if (!allowFailure && result.status !== 0) {
    fail(`docker ${args.slice(0, 2).join(" ")} exited ${result.status}`, result.stderr || result.stdout);
  }
  return result;
}

/** Run a command inside the image with no network and no inherited environment. */
function inImage(argv, options) {
  return run(["run", "--rm", "--network", "none", TAG, ...argv], options);
}

// ---------------------------------------------------------------------------
// 1. Build the target. Layers are cached, so this is cheap on a warm machine and correct on a
//    cold one, which is the only combination worth having in a gate.
process.stdout.write(`check-migrate-image: building --target migrate as ${TAG}\n`);
run(["build", "--target", "migrate", "-t", TAG, "."]);

// ---------------------------------------------------------------------------
// 2. The helper is present in the image.
const listing = inImage(["sh", "-c", `ls -1 ${HELPER}`], { allowFailure: true });
if (listing.status !== 0) {
  fail(
    `${HELPER} is missing from the migrate image. ` +
      "scripts/db-roles.mjs imports it, so the container will die with ERR_MODULE_NOT_FOUND " +
      "before it applies a single migration. Check the COPY lines in the Dockerfile's migrate target.",
    listing.stderr,
  );
}

// ---------------------------------------------------------------------------
// 3. Node can import it, and it exports what db-roles.mjs destructures from it. A file that is
//    present but unreadable, or an export that was renamed, both fail here.
const imported = inImage(
  [
    "node",
    "--input-type=module",
    "-e",
    `const m = await import(${JSON.stringify(HELPER)});
     if (typeof m.decideMembershipAction !== "function") {
       console.error("decideMembershipAction is not exported as a function");
       process.exit(3);
     }
     console.log("import-ok");`,
  ],
  { allowFailure: true },
);
if (imported.status !== 0 || !imported.stdout.includes("import-ok")) {
  fail("the helper exists but Node cannot import it from inside the image", imported.stderr || imported.stdout);
}

// ---------------------------------------------------------------------------
// 4. The entrypoint's whole module graph links. Resolution happens before top-level code, so a
//    run with no environment either dies at link time (the deployment failure) or reaches its own
//    validation and reports a missing variable by NAME (what we want).
const linked = inImage(["node", "scripts/db-roles.mjs"], { allowFailure: true });
const output = `${linked.stdout}\n${linked.stderr}`;

if (output.includes("ERR_MODULE_NOT_FOUND")) {
  fail("scripts/db-roles.mjs still cannot resolve its imports inside the image", output);
}
if (!output.includes("MIGRATE_DATABASE_URL is not set")) {
  fail(
    "scripts/db-roles.mjs did not reach its own environment validation. Something else broke " +
      "before it: read the output below rather than assuming it is the module graph.",
    output,
  );
}

process.stdout.write(
  `check-migrate-image: OK - ${HELPER} present and importable, and scripts/db-roles.mjs links ` +
    "and reaches its own environment validation (no database was contacted)\n",
);
