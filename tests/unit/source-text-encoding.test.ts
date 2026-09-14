import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Tracked source has to be readable by the tools that read source.
 *
 * A single physical U+0000 byte makes Git classify a file as binary. It stops appearing in
 * `git diff`, `git log -p` and `git blame`; `git grep` skips it; a pull request shows "Binary files
 * differ" instead of the change. Every one of those is a review that silently did not happen, and
 * the file it happened to in this repository was the one deciding how coupon codes are hashed.
 *
 * The separator itself is not the problem — a NUL between the parts of a digest input is the right
 * way to stop `("AB", "C")` and `("A", "BC")` colliding. Writing it as the TypeScript escape `\0`
 * produces exactly the same byte at runtime and leaves the file made of text.
 */

const REPO_ROOT = join(import.meta.dirname, "..", "..");

function git(...args: string[]): string {
  return execFileSync("git", args, { cwd: REPO_ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

/** Extensions a human reviews, as opposed to images, fonts and icons. */
const REVIEWED = /\.(ts|tsx|js|jsx|mjs|cjs|json|md|sql|css|ya?ml|prisma|sh|txt|html)$/i;

const TRACKED = git("ls-files", "-z")
  .split("\0")
  .filter((p) => p.length > 0);

describe("tracked source is text, not binary", () => {
  it("finds no physical NUL byte in any reviewed file", () => {
    const offenders: string[] = [];
    for (const path of TRACKED) {
      if (!REVIEWED.test(path)) continue;
      const bytes = readFileSync(join(REPO_ROOT, path));
      if (bytes.includes(0)) offenders.push(path);
    }
    expect(
      offenders,
      "a NUL byte here makes Git treat the file as binary, so diffs, blame and grep skip it",
    ).toEqual([]);
  });

  /**
   * The two files this rule was written for, checked by asking Git rather than by inspecting bytes.
   *
   * `--numstat` prints added and removed line counts for a text file and a pair of dashes for a
   * binary one, so this is Git's own verdict on whether the file can be reviewed.
   */
  it("gets a line count out of Git for the coupon digest files", () => {
    const empty = join(mkdtempSync(join(tmpdir(), "walaaplus-numstat-")), "empty");
    writeFileSync(empty, "");

    for (const path of ["src/server/promotions/codes.ts", "tests/unit/promotion-codes.test.ts"]) {
      let out = "";
      try {
        // `--no-index` compares two paths directly; it exits 1 when they differ, which they do.
        out = git("diff", "--numstat", "--no-index", "--", empty, path);
      } catch (e) {
        out = String((e as { stdout?: Buffer }).stdout ?? "");
      }
      const [added, removed] = out.trim().split(/\s+/);
      expect(added, `${path} reads as binary to Git`).toMatch(/^\d+$/);
      expect(removed, path).toBe("0");
      expect(Number(added), `${path} should have real lines`).toBeGreaterThan(10);
    }
  });

  it("keeps the digest separator as an escape, and it still produces a NUL at runtime", () => {
    const source = readFileSync(join(REPO_ROOT, "src/server/promotions/codes.ts"), "utf8");
    // Two separators, both written as the two characters backslash and zero.
    expect(source.split("\\0")).toHaveLength(3);
    expect(source).not.toContain("\0");
    // And the escape means what it has to mean: one NUL byte, not the text "\0".
    expect("\0".charCodeAt(0)).toBe(0);
  });
});
