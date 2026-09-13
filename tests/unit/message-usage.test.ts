import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Every key a component asks for exists.
 *
 * `message-parity.test.ts` holds that the two locale files carry the SAME keys. That is necessary
 * and it is not sufficient: a key missing from BOTH files is in parity and still broken. This
 * prompt found one that way — the customer record asked for `Customers.costPoints`, which had never
 * existed in either locale, and next-intl rendered the key name and logged a `MISSING_MESSAGE` that
 * nothing was watching. A merchant would have read `Customers.costPoints` on the screen.
 *
 * So this test reads the components: for each file it finds which message GROUP each translator
 * variable was bound to, then checks every literal key that variable is called with.
 *
 * Deliberately limited to LITERAL keys. A computed key — a template string indexed by an enum —
 * cannot be resolved statically, and those are covered by `message-groups.test.ts`, which asserts
 * that every enum-indexed group holds an entry for every enum value.
 */

const ROOT = path.resolve(import.meta.dirname, "../..");

function walk(dir: string): string[] {
  const entries: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) entries.push(...walk(full));
    else if (/\.tsx?$/.test(name)) entries.push(full);
  }
  return entries;
}

/** `const t = useTranslations("Group")` / `const t = await getTranslations("Group")`. */
const BINDING = /const\s+(\w+)\s*=\s*(?:await\s+)?(?:useTranslations|getTranslations)\(\s*"([^"]+)"\s*\)/g;

function messages(locale: "en" | "ar"): Record<string, Record<string, unknown>> {
  return JSON.parse(readFileSync(path.join(ROOT, `messages/${locale}.json`), "utf8")) as Record<
    string,
    Record<string, unknown>
  >;
}

/** Walk a dotted path into a message group: `field.program` is nested. */
function has(group: Record<string, unknown> | undefined, key: string): boolean {
  let node: unknown = group;
  for (const part of key.split(".")) {
    if (typeof node !== "object" || node === null) return false;
    node = (node as Record<string, unknown>)[part];
  }
  return typeof node === "string";
}

describe("every message a component asks for exists", () => {
  it("resolves every literal key in both locales", () => {
    const en = messages("en");
    const ar = messages("ar");
    const missing: string[] = [];

    const files = [...walk(path.join(ROOT, "src/app")), ...walk(path.join(ROOT, "src/components"))];
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      const groups = new Map<string, string>();
      for (const match of source.matchAll(BINDING)) groups.set(match[1], match[2]);
      if (groups.size === 0) continue;

      const relative = path.relative(ROOT, file).split(path.sep).join("/");
      for (const [variable, group] of groups) {
        // `t("key")` and `t("key", { … })`. Literal keys only: a backtick or a `$` means computed.
        const calls = new RegExp(`\\b${variable}\\(\\s*"([^"\`$]+)"`, "g");
        for (const call of source.matchAll(calls)) {
          const key = call[1];
          const where = `${relative}: ${group}.${key}`;
          if (!has(en[group], key)) missing.push(`${where} (en)`);
          if (!has(ar[group], key)) missing.push(`${where} (ar)`);
        }
      }
    }

    expect(missing, `missing message keys:\n${missing.join("\n")}`).toEqual([]);
  });
});
