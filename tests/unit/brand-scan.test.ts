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
 * It also holds the **asset** half of the brand, which arrived after the first pass: the approved
 * masters must be present and referenced, and the temporary drawing that stood in for them must be
 * gone rather than merely unused.
 *
 * **It deliberately does not scan everything.** Infrastructure keeps its identifiers, because
 * renaming them would be a migration rather than a rebrand: the database role `walaaplus_app`, the
 * `walaaplus_*` trigger functions, the rate limiter's HMAC label (renaming it silently resets every
 * live window) and the worker's internal names. That list lives in `docs/BRAND.md` §5, and it being
 * written down is the point — a future reader can see what was left and why.
 */

const ROOT = path.resolve(import.meta.dirname, "../..");
/**
 * The old name, in both scripts.
 *
 * The Latin half of this rule passed for months while the Arabic registration page still carried
 * the old product name transliterated — and carrying a fatha on the waw, so that even a search in
 * Arabic for the plain spelling missed it. Diacritics are stripped before the test, because a brand
 * leak must not be able to hide behind a vowel mark.
 */
const OLD_BRAND = /walaaplus/i;
const OLD_BRAND_ARABIC = /ولاء\s*بلس/;
const ARABIC_DIACRITICS = /[ً-ْٰ]/g;

/** Trees whose contents reach a user's eyes. */
const USER_FACING = ["src/app", "src/components", "messages"];

/** The approved masters, exactly as supplied. Nothing in the product may redraw these. */
const MASTERS = [
  "public/brand/Zademi-Logo.svg",
  "public/brand/Zademi-Symbol.svg",
  "public/brand/Zademi-Icon-1024.png",
  "public/brand/Zademi-Logo-Dark.png",
  "public/brand/Zademi-Logo-White.png",
];

/** Rendered from the approved icon by `scripts/make-icons.mjs`, and committed. */
const DERIVATIVES = [
  "public/icons/card-192.png",
  "public/icons/card-512.png",
  "public/icons/card-maskable-512.png",
  "public/icons/apple-touch-icon.png",
  "public/icons/favicon-32.png",
  "public/icons/favicon-16.png",
  "src/app/favicon.ico",
];

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
        const contents = readFileSync(file, "utf8");
        const unvocalised = contents.replace(ARABIC_DIACRITICS, "");
        if (OLD_BRAND.test(contents) || OLD_BRAND_ARABIC.test(unvocalised)) {
          offenders.push(path.relative(ROOT, file).replace(/\\/g, "/"));
        }
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
});

describe("the official brand assets", () => {
  it("are present, non-empty, and the SVG masters are real vectors", () => {
    for (const file of MASTERS) {
      const bytes = readFileSync(path.join(ROOT, file));
      expect(bytes.length, `${file} is empty`).toBeGreaterThan(1_000);
    }
    for (const svg of MASTERS.filter((f) => f.endsWith(".svg"))) {
      const text = readFileSync(path.join(ROOT, svg), "utf8");
      expect(text).toContain("<svg");
      // A "vector" that embeds a bitmap is a rasterised logo with extra steps, and it would blur on
      // exactly the screens a vector exists for.
      expect(text, `${svg} embeds a raster image`).not.toMatch(/<image[\s>]/);
      expect(text, `${svg} embeds base64 data`).not.toContain("base64");
    }
  });

  it("renders every derivative the manifest and the browser ask for", () => {
    for (const file of DERIVATIVES) {
      const bytes = readFileSync(path.join(ROOT, file));
      expect(bytes.length, `${file} is empty`).toBeGreaterThan(200);
    }
    // PNG magic, so a truncated or half-written render fails here rather than on a home screen.
    for (const png of DERIVATIVES.filter((f) => f.endsWith(".png"))) {
      const head = readFileSync(path.join(ROOT, png)).subarray(0, 8);
      expect([...head], `${png} is not a PNG`).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    }
  });

  it("draws the logo from the masters, with no temporary mark left behind", () => {
    const wordmark = readFileSync(path.join(ROOT, "src/components/brand/Wordmark.tsx"), "utf8");
    for (const master of ["Zademi-Logo.svg", "Zademi-Symbol.svg", "Zademi-Logo-White.png", "Zademi-Logo-Dark.png"]) {
      expect(wordmark, `the logo component does not reference ${master}`).toContain(master);
    }
    /*
     * The stand-in was an inline `<path>` drawing a diamond in a rounded tile. It was correct while
     * no approved artwork existed and it is wrong now: two marks in one product is how the old one
     * survives on the screen nobody re-checked.
     */
    expect(wordmark, "the temporary geometric mark is still drawn").not.toContain("<path");
    expect(wordmark, "the temporary wordmark still renders the name as text").not.toMatch(/>\s*Zademi\s*</);
  });

  it("keeps the brand palette in one place rather than scattered in components", () => {
    /*
     * The brand's hex values belong to the token file. A component that hard-codes one is a
     * component that will still be the old colour after the next brand change - which is exactly
     * what happened to the forty `indigo-600` call sites this design system replaced.
     *
     * The installed card's `theme_color` is the one legitimate exception: a manifest is JSON served
     * to a phone's launcher, and it cannot read a CSS variable.
     */
    const brandHex = /#(0B2D5B|00B3A4|2ED47A|F4F6F8|1F2937)/i;
    const allowed = new Set([
      "src/app/[locale]/card/[shareToken]/manifest.webmanifest/route.ts",
      "src/app/[locale]/card/[shareToken]/page.tsx",
    ]);
    const offenders: string[] = [];
    for (const file of [...walk(path.join(ROOT, "src/app")), ...walk(path.join(ROOT, "src/components"))]) {
      const relative = path.relative(ROOT, file).replace(/\\/g, "/");
      if (allowed.has(relative) || relative.endsWith("globals.css")) continue;
      if (brandHex.test(readFileSync(file, "utf8"))) offenders.push(relative);
    }
    expect(offenders, `brand colours are hard-coded in: ${offenders.join(", ")}`).toEqual([]);
  });
});
