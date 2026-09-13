import { describe, expect, it } from "vitest";
import {
  buildApplePassJson,
  buildGoogleLoyaltyObject,
  INVITATION_LABEL,
  redactInvitationUrls,
  REDACTED_TOKEN,
  type WalletPassInput,
} from "@/server/wallet/pass-payloads";

/**
 * Where the invitation link may appear in a wallet pass, and where it must not.
 *
 * A pass is the one surface a customer cannot re-read a correction on: once it is saved, it sits in
 * their wallet until it is issued again. So the questions worth pinning are the placement ones, and
 * they are cheap to pin here and expensive to discover on a phone.
 *
 * Two of these assertions are the whole point of the file:
 *
 *  - **the capability is never in the barcode.** A barcode is held up to a cashier's scanner; a
 *    capability in one is a capability handed to whoever is holding the scanner;
 *  - **the capability is never on the front of the card.** Apple's front fields are printed on a
 *    lock-screen notification, and Google's text modules render in the card body.
 */

const TOKEN = "Yy8kQ2Jd-Nn4mWkTgqfHlPz0XcVbNmAsDfGhJkLqWeR";
const INVITATION = `https://zademi.example/share#${TOKEN}`;

const INPUT: WalletPassInput = {
  businessName: "مقهى الشام",
  programName: "Coffee card",
  rewardName: "A free coffee",
  qrToken: "scanner-token-aBcDeFgHiJkLmNoPqRsTuVwX",
  serialNumber: "WP-SW60-FFF3-9VQQ",
  stampBalance: 4,
  stampsRequiredPerReward: 10,
  rewardBalance: 1,
  customerFirstName: "ليلى",
  invitationUrl: INVITATION,
  locale: "en",
  expiresAt: null,
};

const APPLE_IDS = { passTypeIdentifier: "pass.example.zademi", teamIdentifier: "TEAM123456" };
const GOOGLE_IDS = { objectId: "3388000000000000001.card-1", classId: "3388000000000000001.stamp" };

describe("Google Wallet", () => {
  it("puts the invitation in linksModuleData, which is the official place for a tappable link", () => {
    const object = buildGoogleLoyaltyObject(INPUT, GOOGLE_IDS);
    expect(object.linksModuleData?.uris).toEqual([
      { uri: INVITATION, description: INVITATION_LABEL.en, id: "invitations" },
    ]);
  });

  it("never puts the invitation in the barcode", () => {
    // The barcode is the card's scanner token, unchanged by any of this.
    const object = buildGoogleLoyaltyObject(INPUT, GOOGLE_IDS);
    expect(object.barcode.value).toBe(INPUT.qrToken);
    expect(JSON.stringify(object.barcode)).not.toContain(TOKEN);
  });

  it("never puts the invitation in a text module, which renders in the card body", () => {
    const object = buildGoogleLoyaltyObject(INPUT, GOOGLE_IDS);
    expect(JSON.stringify(object.textModulesData)).not.toContain(TOKEN);
    expect(JSON.stringify(object.textModulesData)).not.toContain("/share#");
  });

  it("omits the link entirely when no capability has been minted", () => {
    // Not an empty `uris` array and not a placeholder URI: absent, so a pass built before a
    // capability exists shows no invitation row at all rather than a dead one.
    const object = buildGoogleLoyaltyObject({ ...INPUT, invitationUrl: null }, GOOGLE_IDS);
    expect(object.linksModuleData).toBeUndefined();
  });

  it("carries the serial as the account id, never an internal identifier", () => {
    const object = buildGoogleLoyaltyObject(INPUT, GOOGLE_IDS);
    expect(object.accountId).toBe(INPUT.serialNumber);
  });

  it("marks an expired card expired rather than quietly showing a live balance", () => {
    const past = new Date(Date.now() - 86_400_000);
    expect(buildGoogleLoyaltyObject({ ...INPUT, expiresAt: past }, GOOGLE_IDS).state).toBe("EXPIRED");
  });
});

