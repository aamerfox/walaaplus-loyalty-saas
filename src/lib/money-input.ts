/**
 * Converting between what a merchant types and what the product stores.
 *
 * Every function here is pure integer STRING work. Not one of them divides, multiplies by a power of
 * ten, or touches `parseFloat` — a threshold that arrives a fraction of a unit away from where the
 * merchant put it is wrong in a way nothing downstream can detect, because the resulting value is
 * perfectly self-consistent. `0.1 + 0.2` is the whole argument.
 *
 * They live outside the component that uses them so they can be tested without React, next-intl or
 * a browser: these are the functions where a money bug would actually hide, and a test that has to
 * render a page to reach them is a test nobody writes enough of.
 *
 * The server does the same conversions again, from the same integers, and the database checks the
 * result a third time. This layer exists to refuse nonsense early and to show the merchant their own
 * number back — never to be the authority on it.
 */

/**
 * Minor units -> the decimal a merchant reads, by inserting a point into the digit string.
 *
 * `("12550", 2)` -> `"125.50"`. `("12550", 0)` -> `"12550"`, because a currency with no minor unit
 * has no decimal point — the exponent is data, not the constant 2.
 */
export function minorToInput(minor: string, exponent: number): string {
  const negative = minor.startsWith("-");
  const digits = (negative ? minor.slice(1) : minor).padStart(exponent + 1, "0");
  const whole = digits.slice(0, digits.length - exponent);
  const fraction = exponent === 0 ? "" : `.${digits.slice(digits.length - exponent)}`;
  return `${negative ? "-" : ""}${whole}${fraction}`;
}

/**
 * A typed decimal -> minor units as an integer string, or `null` when it is not one.
 *
 * Refuses rather than rounds. `"12.999"` in a two-place currency is NOT quietly made `"1300"`: a
 * merchant who typed three places meant something, and choosing between the two readings for them is
 * how a threshold ends up somewhere nobody chose. Negatives are refused outright — there is no such
 * thing as a negative spend threshold, and accepting one would put it below the tier-zero floor.
 */
export function inputToMinor(text: string, exponent: number): string | null {
  const trimmed = text.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) return null;
  const [whole, fraction = ""] = trimmed.split(".");
  if (fraction.length > exponent) return null;
  const digits = `${whole}${fraction.padEnd(exponent, "0")}`;
  const stripped = digits.replace(/^0+(?=\d)/, "");
  return stripped === "" ? "0" : stripped;
}

/** Basis points -> a percentage for display. `750` -> `"7.5"`, `500` -> `"5"`, `10000` -> `"100"`. */
export function basisPointsToPercent(bp: number): string {
  const negative = bp < 0;
  const abs = Math.abs(bp).toString().padStart(3, "0");
  const whole = abs.slice(0, abs.length - 2);
  const fraction = abs.slice(abs.length - 2).replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
}

/**
 * A percentage -> basis points, or `null` when it is not a percentage this product can store.
 *
 * Two decimal places is the resolution of a basis point, so `"7.555"` is refused rather than rounded.
 * Above 100% is refused here as well as by the server and the database: a rate over 100% means
 * giving back more than the customer spent, which is not a promotion this product will write down.
 */
export function percentToBasisPoints(text: string): number | null {
  const trimmed = text.trim();
  if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) return null;
  const [whole, fraction = ""] = trimmed.split(".");
  const bp = Number(`${whole}${fraction.padEnd(2, "0")}`);
  if (!Number.isSafeInteger(bp) || bp > 10_000) return null;
  return bp;
}
