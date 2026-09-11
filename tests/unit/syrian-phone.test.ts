import { describe, expect, it } from "vitest";
import { ValidationError } from "@/server/errors";
import { formatSyrianPhone, normalizeSyrianPhone, tryNormalizeSyrianPhone } from "@/server/customers/phone";

/**
 * The phone number is the customer's global identity and `Customer.normalizedPhone` is unique, so
 * every accepted spelling of one number must collapse to exactly one string. If two spellings
 * survive, the same person becomes two customers with two cards and two balances.
 */
describe("Syrian phone normalisation", () => {
  const CANONICAL = "+963944123456";

  it("collapses every ordinary spelling of one number to one canonical value", () => {
    const spellings = [
      "+963944123456",
      "+963 944 123 456",
      "+963-944-123-456",
      "+963 (944) 123 456",
      "00963944123456",
      "00963 944 123 456",
      "963944123456",
      "0944123456",
      "0944 123 456",
      "944123456",
      "  944 123 456  ",
      "944.123.456",
    ];
    for (const spelling of spellings) {
      expect(normalizeSyrianPhone(spelling), spelling).toBe(CANONICAL);
    }
    expect(new Set(spellings.map((s) => normalizeSyrianPhone(s))).size).toBe(1);
  });

  it("accepts Arabic-Indic digits, which is what an Arabic keypad produces", () => {
    expect(normalizeSyrianPhone("٠٩٤٤١٢٣٤٥٦")).toBe(CANONICAL);
    expect(normalizeSyrianPhone("۰۹۴۴۱۲۳۴۵۶")).toBe(CANONICAL);
    expect(normalizeSyrianPhone("+٩٦٣ ٩٤٤ ١٢٣ ٤٥٦")).toBe(CANONICAL);
  });

  it("is idempotent: normalising a canonical number returns it unchanged", () => {
    expect(normalizeSyrianPhone(CANONICAL)).toBe(CANONICAL);
    expect(normalizeSyrianPhone(normalizeSyrianPhone("0944123456"))).toBe(CANONICAL);
  });

  it("keeps different subscribers apart", () => {
    expect(normalizeSyrianPhone("0944123456")).not.toBe(normalizeSyrianPhone("0944123457"));
    expect(normalizeSyrianPhone("0999999999")).toBe("+963999999999");
  });

  describe("refusals", () => {
    it("refuses a foreign number instead of truncating it into a Syrian one", () => {
      // The danger: +971 50 123 4567 silently becoming a Syrian number and merging two people.
      expect(() => normalizeSyrianPhone("+971501234567")).toThrow(/Only Syrian phone numbers/);
      expect(() => normalizeSyrianPhone("0097144123456")).toThrow(/Only Syrian phone numbers/);
      expect(() => normalizeSyrianPhone("+12025550123")).toThrow(/Only Syrian phone numbers/);
    });

    it("refuses Syrian landlines, which cannot receive the card", () => {
      expect(() => normalizeSyrianPhone("0112345678")).toThrow(/mobile/);
      expect(() => normalizeSyrianPhone("+963112345678")).toThrow(/mobile/);
      expect(() => normalizeSyrianPhone("112345678")).toThrow(/mobile/);
    });

    it("refuses lengths that are wrong or ambiguous", () => {
      for (const bad of ["94412345", "9441234567", "09441234567", "096394412345", "12345", "9"]) {
        expect(() => normalizeSyrianPhone(bad), bad).toThrow(ValidationError);
      }
    });

    it("refuses missing, empty and non-numeric input", () => {
      for (const bad of [undefined, null, "", "   ", "abc", "phone", "944-123-45a"]) {
        expect(() => normalizeSyrianPhone(bad as string), String(bad)).toThrow(ValidationError);
      }
    });

    it("refuses a misplaced plus", () => {
      expect(() => normalizeSyrianPhone("963+944123456")).toThrow(/misplaced/);
      expect(() => normalizeSyrianPhone("++963944123456")).toThrow(/misplaced/);
    });

    it("refuses injection-shaped input rather than stripping it into something valid", () => {
      for (const bad of ["944123456; DROP TABLE", "<script>944123456</script>", "944123456' OR '1'='1"]) {
        expect(() => normalizeSyrianPhone(bad), bad).toThrow(ValidationError);
      }
    });
  });

  describe("search-box variant", () => {
    it("returns null instead of throwing, so a half-typed query is simply no match", () => {
      expect(tryNormalizeSyrianPhone("0944")).toBeNull();
      expect(tryNormalizeSyrianPhone("Ahmad")).toBeNull();
      expect(tryNormalizeSyrianPhone("0944123456")).toBe(CANONICAL);
    });
  });

  describe("display formatting", () => {
    it("groups the canonical form for merchant screens, and never for storage", () => {
      expect(formatSyrianPhone(CANONICAL)).toBe("+963 944 123 456");
      // Anything unexpected is shown as-is rather than mangled.
      expect(formatSyrianPhone("+963112345678")).toBe("+963112345678");
    });
  });
});
