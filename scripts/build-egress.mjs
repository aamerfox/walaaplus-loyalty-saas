#!/usr/bin/env node
/**
 * `npm run build:egress` — compile the webhook egress gateway to a single ESM bundle.
 *
 * The gateway container runs `node dist/egress/index.mjs`: no TypeScript loader, no source tree, no
 * dev dependencies, and — the part that matters — **no Prisma client and no database driver**.
 *
 * Nothing is external. The gateway's entire dependency graph is `node:http`, `node:https`,
 * `node:crypto`, `node:dns` and `node:net`, so the bundle is self-contained and the image needs no
 * `node_modules` at all. If a future edit imports something that pulls in `@prisma/client` or `pg`,
 * this build starts resolving them and `tests/unit/webhook-egress-boundary.test.ts` fails first.
 */
import { build } from "esbuild";
import { rmSync } from "node:fs";

rmSync("dist/egress", { recursive: true, force: true });

await build({
  entryPoints: ["src/egress/index.ts"],
  outfile: "dist/egress/index.mjs",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  sourcemap: true,
  legalComments: "none",
  logLevel: "info",
});
