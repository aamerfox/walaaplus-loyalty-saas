import { describe, expect, it } from "vitest";
import {
  assertPlaceholdersValid,
  PLACEHOLDER_NAMES,
  renderWithSamples,
  scanPlaceholders,
  WITHHELD_PLACEHOLDERS,
} from "@/server/campaigns/placeholders";

/**
 * What a draft may promise to fill in, and what it may not.
 *
 * A placeholder is an undertaking: whatever is between the braces, the product commits to
 * substituting it correctly for every recipient. So the validation half of this file is the
 * security half — there is no expression language, no property path and no fallback syntax, and
 * this is where that stays true.
 *
 * The withheld half is the honesty half. `{{programName}}` is not missing because nobody got to it;
 * it is refused because a customer may hold several cards and the product will not guess which one
 * a merchant meant.
 */

describe("only two placeholders exist, and both are unambiguous", () => {
  it("accepts them, in either order, with or without spaces", () => {
    const scan = scanPlaceholders("Hi {{firstName}}, from {{ businessName }}. See you at {{firstName}}'s usual time.");
    expect(scan.problems).toEqual([]);
    expect(scan.used.sort()).toEqual(["businessName", "firstName"]);
  });

  it("offers nothing that depends on which card a customer holds", () => {
    // The list is short on purpose. If it grows, it grows with a contract that makes the new value
    // unambiguous — and this test is where somebody has to think about that.
    expect(PLACEHOLDER_NAMES.sort()).toEqual(["businessName", "firstName"]);
    for (const withheld of ["programName", "stampBalance", "pointBalance", "rewardName"]) {
      expect(WITHHELD_PLACEHOLDERS[withheld]).toBe("AMBIGUOUS_ACROSS_CARDS");
    }
  });
});

describe("anything that is not exactly a known placeholder is refused", () => {
  it("names an unknown one rather than ignoring it", () => {
    const scan = scanPlaceholders("Hello {{nickname}}");
    expect(scan.problems).toEqual([{ token: "nickname", reason: "UNKNOWN" }]);
    expect(scan.used).toEqual([]);
  });

  it("explains a withheld one instead of pretending it does not exist", () => {
    const scan = scanPlaceholders("You have stamps on {{programName}}");
    expect(scan.problems).toEqual([{ token: "programName", reason: "WITHHELD" }]);
  });

  it("refuses every shape of expression, path and fallback", () => {
    /*
     * The important half. A validator that only looked for KNOWN names would see no match in any of
     * these and call the text placeholder-free — which is how a template language gets in front of
     * customer data. Every `{{ … }}` in a body must be a well-formed placeholder.
     */
    for (const text of [
      'Hi {{firstName || "friend"}}',
      "Hi {{customer.firstName}}",
      "Hi {{ 1 + 1 }}",
      "Hi {{firstName|upper}}",
      "Hi {{#each customers}}",
      "Hi {{}}",
      "Hi {{ }}",
      "Hi {{first-name}}",
      "Hi {{first name}}",
    ]) {
      const scan = scanPlaceholders(text);
      expect(scan.problems.length, `${text} must be refused`).toBeGreaterThan(0);
      expect(scan.problems.every((p) => p.reason === "MALFORMED" || p.reason === "UNKNOWN")).toBe(true);
    }
  });

  it("throws from the assertion, naming the field and every problem", () => {
    expect(() => assertPlaceholdersValid("Hi {{nickname}} and {{programName}}", "body")).toThrow(/Unsupported placeholder in body/);
    // A clean body throws nothing and reports what it used.
    expect(assertPlaceholdersValid("Hi {{firstName}}", "body")).toEqual(["firstName"]);
  });
});

describe("a preview is drawn from constants", () => {
  it("substitutes sample values in both locales, and leaves unknown text alone", () => {
    expect(renderWithSamples("Hi {{firstName}} from {{businessName}}", "en")).toBe("Hi Layla from Your business");
    expect(renderWithSamples("{{firstName}}", "ar")).toBe("ليلى");
    // An unknown placeholder is never silently blanked: a merchant sees what they typed, and the
    // save refuses it. Blanking it would hide the mistake behind a plausible-looking preview.
    expect(renderWithSamples("Hi {{nickname}}", "en")).toBe("Hi {{nickname}}");
  });
});
