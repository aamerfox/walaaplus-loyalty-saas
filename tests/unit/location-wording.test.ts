import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * A branch is a branch. A cashier is a person.
 *
 * The owner's staging review found the Arabic Locations screen calling a branch **كاشير** — the same
 * word the Team screen uses for the cashier ROLE. "إضافة كاشير" appeared on both pages, one adding a
 * place and one adding an employee, and nothing on either screen told them apart.
 *
 * That is not a typo to fix once. It is the kind of wording that comes back the next time somebody
 * writes a message in a hurry, so the rule is enforced here:
 *
 *  - every message key that names the `Location` domain entity says **فرع** / **branch**;
 *  - the `MembershipRole.CASHIER` employee keeps **كاشير** / **cashier**, and this test asserts that
 *    too — a correction that quietly renamed the job would be its own defect;
 *  - customer-facing copy telling a customer to show their QR to the cashier is about the PERSON and
 *    is deliberately left alone.
 */

const ROOT = path.resolve(import.meta.dirname, "../..");

/** Arabic for "cashier". The word the Location entity must never use. */
const CASHIER_AR = /كاشير/;
/**
 * Arabic for "branch", singular and plural.
 *
 * The plural is `فروع` — a `و` appears between the second and third letters — so a naive
 * search for the singular misses every sentence that talks about more than one.
 */
const BRANCH_AR = /فرو?ع/;

type Messages = Record<string, Record<string, string | Record<string, string>>>;

function messages(locale: "en" | "ar"): Messages {
  return JSON.parse(readFileSync(path.join(ROOT, `messages/${locale}.json`), "utf8")) as Messages;
}

function text(group: Record<string, string | Record<string, string>>, key: string): string {
  const value = group[key];
  expect(typeof value, `${key} should be a string`).toBe("string");
  return value as string;
}

/**
 * Every message that names the Location entity.
 *
 * Written out rather than pattern-matched: a rule that guessed which keys are "about locations"
 * would either miss the next one or fire on the cashier role, and both failures are silent.
 */
const LOCATION_KEYS: Record<string, string[]> = {
  Locations: [
    "title",
    "subtitle",
    "addTitle",
    "addSubtitle",
    "nameLabel",
    "create",
    "created",
    "creating",
    "deactivate",
    "reactivate",
    "confirmDeactivate",
    "inactiveNote",
    "lifecycleNote",
    "errorIsMain",
    "errorLastActive",
    "errorNameTaken",
    "errorStrandsProgram",
    "mainOnlyPrograms",
    "forbidden",
    "programsHere",
    "staffHere",
    "main",
  ],
  Versions: ["whereItRuns", "whereItRunsHint"],
  Scanner: ["noUsableCounter", "locationLabel", "locationChoose", "locationRequired"],
  Programs: ["locations", "mainOnly"],
  Navigation: ["locations"],
};

describe("the Location entity is never called a cashier", () => {
  it("uses no cashier word in any location message, in either locale", () => {
    const offenders: string[] = [];
    for (const locale of ["en", "ar"] as const) {
      const m = messages(locale);
      for (const [group, keys] of Object.entries(LOCATION_KEYS)) {
        for (const key of keys) {
          const value = text(m[group], key);
          if (CASHIER_AR.test(value) || /\bcashier/i.test(value)) offenders.push(`${locale}:${group}.${key} = ${value}`);
        }
      }
    }
    expect(offenders, `location copy still names a cashier:\n${offenders.join("\n")}`).toEqual([]);
  });

  it("says branch, in Arabic, wherever the entity is named in a sentence", () => {
    const ar = messages("ar");
    // The keys that are whole sentences about the entity. A label like "Main" is a single word and
    // carries the noun in the sentence around it, so it is not required to repeat it.
    for (const key of [
      "subtitle",
      "addTitle",
      "addSubtitle",
      "nameLabel",
      "create",
      "created",
      "deactivate",
      "lifecycleNote",
      "errorIsMain",
      "errorLastActive",
      "errorNameTaken",
      "errorStrandsProgram",
    ]) {
      expect(BRANCH_AR.test(text(ar.Locations, key)), `Locations.${key} should name a فرع`).toBe(true);
    }
    expect(BRANCH_AR.test(text(ar.Versions, "whereItRuns"))).toBe(true);
    expect(BRANCH_AR.test(text(ar.Scanner, "noUsableCounter"))).toBe(true);
  });

  it("leaves the cashier ROLE called a cashier", () => {
    // The other half of the rule. A correction that renamed the job would be its own defect: a
    // merchant hires a كاشير, and the Team screen is where they add one.
    const ar = messages("ar");
    const en = messages("en");
    expect(CASHIER_AR.test(text(ar.Staff, "createTitle"))).toBe(true);
    expect(/cashier/i.test(text(en.Staff, "createTitle"))).toBe(true);
    // And the customer's own card still tells them to show the QR to the person at the till.
    expect(CASHIER_AR.test(text(ar.Card, "showQr"))).toBe(true);
  });
});
