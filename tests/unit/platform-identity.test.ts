import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Platform identity versus tenant identity.
 *
 * The product is **Zademi**. `TrueBiznes` is the name of one business row in the staging database —
 * a customer of the platform, not the platform. The previous release blurred the two: the tenant's
 * name was printed under the logo in the sidebar, repeated as the subtitle of every merchant page,
 * and shown as the scanner's heading, so every authenticated screen read as though the product were
 * called TrueBiznes.
 *
 * That is not a class of bug a screenshot review catches reliably, because the offending string is
 * *correct data in the wrong role*. So the rule is enforced here, in source:
 *
 *  - no tenant name is ever written into the product. A business name reaches the screen from the
 *    database, through a labelled control, or it does not reach the screen at all;
 *  - the logo is drawn in exactly one component, from the approved masters;
 *  - a page heading is the page's own name, never the business's.
 *
 * The sibling `brand-scan.test.ts` holds the other half: that the old WalaaPlus name and the
 * temporary geometric mark are gone. Together they are the pair of tests that would have failed on
 * the release the owner rejected.
 */

const ROOT = path.resolve(import.meta.dirname, "../..");

/** Everything whose contents reach a merchant's eyes. */
const USER_FACING = ["src/app", "src/components", "messages"];

/**
 * Tenant names that exist in the staging data.
 *
 * Any of these appearing in source is by definition hard-coded chrome: the real ones come from
 * `Business.name`.
 */
const TENANT_NAMES = [/TrueBiznes/i];

function walk(dir: string): string[] {
  const entries: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) entries.push(...walk(full));
    else if (/\.(ts|tsx|json|css)$/.test(name)) entries.push(full);
  }
  return entries;
}

/**
 * Source with its comments removed.
 *
 * The prose in this codebase explains what went wrong, and explaining the tenant-name mistake means
 * writing the tenant's name down. A scan that cannot tell a rendered string from a paragraph about
 * a bug would force the fix and its explanation to be deleted together.
 */
function code(file: string) {
  return readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
}

function relative(file: string) {
  return path.relative(ROOT, file).replace(/\\/g, "/");
}

function userFacingFiles() {
  return USER_FACING.flatMap((tree) => walk(path.join(ROOT, tree)));
}

describe("the platform is never named after a tenant", () => {
  it("hard-codes no business name in any user-facing file", () => {
    const offenders: string[] = [];
    for (const file of userFacingFiles()) {
      const contents = file.endsWith(".json") ? readFileSync(file, "utf8") : code(file);
      if (TENANT_NAMES.some((name) => name.test(contents))) offenders.push(relative(file));
    }
    expect(offenders, `a tenant's name is hard-coded in: ${offenders.join(", ")}`).toEqual([]);
  });

  it("gives the page header no way to print a business name", () => {
    /*
     * Structural, not incidental. Every merchant page's subtitle used to be `subtitle={businessName}`
     * — one prop, twelve screens, and the tenant's name became the product's. The prop is gone, so
     * the mistake cannot be made again without adding it back on purpose.
     */
    const ui = readFileSync(path.join(ROOT, "src/components/ui/index.tsx"), "utf8");
    const header = ui.slice(ui.indexOf("export function PageHeader"), ui.indexOf("export function Toolbar"));
    expect(header).not.toMatch(/business/i);
    expect(header).not.toMatch(/\bsubtitle\b/);
  });

  it("shows the business only through the labelled business-context control", () => {
    /*
     * One component may render `businessName` as identity, and it is the one that labels what the
     * name IS. Everywhere else a business name appears it must be the subject of the screen (a row
     * in a list, a field in a form), never the screen's own title.
     */
    const context = readFileSync(path.join(ROOT, "src/components/dashboard/BusinessContext.tsx"), "utf8");
    expect(context).toContain("businessLabel");

    const chrome = ["src/components/dashboard/Header.tsx", "src/components/dashboard/Sidebar.tsx"];
    for (const file of chrome) {
      const source = readFileSync(path.join(ROOT, file), "utf8");
      // The shell's own markup names the product. It may pass business data THROUGH to the
      // context control, but it may not render a business name itself.
      expect(source.match(/\{\s*business(Name|\.name)\s*\}/g), `${file} prints a business name in the chrome`).toBeNull();
    }
  });

  it("labels the business context in both locales", () => {
    for (const locale of ["en", "ar"]) {
      const messages = JSON.parse(readFileSync(path.join(ROOT, `messages/${locale}.json`), "utf8")) as {
        Navigation: Record<string, string>;
      };
      expect(messages.Navigation.businessLabel?.trim().length ?? 0).toBeGreaterThan(0);
    }
  });
});

