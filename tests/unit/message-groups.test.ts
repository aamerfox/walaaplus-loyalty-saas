import { readFileSync } from "node:fs";
import path from "node:path";
import { CampaignChannel, CampaignState, CardType, ConsentCapture, ConsentState, MembershipRole, TemplateStatus } from "@prisma/client";
import { describe, expect, it } from "vitest";

/**
 * Message groups that are looked up by a VALUE rather than by a literal key.
 *
 * `t(\`statuses.${program.status}\`)` is invisible to every other check in this repository: the
 * parity test compares the two locales against each other, so a group missing from both passes; the
 * type checker sees a template string; and the browser suite renders the page, gets next-intl's
 * fallback text where the message should be, and goes green.
 *
 * That is exactly how `Programs.status.ACTIVE` shipped — a label key called `status` shadowing the
 * group the code asked for, discovered only in a server log line during a passing test run. So the
 * enum-backed groups are checked here against the enums themselves: add a `TemplateStatus` value and
 * this fails until both locales can name it.
 */

const ROOT = path.resolve(import.meta.dirname, "../..");
const LOCALES = ["en", "ar"] as const;

type Messages = Record<string, unknown>;

function load(locale: string): Messages {
  return JSON.parse(readFileSync(path.join(ROOT, `messages/${locale}.json`), "utf8")) as Messages;
}

/** Read a dotted path, returning undefined rather than throwing, so the failure is the assertion. */
function at(messages: Messages, dotted: string): unknown {
  return dotted.split(".").reduce<unknown>((node, key) => {
    if (node === null || typeof node !== "object") return undefined;
    return (node as Record<string, unknown>)[key];
  }, messages);
}

/** Every group a component indexes with a runtime value, and the values it will index it with. */
const GROUPS: { path: string; values: readonly string[] }[] = [
  { path: "Programs.cardType", values: Object.values(CardType) },
  { path: "Programs.form.cardTypeHint", values: Object.values(CardType) },
  { path: "Dashboard.cardType", values: Object.values(CardType) },
  { path: "Scanner.cardType", values: Object.values(CardType) },
  // Added in Phase 2 with the customer record, which badges each card with its type. It was
  // missing from both locales when the screen shipped, and the screenshot showed the key name.
  { path: "Customers.cardType", values: Object.values(CardType) },
  { path: "Segments.cardType", values: Object.values(CardType) },
  // Phase 2 Prompt 2. Every enum the consent and campaign screens index a message group by.
  { path: "Consent.state", values: Object.values(ConsentState) },
  { path: "Consent.capture", values: Object.values(ConsentCapture) },
  { path: "Campaigns.state", values: Object.values(CampaignState) },
  { path: "Campaigns.channel", values: Object.values(CampaignChannel) },
  { path: "Programs.statuses", values: Object.values(TemplateStatus) },
  { path: "Staff.roles", values: Object.values(MembershipRole) },
  { path: "Programs.form.earnMode", values: ["MANUAL", "PER_VISIT", "SPEND_BLOCK"] },
  { path: "Programs.earn", values: ["manual", "perVisit", "spendBlock"] },
];

describe("message groups indexed by a runtime value", () => {
  for (const locale of LOCALES) {
    describe(locale, () => {
      const messages = load(locale);

      for (const group of GROUPS) {
        it(`${group.path} names every value`, () => {
          const node = at(messages, group.path);
          expect(node, `${group.path} is missing or is not a group`).toBeTypeOf("object");

          for (const value of group.values) {
            const message = at(messages, `${group.path}.${value}`);
            expect(message, `${group.path}.${value} is missing in ${locale}`).toBeTypeOf("string");
            expect(String(message).trim().length, `${group.path}.${value} is blank in ${locale}`).toBeGreaterThan(0);
          }
        });
      }
    });
  }
});
