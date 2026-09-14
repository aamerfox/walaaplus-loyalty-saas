import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The boundary this phase exists to hold: **nothing leaves the machine**.
 *
 * Phase 3B Prompt 1 builds the internal record a delivery mechanism would one day read, and no
 * delivery mechanism. The difference between those two is easy to lose a month from now, when
 * somebody adds "just a quick webhook" to the module that already has all the events in it — so the
 * absence is asserted by reading the source rather than left to a code review that may not happen.
 *
 * This is the same shape as `campaign-delivery-boundary.test.ts`, and for the same reason.
 */

const ROOT = join(import.meta.dirname, "..", "..");
const INTEGRATIONS = join(ROOT, "src", "server", "integrations");

function sourcesUnder(dir: string): { path: string; text: string }[] {
  const out: { path: string; text: string }[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourcesUnder(full));
    else if (/\.tsx?$/.test(entry.name)) out.push({ path: full, text: readFileSync(full, "utf8") });
  }
  return out;
}

const SOURCES = sourcesUnder(INTEGRATIONS);

/** Comments explain what is deliberately absent, so the scan reads code only. */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/^\s*\/\/\/.*$/gm, "");
}

describe("the integrations module cannot reach the network", () => {
  it("has source files to check", () => {
    // A scan over an empty directory passes vacuously, which is the one way this test could lie.
    expect(SOURCES.length).toBeGreaterThan(0);
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
     * THAT language — the imperative اربط and the word مفتاح (key) for Arabic, rather than a
     * transliteration of the English list, which would check nothing.
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
        forbidden: /اربط|مفتاح|تفويض|ربط حساب/,
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