describe("the logo is one lockup, drawn once", () => {
  it("references the brand masters from the Wordmark component and nowhere else", () => {
    /*
     * The owner's second complaint was the logo arriving as disconnected fragments — a symbol in
     * the top bar beside a wordmark in the rail, read as one broken mark. The structural fix is
     * that no screen may reach for an asset file itself: it asks `Wordmark` for a treatment, and
     * the treatments are defined in one place.
     */
    const offenders: string[] = [];
    for (const file of [...walk(path.join(ROOT, "src/app")), ...walk(path.join(ROOT, "src/components"))]) {
      const rel = relative(file);
      if (rel === "src/components/brand/Wordmark.tsx") continue;
      // The manifest and icon metadata legitimately name the rendered PWA icons.
      if (/icons\//.test(readFileSync(file, "utf8")) && /manifest|layout|icon/i.test(rel)) continue;
      if (/["'`]\/brand\//.test(readFileSync(file, "utf8"))) offenders.push(rel);
    }
    expect(offenders, `brand artwork is referenced outside the Wordmark component in: ${offenders.join(", ")}`).toEqual(
      [],
    );
  });

  it("renders no lettered placeholder tile anywhere in the product", () => {
    /*
     * The sign-in page rendered a navy square containing a white "W" — the WalaaPlus letter
     * placeholder — directly above the form, months after the real artwork was approved. A single
     * capital letter styled as a block is the shape this mistake always takes.
     */
    const placeholder = />\s*[A-Z]\s*<\/(span|div|p)>/;
    const offenders: string[] = [];
    for (const file of [...walk(path.join(ROOT, "src/app")), ...walk(path.join(ROOT, "src/components"))]) {
      if (!file.endsWith(".tsx")) continue;
      if (placeholder.test(readFileSync(file, "utf8"))) offenders.push(relative(file));
    }
    expect(offenders, `a lettered placeholder mark survives in: ${offenders.join(", ")}`).toEqual([]);
  });
});

describe("the merchant navigation is one structure in both locales", () => {
  /** The rail, in the order a merchant meets it. Adding a screen means adding it here. */
  const NAV_KEYS = ["dashboard", "programs", "scanner", "customers", "locations", "team"];

  it("names every destination in every locale", () => {
    for (const locale of ["en", "ar"]) {
      const messages = JSON.parse(readFileSync(path.join(ROOT, `messages/${locale}.json`), "utf8")) as {
        Navigation: Record<string, string>;
      };
      for (const key of NAV_KEYS) {
        expect(messages.Navigation[key]?.trim().length ?? 0, `Navigation.${key} is missing in ${locale}`).toBeGreaterThan(
          0,
        );
      }
    }
  });

  it("carries no vocabulary from the old product", () => {
    /*
     * These labels passed every DOM test and were still wrong: the Arabic rail read
     * "السياج الجغرافي (فروعك)" — *geofencing (your branches)* — for a screen that lists counters,
     * because the label was inherited from a feature the product does not have. Looking at the
     * screenshots is what caught it; this keeps it caught.
     */
    const RETIRED = [/geofencing/i, /السياج/, /team management/i, /إدارة فريق العمل/];
    for (const locale of ["en", "ar"]) {
      const messages = JSON.parse(readFileSync(path.join(ROOT, `messages/${locale}.json`), "utf8")) as {
        Navigation: Record<string, string>;
      };
      for (const [key, label] of Object.entries(messages.Navigation)) {
        for (const retired of RETIRED) {
          expect(retired.test(label), `Navigation.${key} in ${locale} still reads "${label}"`).toBe(false);
        }
      }
    }
  });

  it("builds the rail from the message file rather than from literals", () => {
    const sidebar = readFileSync(path.join(ROOT, "src/components/dashboard/Sidebar.tsx"), "utf8");
    for (const key of NAV_KEYS) expect(sidebar).toContain(`"${key}"`);
    // No Arabic anywhere in a component: a translated string inside a component is a string no
    // reviewer of `messages/ar.json` will ever see.
    expect(sidebar, "the rail contains inline Arabic").not.toMatch(/[؀-ۿ]/);
  });
});
