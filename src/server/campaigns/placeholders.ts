import { ValidationError } from "../errors";

/**
 * The only things a campaign draft may say about a customer.
 *
 * ## An allowlist, and a very short one
 *
 * A placeholder is a promise: whatever the merchant types between the braces, the product is
 * undertaking to fill in correctly for every recipient, later, from data it holds. So the list is
 * not "what would be nice" — it is "what this product can answer for **every** customer a segment
 * might match, without guessing".
 *
 * | Placeholder | Filled from | Why it is safe |
 * |---|---|---|
 * | `{{firstName}}` | `CustomerBusinessProfile.firstName` | One value per customer per business. May be absent, and the fallback is documented below |
 * | `{{businessName}}` | `Business.name` | One value, the same for everybody |
 *
 * That is the whole list. It will grow when a contract exists that makes another value
 * unambiguous — and not before.
 *
 * ## What is deliberately NOT available, and why
 *
 * **`{{programName}}`, `{{stampBalance}}`, `{{rewardName}}`, `{{pointBalance}}`.** All four are
 * facts about a CARD, and a customer may hold several: a café running a stamp card and a points
 * card has customers with two of each. "Which one?" has no answer the product can give, and the
 * available answers are all wrong in a way nobody would notice until a customer received a message
 * about a programme they are not in. Offering one and quietly picking the oldest card is the worst
 * of the options, because it would be right most of the time.
 *
 * They become available when a campaign can be scoped to a programme — which is a contract about
 * audiences, not about text, and belongs with the phase that builds delivery.
 *
 * **Anything with an expression in it.** `{{firstName || "friend"}}`, `{{a.b}}`, `{{ 1+1 }}`,
 * nested braces. The grammar below matches a bare identifier and nothing else, so there is no
 * expression language to evaluate, no property path to walk and no place for one to be added by
 * accident. A template language in a message body is a template language in front of customer data.
 *
 * ## An absent value is not an empty string
 *
 * `firstName` is optional on a profile — a customer enrolled at a busy counter may have none. A
 * message rendering "Hi ," is worse than one that does not use the name, so a draft that uses
 * `{{firstName}}` is flagged in the preview, and how an absent value is handled at delivery is a
 * decision recorded for the delivery phase rather than guessed here. **Nothing renders to a real
 * customer in this build**, so the question is documented rather than answered.
 */

/** The placeholders a draft may use, and the sample value each shows in a preview. */
export const PLACEHOLDERS = {
  firstName: { sample: { en: "Layla", ar: "ليلى" } },
  businessName: { sample: { en: "Your business", ar: "نشاطك التجاري" } },
} as const;

export type PlaceholderName = keyof typeof PLACEHOLDERS;

export const PLACEHOLDER_NAMES = Object.keys(PLACEHOLDERS) as PlaceholderName[];

/**
 * Placeholders that exist in the domain and are deliberately withheld, with the reason.
 *
 * Listed rather than merely absent: a merchant who types `{{programName}}` gets told WHY it is not
 * available, which is the difference between a product with a boundary and a product with a bug.
 */
export const WITHHELD_PLACEHOLDERS: Record<string, "AMBIGUOUS_ACROSS_CARDS"> = {
  programName: "AMBIGUOUS_ACROSS_CARDS",
  stampBalance: "AMBIGUOUS_ACROSS_CARDS",
  pointBalance: "AMBIGUOUS_ACROSS_CARDS",
  rewardName: "AMBIGUOUS_ACROSS_CARDS",
};

/**
 * A placeholder, and nothing else.
 *
 * `{{` then optional spaces, then a bare ASCII identifier, then optional spaces, then `}}`. No
 * dots, no pipes, no brackets, no operators, no nesting. Anything that is not exactly this is not a
 * placeholder — which is what makes "reject unknown placeholders" a decidable question.
 */
const PLACEHOLDER = /\{\{\s*([A-Za-z][A-Za-z0-9]*)\s*\}\}/g;

/**
 * Anything that opens a brace pair at all.
 *
 * Matched separately and deliberately: a body containing `{{firstName || "x"}}` produces no match
 * from `PLACEHOLDER`, and a validator that only looked for known names would call that text
 * "placeholder-free" and accept it. Every `{{` in the body must be a well-formed placeholder.
 */
const ANY_BRACES = /\{\{[^}]*\}\}/g;

export interface PlaceholderProblem {
  /** What was written, trimmed of the braces. Echoed back so a merchant can see their own typo. */
  token: string;
  reason: "UNKNOWN" | "WITHHELD" | "MALFORMED";
}

export interface PlaceholderScan {
  used: PlaceholderName[];
  problems: PlaceholderProblem[];
}

/** Every placeholder in a piece of text, and every thing that tried to be one and failed. */
export function scanPlaceholders(text: string): PlaceholderScan {
  const used = new Set<PlaceholderName>();
  const problems: PlaceholderProblem[] = [];

  const wellFormed = new Set<string>();
  for (const match of text.matchAll(PLACEHOLDER)) {
    wellFormed.add(match[0]);
    const name = match[1];
    if ((PLACEHOLDER_NAMES as string[]).includes(name)) used.add(name as PlaceholderName);
    else if (name in WITHHELD_PLACEHOLDERS) problems.push({ token: name, reason: "WITHHELD" });
    else problems.push({ token: name, reason: "UNKNOWN" });
  }

  for (const match of text.matchAll(ANY_BRACES)) {
    // Anything brace-wrapped that the strict grammar did not accept. An expression, a path, a pipe.
    if (!wellFormed.has(match[0])) {
      problems.push({ token: match[0].slice(2, -2).trim().slice(0, 40), reason: "MALFORMED" });
    }
  }

  return { used: [...used], problems };
}

/** Throw unless every placeholder in `text` is one this product can honour. */
export function assertPlaceholdersValid(text: string, field: string): PlaceholderName[] {
  const scan = scanPlaceholders(text);
  if (scan.problems.length > 0) {
    throw new ValidationError(
      `Unsupported placeholder in ${field}`,
      scan.problems.map((problem) => ({ field, token: problem.token, reason: problem.reason })),
    );
  }
  return scan.used;
}

/**
 * Fill a draft with SAMPLE values, for a preview.
 *
 * The samples are constants in this file. No customer is read, no query runs, and nothing about a
 * real person reaches a preview — which is also why the preview can be rendered while somebody is
 * still typing without touching the database at all.
 */
export function renderWithSamples(text: string, locale: "en" | "ar"): string {
  return text.replace(PLACEHOLDER, (whole, name: string) => {
    const placeholder = PLACEHOLDERS[name as PlaceholderName];
    return placeholder ? placeholder.sample[locale] : whole;
  });
}
