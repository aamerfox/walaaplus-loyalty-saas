import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  ENROLLMENT_CONSENT_TEXT_DIGEST,
  ENROLLMENT_CONSENT_VERSION,
  consentTextDigest,
} from "@/server/customers/consent";

/**
 * The consent text and its recorded version must move together.
 *
 * `PRODUCT-SPEC.md` §6.1 requires the exact consent text version stored at enrolment. The schema
 * and the service have supported it since Phase 0; the screen that collects consent never sent
 * one, so every real enrolment stored NULL for both the version and the timestamp — while the
 * integration tests passed, because they supplied a version by hand.
 *
 * So there are two failure modes to hold shut, not one. The route must stamp a version (covered
 * in `tests/integration/public-enrollment-route.test.ts`), and the version must still describe the
 * words a customer actually read. This file is the second: edit the consent wording without
 * bumping the version and the digest below stops matching, which is a failing test naming the
 * constant to change.
 */

const ROOT = path.resolve(import.meta.dirname, "../..");

function joinMessages(locale: string): { consentLabel: string; privacyNote: string } {
  const file = JSON.parse(readFileSync(path.join(ROOT, `messages/${locale}.json`), "utf8")) as {
    Join: { consentLabel: string; privacyNote: string };
  };
  return file.Join;
}

describe("the enrolment consent version", () => {
  const en = joinMessages("en");
  const ar = joinMessages("ar");
  /** The order is fixed and documented on the constant; changing it would change every digest. */
  const texts = [en.consentLabel, en.privacyNote, ar.consentLabel, ar.privacyNote];

  it("matches the wording currently shown to customers", () => {
    expect(
      consentTextDigest(texts),
      "The enrolment consent wording changed without ENROLLMENT_CONSENT_VERSION being bumped. " +
        "Update both constants in src/server/customers/consent.ts in this commit: a stored version " +
        "that points at different words than the customer read is worse than no version at all.",
    ).toBe(ENROLLMENT_CONSENT_TEXT_DIGEST);
  });

  it("covers both the marketing consent and the privacy note, in both locales", () => {
    // Four strings, none empty. A blank one would hash fine and mean nothing.
    expect(texts).toHaveLength(4);
    for (const text of texts) expect(text.trim().length).toBeGreaterThan(0);
    // The Arabic really is Arabic, not an untranslated copy of the English.
    expect(ar.consentLabel).not.toBe(en.consentLabel);
    expect(ar.privacyNote).not.toBe(en.privacyNote);
    expect(ar.consentLabel).toMatch(/[؀-ۿ]/);
  });

  it("is a version a person can order and compare", () => {
    // Dated, so "which came first" is answerable without a changelog.
    expect(ENROLLMENT_CONSENT_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}\.\d+$/);
  });

  it("detects a changed word", () => {
    // Guards the guard: a digest that did not change with the text would pass forever.
    const tampered = [...texts];
    tampered[0] = `${tampered[0]}.`;
    expect(consentTextDigest(tampered)).not.toBe(ENROLLMENT_CONSENT_TEXT_DIGEST);
  });
});
