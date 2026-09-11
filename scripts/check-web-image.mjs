#!/usr/bin/env node
/**
 * Prove that the `web` IMAGE answers on its own loopback, the way its healthcheck probes it.
 *
 *   node scripts/check-web-image.mjs
 *   WEB_IMAGE_TAG=x node scripts/check-web-image.mjs
 *   GATE_SKIP_DOCKER=1 node scripts/check-web-image.mjs      # skipped, exits 0
 *
 * WHY THIS EXISTS. A staging deployment got all the way through: the database came up healthy,
 * migrations applied, the restricted runtime role was created, web and worker started. Then the
 * web container's healthcheck failed:
 *
 *   wget: can't connect to remote host (127.0.0.1): Connection refused
 *
 * while the very same endpoint answered `{"status":"ok"}` from the host through the published
 * port. Both observations were correct, and that is what makes this defect worth a real test.
 *
 * The Next standalone server does:
 *
 *   const hostname = process.env.HOSTNAME || "0.0.0.0"
 *
 * and Docker sets HOSTNAME to the container ID unless it is overridden. So the server bound the
 * container's bridge address ALONE. A request from the host worked, because published ports are
 * forwarded to that bridge address. A request from inside the container to 127.0.0.1 was refused,
 * because nothing was listening there. The healthcheck was right; the binding was wrong.
 *
 * No source-tree check could see this: the application code is correct, the Compose file was
 * valid, the image built. It is a property of a RUNNING container in Docker's default
 * environment, so this test runs one.
 *
 * WHAT IT DOES:
 *
 *   1. builds `--target web`;
 *   2. runs a container the way the incident ran, with Docker's default HOSTNAME, and records
 *      which address the server bound. This reproduces the incident condition;
 *   3. runs a second container with HOSTNAME=0.0.0.0, the fix, and REQUIRES a real HTTP response
 *      on 127.0.0.1:3000 from inside that container;
 *   4. requires every Compose file that runs this image with a loopback healthcheck to set
 *      HOSTNAME explicitly, and fails if that override is removed.
 *
 * Step 3 accepts ANY HTTP status. The endpoint runs `SELECT 1`, and these containers are given a
 * placeholder database that does not exist, so 503 is the expected and correct answer. What is
 * being proved is that something is listening on loopback and speaking HTTP, which is exactly
 * what the healthcheck needs and exactly what was missing.
 *
 * Step 2 is REPORTED, not asserted. If a future Next release binds 0.0.0.0 regardless of
 * HOSTNAME, that step stops reproducing, and failing the gate because upstream fixed a bug would
 * be absurd. The load-bearing assertions are steps 3 and 4.
 *
 * The containers get placeholder environment values that are obviously not credentials, and no
 * database exists at the address in them. Nothing is published to the host.
 */
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const TAG = process.env.WEB_IMAGE_TAG ?? "walaaplus-web:gate-check";
const PORT = 3000;
const READY_TIMEOUT_MS = 90_000;

/** Obvious non-values. No database exists at this address; env validation only checks shape. */
const PLACEHOLDER_ENV = [
  "DATABASE_URL=postgresql://placeholder:placeholder-not-a-real-password@127.0.0.1:5432/placeholder?schema=public",
  "NEXTAUTH_SECRET=placeholder-value-at-least-32-characters-long",
  "NEXTAUTH_URL=https://placeholder.invalid",
];

/** Compose files that run this image AND probe it on loopback. Each must override HOSTNAME. */
const COMPOSE_FILES = [
  "docker-compose.staging.yml",
  "docker-compose.staging-cohost.yml",
  "docker-compose.yml",
];

if (process.env.GATE_SKIP_DOCKER === "1") {
  process.stdout.write("check-web-image: skipped (GATE_SKIP_DOCKER=1)\n");
  process.exit(0);
}

const started = [];

function fail(message, detail) {
  cleanup();
  process.stderr.write(`check-web-image: FAIL - ${message}\n`);
  if (detail) process.stderr.write(`${String(detail).trim()}\n`);
  process.exit(1);
}

function docker(args, { allowFailure = false } = {}) {
  const result = spawnSync("docker", args, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  if (result.error) fail(`could not run docker: ${result.error.message}`);
  if (!allowFailure && result.status !== 0) {
    fail(`docker ${args.slice(0, 2).join(" ")} exited ${result.status}`, result.stderr || result.stdout);
  }
  return result;
}

function cleanup() {
  for (const id of started.splice(0)) {
    spawnSync("docker", ["rm", "-f", id], { encoding: "utf8" });
  }
}
process.on("exit", cleanup);
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => { cleanup(); process.exit(1); });

/**
 * Start a detached web container. `overrideHostname` false leaves Docker's default in place,
 * which is the incident condition; true applies the fix.
 */
function startWeb(overrideHostname) {
  const args = ["run", "-d", "--rm"];
  for (const pair of PLACEHOLDER_ENV) args.push("-e", pair);
  if (overrideHostname) args.push("-e", "HOSTNAME=0.0.0.0");
  args.push(TAG);
  const id = docker(args).stdout.trim();
  started.push(id);
  return id;
}

