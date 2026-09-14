#!/usr/bin/env node
/**
 * Serve the STANDALONE build for end-to-end tests.
 *
 * `next start` prints "does not work with output: standalone" and is not the artifact a merchant
 * runs — the Dockerfile's `web` target runs `node server.js` out of `.next/standalone`. Testing
 * the thing we ship is worth the twenty lines it takes: a bug in the standalone assembly (a
 * missing static asset, an icon that 404s) would otherwise only appear after deployment.
 *
 * The standalone output deliberately excludes `.next/static` and `public`, because a real
 * deployment usually serves them from a CDN or the reverse proxy. Here there is neither, so they
 * are copied in, exactly as the Dockerfile copies them into the image.
 */
import { cpSync, existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";

const root = process.cwd();
const standalone = resolve(root, ".next/standalone");
const server = resolve(standalone, "server.js");

if (!existsSync(server)) {
  process.stderr.write("e2e-server: no standalone build found. Run `npm run build` first.\n");
  process.exit(2);
}

cpSync(resolve(root, ".next/static"), resolve(standalone, ".next/static"), { recursive: true });
if (existsSync(resolve(root, "public"))) {
  cpSync(resolve(root, "public"), resolve(standalone, "public"), { recursive: true });
}

const port = process.env.PORT ?? "3100";
process.stdout.write(`e2e-server: serving the standalone build on port ${port}\n`);

/*
 * A throwaway webhook encryption key, generated per run and never written down.
 *
 * Without it the webhook feature fails closed — which is correct, and which is what the integration
 * tests assert by removing it deliberately. The browser suite needs the opposite: a server that CAN
 * configure a destination, so the owner journeys exercise something.
 *
 * It is generated here rather than read from a file or an example template, so **no value for
 * `INTEGRATION_ENCRYPTION_KEY` exists anywhere in this repository**, and one run's key is useless
 * against another's. A real environment's key is Freebuff's to provision; see
 * `docs/INTEGRATIONS-CAPABILITY-MATRIX.md` §8a.
 *
 * An externally supplied value wins, so a developer can point the suite at a fixed key if they ever
 * need to reproduce something.
 */
const integrationKey = process.env.INTEGRATION_ENCRYPTION_KEY ?? randomBytes(32).toString("hex");

const child = spawn(process.execPath, [server], {
  stdio: "inherit",
  env: {
    ...process.env,
    PORT: port,
    HOSTNAME: process.env.HOSTNAME ?? "127.0.0.1",
    // Never printed. The parent does not log it and the child's env is not echoed anywhere.
    INTEGRATION_ENCRYPTION_KEY: integrationKey,
  },
});
child.on("exit", (code) => process.exit(code ?? 0));
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
