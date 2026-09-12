import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The registration page must be wired to the registration API.
 *
 * This is the cheap guard for a defect that cost a real staging test: the page was prototype
 * markup that looked finished and did nothing. Uncontrolled inputs, no submit handler, and a
 * "Create Account" **link to `/business`** — so a merchant filled it in, arrived at the dashboard,
 * and had no account. The service and its route were tested and working the whole time; nothing
 * connected them.
 *
 * A form that navigates on submit is worse than no form, because it reports success. The browser
 * test in `tests/e2e/owner-registration.spec.ts` is the proof that it now registers; this file
 * catches the specific regressions that would bring the prototype back, in milliseconds.
 */

const ROOT = path.resolve(import.meta.dirname, "../..");
const PAGE = path.join(ROOT, "src/app/[locale]/auth/register/page.tsx");
const source = readFileSync(PAGE, "utf8");

/**
 * The file with its comments removed.
 *
 * Some assertions below are about what the CODE does and would otherwise fail on the page's own
 * prose: it explains why the Agency option was removed, which means writing the word, and why the
 * accepted response says nothing about an existing account, which means writing that too. A test
 * that reads comments fails on an explanation.
 */
const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("the registration page", () => {
  it("posts to the registration API", () => {
    expect(source).toContain('fetch("/api/auth/register"');
    expect(source).toContain('method: "POST"');
  });

  it("sends every field the service needs, including the Syria-first defaults", () => {
    for (const field of ["firstName", "lastName", "businessName", "email", "password", "locale"]) {
      expect(source, `the body must carry ${field}`).toContain(field);
    }
    expect(source).toContain('"SYP"');
    expect(source).toContain('"Asia/Damascus"');
  });

  it("submits with a button, and offers no link into the dashboard", () => {
    // The exact shape of the original defect: an anchor styled as a submit control.
    expect(source).toContain('type="submit"');
    expect(source).not.toMatch(/href=["{]\s*"?\/business/);
    expect(source).not.toContain('href="/business"');
  });

  it("never logs anything", () => {
    // An email and a password in a browser console outlive the tab they were typed in.
    expect(source).not.toMatch(/console\s*\./);
  });

  it("no longer offers an account type the product does not support", () => {
    // The prototype's Agency option. Removed rather than disabled: a greyed-out control is still
    // a promise.
    expect(code).not.toContain("account_type");
    expect(code.toLowerCase()).not.toContain("agency");
  });

  it("takes every visible string from the message files", () => {
    // The prototype wrote both languages inline as ternaries. If any Arabic survives in this
    // file, some string is not translatable and the two languages will drift.
    const arabic = source.match(/[؀-ۿ]/g) ?? [];
    expect(arabic, "Arabic text belongs in messages/ar.json").toEqual([]);
    expect(source).toContain('useTranslations("Register")');
  });

  it("attempts a sign-in after the API accepts, rather than assuming one", () => {
    expect(source).toContain('signIn("credentials"');
    expect(source).toContain("redirect: false");
    // And lands the new owner on the first thing they need.
    expect(source).toContain("/business/program");
  });

  it("treats the accepted response as saying nothing about the account", () => {
    // The API answers a duplicate and a new account identically. The page must not branch on
    // anything in that body — only on whether the sign-in worked.
    const acceptedBranch = code.slice(code.indexOf("if (response.status === 429)"));
    expect(acceptedBranch).not.toMatch(/response\.json\(\)/);
    expect(acceptedBranch).not.toMatch(/exist|duplicate|taken|already/i);
  });
});
