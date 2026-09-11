import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The migrate image must contain every local module its entrypoint imports.
 *
 * A staging deployment reached the `migrate` container and died before applying a single
 * migration:
 *
 *   Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/app/scripts/lib/db-role-membership.mjs'
 *   imported from /app/scripts/db-roles.mjs
 *
 * The helper was in the repository the whole time. The Dockerfile's migrate target copied
 * `scripts/db-migrate.mjs` and `scripts/db-roles.mjs` and nothing else under `scripts/`, so the
 * image was missing a file that every source-tree check could see. That is the trap: this defect
 * is invisible to a test that reads the repository.
 *
 * **This test is therefore the cheap first line, not the proof.** It reads the entrypoints'
 * relative imports and checks a COPY line covers each one, which catches the mistake at edit time
 * in milliseconds. The actual proof is `scripts/check-migrate-image.mjs`, a gate step that BUILDS
 * the image and imports the module graph inside it — only that can answer whether the artifact is
 * complete.
 *
 * It is written against the import graph rather than against one filename, so a helper added to
 * `scripts/lib/` next year is covered without anyone remembering this file exists.
 */

const ROOT = path.resolve(import.meta.dirname, "../..");
const dockerfile = readFileSync(path.join(ROOT, "Dockerfile"), "utf8");

/** The `FROM … AS <stage>` block for one target, up to the next FROM. */
function stage(name: string): string {
  const lines = dockerfile.split("\n");
  const start = lines.findIndex((l) => l.trim().startsWith("FROM ") && l.trim().endsWith(`AS ${name}`));
  expect(start, `Dockerfile must define a ${name} stage`).toBeGreaterThanOrEqual(0);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => l.trim().startsWith("FROM "));
  return (end === -1 ? rest : rest.slice(0, end)).join("\n");
}

/** Relative import specifiers in one source file, e.g. `./lib/db-role-membership.mjs`. */
function relativeImports(file: string): string[] {
  const source = readFileSync(path.join(ROOT, file), "utf8");
  const found: string[] = [];
  for (const line of source.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("import ") && !trimmed.startsWith("} from")) continue;
    const quote = trimmed.includes('"') ? '"' : "'";
    const parts = trimmed.split(quote);
    if (parts.length < 2) continue;
    const specifier = parts[1];
    if (specifier.startsWith(".")) found.push(specifier);
  }
  return found;
}

/** Paths, relative to the build context, that a stage's COPY lines bring in. */
function copiedPaths(stageBody: string): string[] {
  return stageBody
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("COPY ") && !l.includes("--from="))
    .flatMap((l) => {
      // COPY [--flags] <src...> <dest>  — drop the flags and the destination.
      const tokens = l.split(/\s+/).slice(1).filter((t) => !t.startsWith("--"));
      return tokens.slice(0, -1);
    });
}

describe("Dockerfile migrate target — local module dependencies", () => {
  const ENTRYPOINTS = ["scripts/db-migrate.mjs", "scripts/db-roles.mjs"];
  const body = stage("migrate");
  const copied = copiedPaths(body);

  it("copies both entrypoint scripts", () => {
    for (const entry of ENTRYPOINTS) {
      expect(copied, `the migrate image needs ${entry}`).toContain(entry);
    }
  });

  it("copies every local module the entrypoints import", () => {
    for (const entry of ENTRYPOINTS) {
      for (const specifier of relativeImports(entry)) {
        // `./lib/db-role-membership.mjs` imported from `scripts/db-roles.mjs`
        // resolves to `scripts/lib/db-role-membership.mjs`.
        const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(entry), specifier));
        const covered = copied.some((src) => resolved === src || resolved.startsWith(`${src}/`));
        expect(
          covered,
          `${entry} imports ${specifier}, which resolves to ${resolved}. No COPY line in the ` +
            "migrate stage brings it into the image, so the container will die with " +
            `ERR_MODULE_NOT_FOUND. Copied: ${copied.join(", ")}`,
        ).toBe(true);
      }
    }
  });

  it("reads the real import graph, not a hardcoded filename", () => {
    // Guards the guard: if this ever returns nothing, the test above passes vacuously and the
    // defect it exists for comes straight back.
    const imports = relativeImports("scripts/db-roles.mjs");
    expect(imports).toContain("./lib/db-role-membership.mjs");
    expect(imports.length).toBeGreaterThan(0);
  });

  it("defers the real proof to a check that runs inside the built image", () => {
    // This file reads the repository, where the missing helper has always existed. Only the
    // image can answer whether the image is complete.
    const gate = readFileSync(path.join(ROOT, "scripts/gate.mjs"), "utf8");
    expect(gate, "the gate must build and inspect the migrate image").toContain(
      "scripts/check-migrate-image.mjs",
    );
  });
});