describe("Apple Wallet", () => {
  it("puts the invitation in a back field, with link detection on", () => {
    const pass = buildApplePassJson(INPUT, APPLE_IDS);
    const field = pass.storeCard.backFields.find((f) => f.key === "invitations");
    expect(field?.value).toBe(INVITATION);
    // This attribute is what makes Wallet render it as a tappable link rather than as grey text.
    expect(field?.dataDetectorTypes).toEqual(["PKDataDetectorTypeLink"]);
  });

  it("never puts the invitation in the barcode", () => {
    const pass = buildApplePassJson(INPUT, APPLE_IDS);
    expect(pass.barcodes[0].message).toBe(INPUT.qrToken);
    expect(JSON.stringify(pass.barcodes)).not.toContain(TOKEN);
  });

  it("never puts the invitation on the front of the card", () => {
    /*
     * Header, primary and secondary fields are the front. On iOS they are also what appears on a
     * lock screen when the pass surfaces, which is a screen other people can read over a shoulder.
     */
    const { headerFields, primaryFields, secondaryFields } = buildApplePassJson(INPUT, APPLE_IDS).storeCard;
    const front = JSON.stringify({ headerFields, primaryFields, secondaryFields });
    expect(front).not.toContain(TOKEN);
    expect(front).not.toContain("/share#");
    expect(front).not.toContain("http");
  });

  it("omits the invitation field entirely when no capability has been minted", () => {
    const pass = buildApplePassJson({ ...INPUT, invitationUrl: null }, APPLE_IDS);
    expect(pass.storeCard.backFields.map((f) => f.key)).toEqual(["programme", "serial"]);
  });

  it("carries no customer identifier beyond what the card already shows its own holder", () => {
    const pass = buildApplePassJson(INPUT, APPLE_IDS);
    const json = JSON.stringify(pass);
    // The holder's own first name and serial are on their own card by design; nothing else is.
    expect(json).not.toContain("@");
    expect(json).not.toMatch(/\+?963\d{6,}/);
  });
});

describe("both payloads speak the draft's language", () => {
  it("labels the invitation in Arabic on an Arabic pass", () => {
    const apple = buildApplePassJson({ ...INPUT, locale: "ar" }, APPLE_IDS);
    const google = buildGoogleLoyaltyObject({ ...INPUT, locale: "ar" }, GOOGLE_IDS);
    expect(apple.storeCard.backFields.find((f) => f.key === "invitations")?.label).toBe(INVITATION_LABEL.ar);
    expect(google.linksModuleData?.uris[0].description).toBe(INVITATION_LABEL.ar);
  });

  it("promises nothing about rewards in either label", () => {
    /*
     * The label a customer taps is the one piece of copy this product cannot correct after the fact.
     * No referral reward policy exists (D15), so neither locale may imply one.
     */
    for (const label of Object.values(INVITATION_LABEL)) {
      expect(label.toLowerCase()).not.toMatch(/reward|earn|bonus|free|discount/);
      expect(label).not.toMatch(/مكاف|اربح|خصم|مجان/);
    }
  });
});

describe("redaction", () => {
  it("removes the capability from anywhere in a payload, not from one known field", () => {
    const pass = buildApplePassJson(INPUT, APPLE_IDS);
    const redacted = redactInvitationUrls(pass);
    const json = JSON.stringify(redacted);
    expect(json).not.toContain(TOKEN);
    expect(json).toContain(`/share#${REDACTED_TOKEN}`);
    // Everything else survives: a redacted preview still has to be worth looking at.
    expect(redacted.barcodes[0].message).toBe(INPUT.qrToken);
    expect(redacted.storeCard.backFields.find((f) => f.key === "invitations")?.label).toBe(INVITATION_LABEL.en);
  });

  it("covers a field that did not exist when the redactor was written", () => {
    // Applied over the serialised payload rather than a field list, so an invitation URL that ends
    // up somewhere new is redacted rather than being the one somebody forgot.
    const invented = { anywhere: { at: { all: `https://zademi.example/share#${TOKEN}` } } };
    expect(JSON.stringify(redactInvitationUrls(invented))).not.toContain(TOKEN);
  });

  it("leaves a payload with no invitation untouched", () => {
    const pass = buildGoogleLoyaltyObject({ ...INPUT, invitationUrl: null }, GOOGLE_IDS);
    expect(redactInvitationUrls(pass)).toEqual(pass);
  });
});
