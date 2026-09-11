#!/usr/bin/env node
/**
 * `npm run build:worker` — compile the pg-boss worker to a single ESM bundle.
 *
 * The production worker container runs `node dist/worker/index.mjs`: no TypeScript loader (tsx),
 * no source tree, no dev dependencies in the image. First-party code and pure-JS libraries (zod)
 * are bundled; anything with native bindings or generated code stays external and is resolved from
 * node_modules at runtime:
 *   - pg-boss and pg (native/optional bindings, ESM-only package)
 *   - @prisma/client and .prisma/client (generated per schema)
 *
 * Output is ESM because pg-boss is ESM-only ("type": "module"); a CommonJS bundle could not import
 * it synchronously.
 */
import { build } from "esbuild";
import { rmSync } from "node:fs";

rmSync("dist/worker", { recursive: true, force: true });

await build({
  entryPoints: ["src/worker/index.ts"],
  outfile: "dist/worker/index.mjs",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  sourcemap: true,
  legalComments: "none",
  external: ["pg-boss", "pg", "pg-native", "@prisma/client", ".prisma/client", "@prisma/*"],
  logLevel: "info",
  banner: {
    // Some CJS dependencies pulled into an ESM bundle expect `require` to exist.
    js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);',
  },
});
