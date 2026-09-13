import { describe, expect, it } from "vitest";
import { originStatus } from "@/server/consent/consent";

/**
 * The one rule this whole feature turns on: **a gap is not a permission.**
 *
 * The product's enrolment record carries three fields, and there is a real combination in the
 * database where `marketingConsent` is true and the other two are NULL — every enrolment taken
 * before the consent version was wired up, which `src/server/customers/consent.ts` documents. It
 * would be easy to read that as "they agreed", and it would be wrong: nothing can say when they
 * agreed or to what wording, which is the whole job of a consent record.
 *
 * These are pure, so the rule is testable without a database and cannot quietly move.
 */

const DATE = new Date("2026-03-01T10:00:00.000Z");

describe("the enrolment record, read as a permission", () => {
  it("is a permission only when it is complete", () => {
    const status = originStatus({ marketingConsent: true, privacyConsentAt: DATE, consentTextVersion: "2026-09-12.1" });
    expect(status.state).toBe("GRANTED");
    expect(status.marketingEligible).toBe(true);
    expect(status.ambiguity).toBeNull();
  });

  it("is never a permission when the date is missing", () => {
    const status = originStatus({ marketingConsent: true, privacyConsentAt: null, consentTextVersion: "2026-09-12.1" });
    expect(status.state).toBe("UNKNOWN");
    expect(status.marketingEligible).toBe(false);
    expect(status.ambiguity).toBe("MISSING_TIMESTAMP");
  });

  it("is never a permission when the wording they saw is missing", () => {
    const status = originStatus({ marketingConsent: true, privacyConsentAt: DATE, consentTextVersion: null });
    expect(status.state).toBe("UNKNOWN");
    expect(status.marketingEligible).toBe(false);
    expect(status.ambiguity).toBe("MISSING_POLICY_VERSION");
  });

  it("treats the real historical row — a tick with nothing else — as unknown", () => {
    // This is what is actually in the database for early enrolments. It is the case the rule exists
    // for, and reading it as consent is how a data gap becomes a message nobody agreed to receive.
    const status = originStatus({ marketingConsent: true, privacyConsentAt: null, consentTextVersion: null });
    expect(status.marketingEligible).toBe(false);
  });

  it("reads a refusal as a refusal, which is complete on its own", () => {
    // "No" needs no timestamp to be unambiguous, and it is never eligible either way.
    for (const record of [
      { marketingConsent: false, privacyConsentAt: DATE, consentTextVersion: "2026-09-12.1" },
      { marketingConsent: false, privacyConsentAt: null, consentTextVersion: null },
    ]) {
      const status = originStatus(record);
      expect(status.state).toBe("WITHDRAWN");
      expect(status.marketingEligible).toBe(false);
      expect(status.ambiguity).toBeNull();
    }
  });
});
