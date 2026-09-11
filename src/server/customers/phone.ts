import { ValidationError } from "../errors";

/**
 * Syrian phone numbers, normalised to one canonical form.
 *
 * The phone number IS the customer's global identity (PRODUCT-SPEC §2.8), and
 * `Customer.normalizedPhone` is unique. So every accepted spelling of one number must collapse to
 * exactly one string, or the same person becomes two customers with two cards and two balances,
 * and no amount of later repair puts that back together.
 *
 * Accepted, all meaning the same subscriber:
 *
 *   +963 944 123 456      international, the canonical form
 *   00963944123456        international prefix
 *   963944123456          country code, no plus
 *   0944123456            local, trunk prefix
 *   944123456             national significant number
 *
 * plus any spacing, dashes, dots, parentheses or non-breaking spaces between the digits, and
 * Arabic-Indic digits, which is what a phone keypad on an Arabic device produces.
 *
 * Everything else is REFUSED rather than guessed. In particular:
 *
 *  - **Landlines are refused.** Syrian fixed lines are valid numbers, but the product delivers
 *    the card, and later its restore link, over mobile messaging. Accepting a landline creates an
 *    identity that cannot receive the thing it identifies. Recorded as a Phase 1a limitation.
 *  - **Foreign numbers are refused**, with a distinct message, because silently truncating
 *    +9715… into a Syrian-looking number would merge two different people.
 *  - Lengths that could be read two ways are refused instead of being resolved by preference.
 */

/** Syria. */
export const SYRIA_COUNTRY_CODE = "963";
/** National significant number: mobile prefix 9, then 8 digits. */
const SYRIAN_MOBILE_NSN = /^9\d{8}$/;
const NSN_LENGTH = 9;

/** Digits only, after separators and Arabic-Indic digits are folded. */
function toAsciiDigits(raw: string): { digits: string; hadPlus: boolean } {
  let out = "";
  let hadPlus = false;
  for (const ch of raw.trim()) {
    const code = ch.codePointAt(0)!;
    if (ch === "+") {
      // A plus is only meaningful as the very first meaningful character.
      if (out.length > 0 || hadPlus) throw new ValidationError("Phone number contains a misplaced '+'");
      hadPlus = true;
      continue;
    }
    if (ch >= "0" && ch <= "9") {
      out += ch;
      continue;
    }
    // Arabic-Indic ٠-٩ and Eastern Arabic-Indic ۰-۹, as produced by Arabic keyboards.
    if (code >= 0x0660 && code <= 0x0669) {
      out += String(code - 0x0660);
      continue;
    }
    if (code >= 0x06f0 && code <= 0x06f9) {
      out += String(code - 0x06f0);
      continue;
    }
    // Separators people actually type. Anything else is a typo, not formatting.
    if (" \t-.() ‏‎/".includes(ch)) continue;
    throw new ValidationError("Phone number contains unexpected characters");
  }
  return { digits: out, hadPlus };
}

/**
 * Normalise a Syrian phone number to canonical E.164, e.g. `+963944123456`.
 * Throws ValidationError, with a reason a merchant can act on, for anything else.
 */
export function normalizeSyrianPhone(raw: string | null | undefined): string {
  if (typeof raw !== "string" || raw.trim() === "") throw new ValidationError("Phone number is required");

  const { digits, hadPlus } = toAsciiDigits(raw);
  if (digits.length === 0) throw new ValidationError("Phone number contains no digits");

  let nsn: string;
  if (hadPlus || digits.startsWith("00")) {
    // Explicitly international: the country code must be ours.
    const international = digits.startsWith("00") ? digits.slice(2) : digits;
    if (!international.startsWith(SYRIA_COUNTRY_CODE)) {
      throw new ValidationError("Only Syrian phone numbers (+963) are accepted");
    }
    nsn = international.slice(SYRIA_COUNTRY_CODE.length);
  } else if (digits.length === NSN_LENGTH) {
    // 9 digits can only be a national significant number: 963 + 6 digits is far too short.
    nsn = digits;
  } else if (digits.length === NSN_LENGTH + 1 && digits.startsWith("0")) {
    // Local form with the trunk prefix.
    nsn = digits.slice(1);
  } else if (digits.length === SYRIA_COUNTRY_CODE.length + NSN_LENGTH && digits.startsWith(SYRIA_COUNTRY_CODE)) {
    // Country code without a plus.
    nsn = digits.slice(SYRIA_COUNTRY_CODE.length);
  } else {
    throw new ValidationError("Phone number is not a recognised Syrian number");
  }

  if (nsn.length !== NSN_LENGTH) throw new ValidationError("Syrian phone numbers have 9 digits after the country code");
  if (!SYRIAN_MOBILE_NSN.test(nsn)) {
    throw new ValidationError("Only Syrian mobile numbers are accepted; they start with 9 after the country code");
  }
  return `+${SYRIA_COUNTRY_CODE}${nsn}`;
}

/** Non-throwing variant for search boxes, where an unparseable query is simply no match. */
export function tryNormalizeSyrianPhone(raw: string | null | undefined): string | null {
  try {
    return normalizeSyrianPhone(raw);
  } catch {
    return null;
  }
}

/**
 * A display form for merchant screens: `+963 944 123 456`.
 * Never used for storage, comparison or lookup — only the canonical form is.
 */
export function formatSyrianPhone(canonical: string): string {
  const m = /^\+963(9\d{2})(\d{3})(\d{3})$/.exec(canonical);
  return m ? `+963 ${m[1]} ${m[2]} ${m[3]}` : canonical;
}