/** Wait until the server is listening on PORT, and return the address it bound. */
function waitForListener(id, label) {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const alive = docker(["inspect", "-f", "{{.State.Running}}", id], { allowFailure: true });
    if (alive.stdout.trim() !== "true") {
      fail(`the ${label} container exited before it listened`, docker(["logs", id], { allowFailure: true }).stdout);
    }
    // busybox netstat, present in node:*-alpine. Shows the address actually bound, which is the
    // whole point: "listening" is not a yes/no question here, it is a "where" question.
    const sockets = docker(["exec", id, "sh", "-c", `netstat -ltn 2>/dev/null | grep ':${PORT} '`], {
      allowFailure: true,
    });
    const line = sockets.stdout.trim();
    if (line) return line.split(/\s+/)[3] ?? line;
    spawnSync(process.execPath, ["-e", "setTimeout(()=>{}, 1000)"]);
  }
  fail(`the ${label} container never listened on ${PORT} within ${READY_TIMEOUT_MS / 1000}s`,
    docker(["logs", id], { allowFailure: true }).stdout);
}

/** Probe 127.0.0.1:PORT from INSIDE the container. Returns {status} or {error}. */
function probeLoopback(id) {
  const script =
    `const http = require("node:http");` +
    `const req = http.get({host:"127.0.0.1",port:${PORT},path:"/api/health",timeout:10000}, (res) => {` +
    `  res.resume(); console.log("STATUS " + res.statusCode); });` +
    `req.on("timeout", () => { console.log("ERROR TIMEOUT"); req.destroy(); });` +
    `req.on("error", (e) => console.log("ERROR " + (e.code || e.message)));`;
  const out = docker(["exec", id, "node", "-e", script], { allowFailure: true }).stdout.trim();
  if (out.startsWith("STATUS ")) return { status: Number(out.slice(7)) };
  return { error: out.replace(/^ERROR /, "") || "no output" };
}

// ---------------------------------------------------------------------------
process.stdout.write(`check-web-image: building --target web as ${TAG}\n`);
docker(["build", "--target", "web", "-t", TAG, "."]);

// --- 2. The incident condition, reproduced and reported --------------------------------------
const incidentId = startWeb(false);
const incidentBinding = waitForListener(incidentId, "default-HOSTNAME");
const incidentProbe = probeLoopback(incidentId);
process.stdout.write(
  `check-web-image: with Docker's default HOSTNAME the server bound ${incidentBinding}, ` +
    `and 127.0.0.1:${PORT} answered: ${incidentProbe.error ?? `HTTP ${incidentProbe.status}`}\n`,
);
if (incidentProbe.error) {
  process.stdout.write("check-web-image: that is the incident reproduced - the healthcheck was right\n");
} else {
  process.stdout.write(
    "check-web-image: NOTE - loopback answered without the override, so the upstream default may " +
      "have changed. The override is then harmless rather than required; nothing fails on this.\n",
  );
}
docker(["rm", "-f", incidentId], { allowFailure: true });
started.splice(started.indexOf(incidentId), 1);

// --- 3. The fix, required to work ------------------------------------------------------------
const fixedId = startWeb(true);
const fixedBinding = waitForListener(fixedId, "HOSTNAME=0.0.0.0");
const fixedProbe = probeLoopback(fixedId);

if (fixedProbe.error) {
  fail(
    `with HOSTNAME=0.0.0.0 the server bound ${fixedBinding} but 127.0.0.1:${PORT} still ` +
      `answered "${fixedProbe.error}". The container healthcheck will fail exactly as it did on ` +
      "the staging deployment.",
    docker(["logs", fixedId], { allowFailure: true }).stdout,
  );
}
process.stdout.write(
  `check-web-image: with HOSTNAME=0.0.0.0 the server bound ${fixedBinding}, and ` +
    `127.0.0.1:${PORT} answered HTTP ${fixedProbe.status} (any status proves loopback works; ` +
    "503 is correct here, the placeholder database does not exist)\n",
);
cleanup();

// --- 4. The configuration must carry the override --------------------------------------------
for (const file of COMPOSE_FILES) {
  const text = readFileSync(file, "utf8");
  const web = text.split("\n  web:")[1];
  if (web === undefined) fail(`${file} has no web service; update COMPOSE_FILES in this script`);
  const body = web.split("\n  worker:")[0];
  if (!/^\s+HOSTNAME:\s*"?0\.0\.0\.0"?\s*$/m.test(body)) {
    fail(
      `${file} does not set HOSTNAME: "0.0.0.0" on its web service. Docker will supply the ` +
        "container ID instead, the standalone server will bind the bridge address alone, and a " +
        "loopback healthcheck will be refused while the host still gets answers through the " +
        "published port.",
    );
  }
}

process.stdout.write(
  `check-web-image: OK - the built web image answers on its own loopback with the override, and ` +
    `${COMPOSE_FILES.length} Compose files set it explicitly\n`,
);
