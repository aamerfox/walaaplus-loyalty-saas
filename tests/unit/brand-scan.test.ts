import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The rebrand, held in place.
 *
 * A rename is easy to do and easy to half-do: the screens get renamed, and six months later a
 * merchant finds the old name in an error page, a tab title or a message file nobody opened. This
 * test walks the user-facing tree and fails on the old name.
 *
 * **It deliberately does not scan everything.** Infrastructure keeps its identifiers, because
 * renaming them would be a migration rather than a rebrand: the database role `walaaplus_app`, the
 * `walaaplus_*` trigger functions, the rate limiter's HMAC label (renaming it silently resets every
 * live window) and the worker's internal names. Those are listed below, and the list is the point:
 * a future reader can see exactly what was left and why, rather than wondering whether it was
 * missed.
 */

const ROOT = path.resolve(import.meta.dirname, "../..");
const OLD_BRAND = /walaaplus/i;

/** Trees whose contents reach a user's eyes. */
const USER_FACING = ["src/app", "src/components", "messages"];

/**
 * Files exempt from the scan, each with a reason.
 *
 * Every entry here is a place the old name is CORRECT: an identifier the product cannot rename
 * without a migration, or a record of history that would be falsified by editing it.
 */
const ALLOWED: { file: string; why: string }[] = [];

function walk(dir: string): string[] {
  const entries: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) entries.push(...walk(full));
    else if (/\.(ts|tsx|json|css|js)$/.test(name)) entries.push(full);
  }
  return entries;
}

describe("the Zademi rebrand", () => {
  it("leaves no old brand name in any user-facing file", () => {
    const offenders: string[] = [];
    for (const tree of USER_FACING) {
      for (const file of walk(path.join(ROOT, tree))) {
        const relative = path.relative(ROOT, file).replace(/\\/g, "/");
        if (ALLOWED.some((a) => a.file === relative)) continue;
        const contents = readFileSync(file, "utf8");
        if (OLD_BRAND.test(contents)) offenders.push(relative);
      }
    }
    expect(offenders, `the old brand name still appears in: ${offenders.join(", ")}`).toEqual([]);
  });

  it("names the product once, in the brand namespace, in both locales", () => {
    for (const locale of ["en", "ar"]) {
      const messages = JSON.parse(readFileSync(path.join(ROOT, `messages/${locale}.json`), "utf8")) as {
        Brand: { productName: string; tagline: string };
      };
      // The product name is the same word in every locale. A translated product name is a different
      // product, and a message file is exactly where one gets translated by a well-meaning hand.
      expect(messages.Brand.productName).toBe("Zademi");
      expect(messages.Brand.tagline.trim().length).toBeGreaterThan(0);
    }
  });

  it("keeps the brand palette in one place rather than scattered in components", () => {
    /*
     * The brand's hex values belong to the token file. A component that hard-codes one is a
     * component that will still be the old colour after the next brand change - which is exactly
     * what happened to the forty `indigo-600` call sites this design system replaced.
     *
     * The wordmark is the one exception, and it is a deliberate one: its mark is an inline SVG, and
     * SVG `fill` cannot read a Tailwind class.
     */
    const brandHex = /#(0B2D5B|00B3A4|2ED47A|F4F6F8|1F2937)/i;
    const offenders: string[] = [];
    for (const file of [...walk(path.join(ROOT, "src/app")), ...walk(path.join(ROOT, "src/components"))]) {
      const relative = path.relative(ROOT, file).replace(/\\/g, "/");
      if (relative === "src/components/brand/Wordmark.tsx") continue;
      if (relative.endsWith("globals.css")) continue;
      // The card's PWA manifest and theme colour are a customer-facing artefact with its own
      // palette decision, checked separately by the PWA tests.
      if (relative.includes("card/[shareToken]")) continue;
      if (brandHex.test(readFileSync(file, "utf8"))) offenders.push(relative);
    }
    expect(offenders, `brand colours are hard-coded in: ${offenders.join(", ")}`).toEqual([]);
  });
});
