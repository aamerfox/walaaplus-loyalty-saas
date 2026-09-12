/**
 * Which consent text a customer actually agreed to.
 *
 * `PRODUCT-SPEC.md` §6.1 requires the **exact consent text version stored** at enrolment, and the
 * schema has carried `consentTextVersion` and `privacyConsentAt` since Phase 0 for exactly that.
 * The service wrote both when given a version — and the only screen that collects consent never
 * sent one, so every real enrolment stored `NULL` in both. A `marketingConsent = true` with no
 * timestamp and no text version answers neither "when" nor "to what", which is the whole job of a
 * consent record.
 *
 * That gap is not recoverable after the fact. You cannot reconstruct when someone agreed, so every
 * day a pilot runs without this is a day of consent records that can never be completed.
 *
 * **The version is stamped by the server, not sent by the page.** The client plumbing is what was
 * missed last time: a field the browser has to remember to include is a field that goes missing,
 * and a value the browser supplies is a value that can be wrong. The server knows which revision
 * of the text this build serves, because it is this constant.
 */
import { createHash } from "node:crypto";

/**
 * The current revision of the enrolment consent texts.
 *
 * **Bump this in the same commit that changes `Join.consentLabel` or `Join.privacyNote` in either
 * locale.** `tests/unit/enrollment-consent.test.ts` hashes those four strings and fails if they
 * move without this moving too, so the rule is enforced rather than remembered.
 */
export const ENROLLMENT_CONSENT_VERSION = "2026-09-12.1";

/**
 * sha256 of the four strings this version refers to, in the order
 * `en.consentLabel, en.privacyNote, ar.consentLabel, ar.privacyNote`, joined by a newline.
 *
 * Recorded here so a change to the wording is a failing test rather than a silent mismatch
 * between what a customer read and what the database says they read.
 */
export const ENROLLMENT_CONSENT_TEXT_DIGEST = "0847969a393d6387b468d3f0196271e27276cdf14af69c06a035722370a9ccc0";

/** The digest of a given set of consent strings. Used by the guard test and nowhere else. */
export function consentTextDigest(texts: readonly string[]): string {
  return createHash("sha256").update(texts.join("\n"), "utf8").digest("hex");
}
