import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Both locales carry the same keys.
 *
 * This product is Arabic-first: Arabic is the default locale and the one a Syrian café actually
 * reads. A key added to `en.json` and forgotten in `ar.json` is not a cosmetic gap — next-intl has
 * nothing to render, so the Arabic screen breaks while the English one looks fine, which is the
 * wrong way round for who is watching.
 *
 * The files are in parity today. Nothing was enforcing it, and every prompt so far has added
 * messages by hand to both files; this is the check that the next one cannot half-finish.
 */

const ROOT = path.resolve(import.meta.dirname, "../..");

/**
 * The locales the app routes to, read from `src/i18n/routing.ts` as TEXT.
 *
 * Importing the module would pull in next-intl's client navigation, which does not resolve in a
 * plain node test environment. Reading the source has a second benefit: it checks that routing and
 * the message files agree, rather than asking routing to describe itself.
 */
function routedLocales(): string[] {
  const source = readFileSync(path.join(ROOT, "src/i18n/routing.ts"), "utf8");
  const list = source.match(/locales:\s*\[([^\]]*)\]/)?.[1] ?? "";
  return [...list.matchAll(/['"]([a-z-]+)['"]/g)].map((m) => m[1]);
}

type Messages = Record<string, unknown>;

function load(locale: string): Messages {
  return JSON.parse(readFileSync(path.join(ROOT, `messages/${locale}.json`), "utf8")) as Messages;
}

/** Every leaf key path, e.g. `Scanner.cameraDenied`. */
function keyPaths(value: unknown, prefix = ""): string[] {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return [prefix];
  return Object.entries(value as Messages).flatMap(([key, nested]) =>
    keyPaths(nested, prefix ? `${prefix}.${key}` : key),
  );
}

function leaf(messages: Messages, keyPath: string): unknown {
  return keyPath.split(".").reduce<unknown>((node, key) => (node as Messages)?.[key], messages);
}

describe("message files", () => {
  const locales = routedLocales();
  const byLocale = new Map(locales.map((locale) => [locale, load(locale)]));
  const keysByLocale = new Map([...byLocale].map(([locale, messages]) => [locale, new Set(keyPaths(messages))]));

  it("covers every locale the app routes to", () => {
    // If a locale is added to routing without a message file, this fails on the read above.
    expect(locales.sort()).toEqual(["ar", "en"]);
  });

  it("has the same keys in every locale", () => {
    const [first, ...rest] = locales;
    const reference = keysByLocale.get(first)!;
    for (const locale of rest) {
      const other = keysByLocale.get(locale)!;
      const missingHere = [...reference].filter((key) => !other.has(key));
      const extraHere = [...other].filter((key) => !reference.has(key));
      expect(missingHere, `missing from ${locale}.json`).toEqual([]);
      expect(extraHere, `missing from ${first}.json`).toEqual([]);
    }
  });

  it("has no empty string anywhere", () => {
    for (const [locale, messages] of byLocale) {
      for (const key of keysByLocale.get(locale)!) {
        const value = leaf(messages, key);
        expect(typeof value, `${locale}.json ${key} must be a string`).toBe("string");
        expect(String(value).trim().length, `${locale}.json ${key} is empty`).toBeGreaterThan(0);
      }
    }
  });

  it("keeps the same interpolation placeholders in both locales", () => {
    // `{count}` renamed in one file and not the other renders the literal braces to a customer.
    const placeholders = (text: string) => (text.match(/\{[a-zA-Z0-9_]+\}/g) ?? []).sort();
    const en = byLocale.get("en")!;
    const ar = byLocale.get("ar")!;
    for (const key of keysByLocale.get("en")!) {
      expect(placeholders(String(leaf(ar, key))), `${key} placeholders differ between locales`).toEqual(
        placeholders(String(leaf(en, key))),
      );
    }
  });

  it("translates the Arabic, apart from the few strings that are identical on purpose", () => {
    /*
     * A string that is byte-identical in both files is usually an untranslated copy. Four here are
     * legitimately identical and are listed so a fifth has to be argued for: a placeholder-only
     * subtitle, two phone placeholders that are digits, and the product name — which is the same
     * word in every locale, because a translated product name is a different product.
     */
    const deliberatelyIdentical = new Set([
      "Brand.productName",
      "Join.subtitle",
      "Join.phonePlaceholder",
      "Scanner.phonePlaceholder",
    ]);
    const en = byLocale.get("en")!;
    const ar = byLocale.get("ar")!;

    const identical = [...keysByLocale.get("en")!].filter((key) => leaf(en, key) === leaf(ar, key));
    expect(identical.sort()).toEqual([...deliberatelyIdentical].sort());
  });
});
