import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The boundary this phase exists to hold: **the event record does not leave the machine.**
 *
 * Prompt 1 built the internal record a delivery mechanism would one day read, and no delivery
 * mechanism. **Prompt 2 built the delivery mechanism** — so this test was narrowed, deliberately and
 * visibly, rather than deleted or quietly weakened.
 *
 * What it covers now: `src/server/integrations/*.ts`, the top level, which is `events.ts`. That
 * module writes an event and an outbox row and must never acquire a way to send one, because the
 * transaction it runs in belongs to a cashier's till.
 *
 * What covers the rest: `tests/unit/webhook-boundary.test.ts`, which asserts that exactly one module
 * under `src/server` holds an HTTP client, that it is the webhook transport, and that nothing under
 * `src/app/` imports it or the runner that calls it.
 *
 * Narrowing a scan is how a guarantee gets lost, so the narrowing is stated here and the replacement
 * is named. This is the same shape as `campaign-delivery-boundary.test.ts`, and for the same reason.
 */

const ROOT = join(import.meta.dirname, "..", "..");
const INTEGRATIONS = join(ROOT, "src", "server", "integrations");

/**
 * The TOP LEVEL of the integrations directory only — not its subdirectories.
 *
 * `webhooks/` is deliberately excluded: it is where Prompt 2 put the one HTTP client this product
 * has, and `webhook-boundary.test.ts` is what governs it. Recursing here would either fail or,
 * worse, be softened until it asserted nothing.
 */
function topLevelSources(dir: string): { path: string; text: string }[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && /\.tsx?$/.test(e.name))
    .map((e) => ({ path: join(dir, e.name), text: readFileSync(join(dir, e.name), "utf8") }));
}

const SOURCES = topLevelSources(INTEGRATIONS);

/** Comments explain what is deliberately absent, so the scan reads code only. */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/^\s*\/\/\/.*$/gm, "");
}

