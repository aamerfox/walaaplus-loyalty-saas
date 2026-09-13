/**
 * Apple Wallet and Google Wallet pass PAYLOADS.
 *
 * ## What this file is, and what it is not
 *
 * These are the JSON documents the two platforms consume. They are **not signed here**, and nothing
 * in this build delivers one: Apple requires a Pass Type ID certificate and Google a service-account
 * key, and adding either would mean adding a secret and an environment variable, which this phase is
 * not permitted to do. So the builders are pure, fixture-tested functions, and issuing a real pass
 * stays a documented manual gate — see `docs/evidence/phase-3a-prompt-1.md` §Device gate.
 *
 * Writing them now is still worth it: the shape of the link is the security-relevant part, and it
 * is far cheaper to get wrong in a fixture than in something a customer has already saved.
 *
 * ## The rules both payloads obey
 *
 *  1. **The invitation URL goes in a link field, never in the barcode.** A barcode is scanned by a
 *     cashier at a counter; putting a capability in one hands it to whoever is holding the scanner.
 *     The barcode carries the card's `qrToken` and nothing else, exactly as it does today.
 *  2. **The invitation URL is never on the front of the card.** Apple's front fields are printed on
 *     a lock-screen notification; Google's `textModulesData` renders in the card body. Neither is a
 *     place for a capability.
 *  3. **No customer identifier travels in either payload beyond what the card already shows its own
 *     holder** — their first name, their balance, their serial. No phone, no email, no internal id.
 *  4. **The link is a fragment URL.** `https://host/share#<token>` is opened by the platform's
 *     browser, and the token never reaches a server log.
 */

/** Everything a payload needs, resolved by the caller so these stay pure. */
export interface WalletPassInput {
  businessName: string;
  programName: string;
  rewardName: string;
  /** The holder's own scanner token. This is the barcode, and the ONLY secret in the payload body. */
  qrToken: string;
  serialNumber: string;
  stampBalance: number;
  stampsRequiredPerReward: number;
  rewardBalance: number;
  customerFirstName: string | null;
  /** `https://host/share#<token>`. Null when no capability has been minted for this card. */
  invitationUrl: string | null;
  /** Drives the label of the invitation link and the field names. */
  locale: "en" | "ar";
  expiresAt: Date | null;
}

/**
 * The label on the invitation link, in both locales.
 *
 * Short, because both platforms truncate, and honest: it opens invitations. It does not say
 * "earn rewards", because no referral reward policy exists — see `docs/DECISIONS-REQUIRED.md` D15.
 * A wallet pass is the one surface a customer cannot re-read a correction on, so the wording it
 * ships with has to be one that stays true.
 */
export const INVITATION_LABEL: Record<"en" | "ar", string> = {
  en: "Open invitations",
  ar: "فتح الدعوات",
};

const FIELD_LABELS = {
  en: { stamps: "Stamps", rewards: "Rewards ready", serial: "Card number", programme: "Programme" },
  ar: { stamps: "الأختام", rewards: "مكافآت جاهزة", serial: "رقم البطاقة", programme: "البرنامج" },
} as const;

/* ─────────────────────────────────────────────────────────────────────────────
 * Google Wallet
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * The subset of `loyaltyObject` this product fills in.
 *
 * `linksModuleData.uris[]` is the official place for a tappable web link on a Google pass — the same
 * mechanism a merchant's website or phone number uses. It is a real field on the object, not a text
 * module dressed up to look like a button, which is what the "fake visual field" trap looks like.
 */
export interface GoogleLoyaltyObject {
  id: string;
  classId: string;
  state: "ACTIVE" | "EXPIRED";
  accountName?: string;
  accountId: string;
  barcode: { type: "QR_CODE"; value: string; alternateText?: string };
  loyaltyPoints?: { label: string; balance: { int: number } };
  secondaryLoyaltyPoints?: { label: string; balance: { int: number } };
  textModulesData?: { header: string; body: string; id: string }[];
  linksModuleData?: { uris: { uri: string; description: string; id: string }[] };
}

/**
 * Build the loyalty object.
 *
 * `objectId` and `classId` are supplied by the caller because their namespace is the issuer's, and
 * this build has no issuer configured. Tests pass fixtures; a future signing step passes the real
 * ones from wherever that phase decides issuer configuration lives.
 */
export function buildGoogleLoyaltyObject(
  input: WalletPassInput,
  ids: { objectId: string; classId: string },
): GoogleLoyaltyObject {
  const labels = FIELD_LABELS[input.locale];

  const object: GoogleLoyaltyObject = {
    id: ids.objectId,
    classId: ids.classId,
    state: input.expiresAt && input.expiresAt.getTime() < Date.now() ? "EXPIRED" : "ACTIVE",
    // The account name is what the holder sees as "their" name on the pass. Absent when unknown,
    // rather than filled with a placeholder that reads as somebody else's card.
    ...(input.customerFirstName ? { accountName: input.customerFirstName } : {}),
    // The serial, which is already printed on the card and read aloud at counters. Never an
    // internal id, and never the customer's phone.
    accountId: input.serialNumber,
    barcode: {
      type: "QR_CODE",
      // The scanner token, unchanged. The invitation capability is deliberately NOT here.
      value: input.qrToken,
      alternateText: input.serialNumber,
    },
    loyaltyPoints: { label: labels.stamps, balance: { int: input.stampBalance } },
    secondaryLoyaltyPoints: { label: labels.rewards, balance: { int: input.rewardBalance } },
    textModulesData: [{ header: labels.programme, body: input.programName, id: "programme" }],
  };

  if (input.invitationUrl) {
    object.linksModuleData = {
      uris: [{ uri: input.invitationUrl, description: INVITATION_LABEL[input.locale], id: "invitations" }],
    };
  }

  return object;
}

