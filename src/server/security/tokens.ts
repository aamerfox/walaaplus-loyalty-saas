import { randomBytes, randomInt } from "node:crypto";

/**
 * Opaque public identifiers: QR tokens, card-page tokens, enrollment-link tokens, serials.
 *
 * Every one of these appears in a URL, a QR code or on a printed receipt, which means an attacker
 * can collect them and will try to walk from one to the next. So the rules are absolute:
 *
 *  - generated with `crypto.randomBytes`, never `Math.random`, never a counter, never a timestamp;
 *  - they encode NOTHING — not the card id, business id, customer id, phone number, or the
 *    moment of issue. Two cards issued in the same millisecond for the same customer look
 *    unrelated;
 *  - a card's QR token and its page token are DRAWN SEPARATELY. Scanning a card at the counter
 *    must not reveal the URL that opens it (PRODUCT-SPEC §4 CustomerCard).
 *
 * Entropy: 24 bytes = 192 bits. At a billion cards the chance of any collision is ~10^-39, so the
 * unique indexes exist to make a collision an error rather than a silent overwrite, not because
 * one is expected.
 */

/** Bytes of entropy per opaque token. */
export const TOKEN_ENTROPY_BYTES = 24;

/** URL-safe, no padding, no separators: safe in a path segment and in a QR code. */
export function opaqueToken(bytes: number = TOKEN_ENTROPY_BYTES): string {
  return randomBytes(bytes).toString("base64url");
}

/**
 * Crockford base32 without I, L, O and U: unambiguous when a human reads a serial off a receipt
 * and types it into the scanner's search box.
 */
const SERIAL_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const SERIAL_GROUPS = 3;
const SERIAL_GROUP_LENGTH = 4;

/**
 * A card serial: `WP-XXXX-XXXX-XXXX`, uniformly random over 60 bits.
 *
 * Uniform because `randomInt` rejects the biased tail rather than taking a modulus, and grouped
 * because staff read these aloud. It is an identifier, not a secret — the QR and page tokens are
 * the secrets — but it is still unguessable so that serial lookup cannot be used to enumerate a
 * business's customers.
 */
export function cardSerialNumber(): string {
  const groups: string[] = [];
  for (let g = 0; g < SERIAL_GROUPS; g++) {
    let group = "";
    for (let i = 0; i < SERIAL_GROUP_LENGTH; i++) group += SERIAL_ALPHABET[randomInt(SERIAL_ALPHABET.length)];
    groups.push(group);
  }
  return `WP-${groups.join("-")}`;
}

/** The set of tokens a new card needs, all drawn independently of each other. */
export interface CardTokens {
  serialNumber: string;
  qrToken: string;
  shareToken: string;
}

export function newCardTokens(): CardTokens {
  return { serialNumber: cardSerialNumber(), qrToken: opaqueToken(), shareToken: opaqueToken() };
}