describe("the integrations module cannot reach the network", () => {
  it("has source files to check", () => {
    // A scan over an empty directory passes vacuously, which is the one way this test could lie.
    expect(SOURCES.length).toBeGreaterThan(0);
  });

  it("covers events.ts, which is the module this rule is about", () => {
    // Named explicitly, so a rename cannot quietly take the file out of the scan.
    expect(SOURCES.map((s) => s.path.replace(/\\/g, "/")).some((p) => p.endsWith("/events.ts"))).toBe(true);
  });

  it("contains no HTTP client, queue, worker or timer", () => {
    const FORBIDDEN: [RegExp, string][] = [
      [/\bfetch\s*\(/, "fetch"],
      [/\baxios\b/, "axios"],
      [/\bgot\b\s*\(/, "got"],
      [/node:https?\b/, "node http"],
      [/\bXMLHttpRequest\b/, "XMLHttpRequest"],
      [/\bWebSocket\b/, "WebSocket"],
      [/\bpg-boss\b|\bboss\.send\b/, "a queue"],
      [/\bsetTimeout\s*\(|\bsetInterval\s*\(/, "a timer"],
      [/\bnavigator\.sendBeacon\b/, "sendBeacon"],
    ];
    for (const { path, text } of SOURCES) {
      const body = code(text);
      for (const [pattern, what] of FORBIDDEN) {
        expect(body, `${path} reaches for ${what}`).not.toMatch(pattern);
      }
    }
  });

  it("imports no provider SDK", () => {
    const PROVIDERS =
      /twilio|sendgrid|mailgun|resend|nodemailer|stripe|paypal|@meta|facebook|whatsapp|telegram|googleapis|firstpromoter|leadconnector|gohighlevel/i;
    for (const { path, text } of SOURCES) {
      const imports = [...code(text).matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]);
      for (const specifier of imports) {
        expect(specifier, `${path} imports a provider SDK`).not.toMatch(PROVIDERS);
      }
    }
  });

  it("holds no endpoint, credential or secret", () => {
    const SECRETS: [RegExp, string][] = [
      [/https?:\/\//, "a URL"],
      [/\bapiKey\b|\bapi_key\b/i, "an API key"],
      [/\bwebhookUrl\b|\bendpointUrl\b|\bcallbackUrl\b/i, "an endpoint"],
      [/\baccessToken\b|\brefreshToken\b|\bbearer\b/i, "a token"],
      [/\bsmtp\b/i, "SMTP settings"],
      [/\bencrypt(ion)?Key\b|\bmasterKey\b/i, "an encryption key"],
      [/process\.env\b/, "an environment variable"],
      [/\bhmac\b|createHmac/i, "a request signature"],
    ];
    for (const { path, text } of SOURCES) {
      const body = code(text);
      for (const [pattern, what] of SECRETS) {
        expect(body, `${path} carries ${what}`).not.toMatch(pattern);
      }
    }
  });

  it("has no free-form JSON column to hide a contact detail in", () => {
    /*
     * The envelope is typed columns and nothing else, and that is the design rather than an
     * oversight. A JSON bag does not leak a phone number through malice; it leaks one because
     * somebody debugging a delivery failure adds "just the recipient, temporarily".
     */
    const schema = readFileSync(join(ROOT, "prisma", "schema.prisma"), "utf8");
    const model = schema.slice(schema.indexOf("model IntegrationEvent {"));
    const body = model.slice(0, model.indexOf("\n}"));
    expect(body).not.toMatch(/\bJson\b/);
    expect(body).not.toMatch(/metadata|payload|config|settings|data\s+/i);
  });
});

describe("the capability audit names every family, and promises none of them", () => {
  const MATRIX = readFileSync(join(ROOT, "docs", "INTEGRATIONS-CAPABILITY-MATRIX.md"), "utf8");

  it("accounts for every integration family identified in the reference", () => {
    // If a family is not in the matrix, nobody has decided what it would need — which is the exact
    // gap that lets a provider name reach a screen without anyone noticing.
    const FAMILIES = [
      "Custom SMTP",
      "SendGrid",
      "Mailgun",
      "Resend",
      "Twilio",
      "WhatsApp",
      "Facebook Messenger",
      "Telegram Bot",
      "Telegram Report Bot",
      "Google Business API",
      "Google Tag Manager",
      "Meta Ads",
      "Stripe",
      "PayPal",
      "FirstPromoter",
      "LeadConnector",
      "POS systems",
      "webhook",
    ];
    for (const family of FAMILIES) {
      expect(MATRIX, `${family} is not classified in the matrix`).toContain(family);
    }
  });

  it("says plainly that a provider name is not an integration", () => {
    expect(MATRIX).toMatch(/not an integration/i);
    // Prompt 2 added the webhook security record; a matrix without it is out of date with the code.
    expect(MATRIX).toMatch(/## 7a\. Webhook security and decision record/);
    // The matrix's own words: "This phase has **none** of those, and the product must not imply otherwise."
    expect(MATRIX).toMatch(/none\*\* of those, and the product must not imply otherwise/i);
  });

  it("records where a secret would have to live as a decision, not a column", () => {
    expect(MATRIX).toMatch(/D27/);
    expect(MATRIX).toMatch(/no secrets table/i);
  });
});

describe("no screen claims a provider is connected", () => {
  const LOCALES = ["en", "ar"] as const;

  it("says the opposite, in both languages", () => {
    for (const locale of LOCALES) {
      const messages = JSON.parse(readFileSync(join(ROOT, "messages", `${locale}.json`), "utf8")) as Record<
        string,
        Record<string, string>
      >;
      const block = messages.Integrations;
      expect(block, `${locale} has no Integrations block`).toBeTruthy();
      // The one string that has to exist: a denial the reader cannot miss.
      expect(block.nothingConnected.length, locale).toBeGreaterThan(40);
    }
  });

  it("offers no connect, authorize or disconnect wording, in either language", () => {
    /*
     * A button labelled "Connect" is the shortest path from "we have an events table" to "we
     * integrate with Stripe". Each locale is checked against the verbs that would make the claim in
     * THAT language, rather than a transliteration of the English list, which would check nothing.
     *
     * **The Arabic pattern was narrowed in Prompt 2, and the reason is worth stating.** It used to
     * forbid مفتاح (key) outright, as a proxy for "API key". The block now legitimately contains
     * مفتاح التوقيع — the owner's OWN signing secret for their OWN webhook — and مفتاح التشفير,
     * which appears in a sentence saying the feature is NOT configured. Neither is a claim that a
     * provider is attached, which is the thing being guarded against, so the pattern now names the
     * claim itself: مفتاح API, ربط حساب, اربط, تفويض.
     *
     * `nothingConnected` is exempt in both, because it exists to DENY a connection and so
     * necessarily contains the word. The second assertion keeps that exemption from quietly
     * covering a string that stopped being a denial.
     */
    const CLAIMS: Record<string, { forbidden: RegExp; denial: RegExp }> = {
      en: {
        forbidden: /\bconnect\b|\bauthorize\b|\bdisconnect\b|\blink your\b|\bapi key\b/i,
        denial: /no provider is connected/i,
      },
      ar: {
        forbidden: /اربط|مفتاح API|تفويض|ربط حساب/,
        denial: /لا يوجد مزو/,
      },
    };

    for (const [locale, { forbidden, denial }] of Object.entries(CLAIMS)) {
      const messages = JSON.parse(readFileSync(join(ROOT, "messages", `${locale}.json`), "utf8")) as Record<
        string,
        Record<string, string>
      >;
      const block = messages.Integrations;
      const values = Object.entries(block)
        .filter(([key]) => key !== "nothingConnected")
        .map(([, value]) => value)
        .join(" ");
      expect(values, locale).not.toMatch(forbidden);
      expect(block.nothingConnected, `${locale} denial`).toMatch(denial);
    }
  });
});