/* ─────────────────────────────────────────────────────────────────────────────
 * Apple Wallet
 * ────────────────────────────────────────────────────────────────────────── */

export interface ApplePassField {
  key: string;
  label: string;
  value: string;
  /**
   * Apple turns a URL inside a back field into a tappable link when the field allows link
   * detection. `["PKDataDetectorTypeLink"]` says exactly that and nothing else — a field that also
   * detected phone numbers and addresses would linkify text nobody meant as a link.
   */
  dataDetectorTypes?: string[];
  attributedValue?: string;
}

export interface ApplePassJson {
  formatVersion: 1;
  passTypeIdentifier: string;
  serialNumber: string;
  teamIdentifier: string;
  organizationName: string;
  description: string;
  foregroundColor: string;
  backgroundColor: string;
  labelColor: string;
  barcodes: { format: "PKBarcodeFormatQR"; message: string; messageEncoding: string; altText?: string }[];
  storeCard: {
    headerFields: ApplePassField[];
    primaryFields: ApplePassField[];
    secondaryFields: ApplePassField[];
    backFields: ApplePassField[];
  };
  expirationDate?: string;
}

/** Zademi navy and turquoise, as the rest of the product uses them. */
const APPLE_COLOURS = {
  background: "rgb(11, 45, 91)",
  foreground: "rgb(255, 255, 255)",
  label: "rgb(125, 211, 205)",
} as const;

/**
 * Build `pass.json` for a store card.
 *
 * **The invitation link is a back field.** That is not a compromise, it is the only correct place:
 *
 *  - Apple has no "button" on the front of a pass. A product claiming one would be describing an
 *    interface the platform does not render;
 *  - back fields are where Wallet detects URLs and makes them tappable, opening Safari;
 *  - the front of a pass is visible on a lock screen, and a capability does not belong there.
 *
 * The identifiers come from the caller for the same reason as Google's: this build has no Pass Type
 * ID and no team identifier, and inventing one in code would be a configuration decision wearing a
 * constant's clothes.
 */
export function buildApplePassJson(
  input: WalletPassInput,
  ids: { passTypeIdentifier: string; teamIdentifier: string },
): ApplePassJson {
  const labels = FIELD_LABELS[input.locale];

  const backFields: ApplePassField[] = [
    { key: "programme", label: labels.programme, value: input.programName },
    { key: "serial", label: labels.serial, value: input.serialNumber },
  ];

  if (input.invitationUrl) {
    backFields.push({
      key: "invitations",
      label: INVITATION_LABEL[input.locale],
      // The bare URL as the value: this is what Wallet detects and turns into a tappable link.
      value: input.invitationUrl,
      dataDetectorTypes: ["PKDataDetectorTypeLink"],
    });
  }

  return {
    formatVersion: 1,
    passTypeIdentifier: ids.passTypeIdentifier,
    serialNumber: input.serialNumber,
    teamIdentifier: ids.teamIdentifier,
    organizationName: input.businessName,
    description: `${input.businessName} — ${input.programName}`,
    foregroundColor: APPLE_COLOURS.foreground,
    backgroundColor: APPLE_COLOURS.background,
    labelColor: APPLE_COLOURS.label,
    barcodes: [
      {
        format: "PKBarcodeFormatQR",
        // The scanner token, unchanged, and the only secret on the front of this pass.
        message: input.qrToken,
        messageEncoding: "iso-8859-1",
        altText: input.serialNumber,
      },
    ],
    storeCard: {
      headerFields: [{ key: "rewards", label: labels.rewards, value: String(input.rewardBalance) }],
      primaryFields: [
        {
          key: "stamps",
          label: labels.stamps,
          value: `${input.stampBalance} / ${input.stampsRequiredPerReward}`,
        },
      ],
      secondaryFields: [{ key: "reward", label: input.rewardName, value: input.programName }],
      backFields,
    },
    ...(input.expiresAt ? { expirationDate: input.expiresAt.toISOString() } : {}),
  };
}

/* ─────────────────────────────────────────────────────────────────────────────
 * Redaction
 * ────────────────────────────────────────────────────────────────────────── */

/** What a redacted URL looks like. Recognisable, and useless. */
export const REDACTED_TOKEN = "<token-not-shown>";

/**
 * Replace the capability in any `…/share#<token>` URL with a placeholder.
 *
 * Used by everything that shows a payload to a member of staff. An owner screen must be able to
 * answer "does this pass carry the invitation link, and where" without also answering "and what is
 * it" — the capability belongs to the customer, in their wallet, and nowhere else.
 *
 * Applied to the whole serialised payload rather than to a known field, so a future field that
 * happens to carry the URL is redacted too rather than being the one that was forgotten.
 */
export function redactInvitationUrls<T>(payload: T): T {
  const json = JSON.stringify(payload).replace(/(\/share#)[A-Za-z0-9_-]+/g, `$1${REDACTED_TOKEN}`);
  return JSON.parse(json) as T;
}
