import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  CURRENT_KEY_VERSION,
  DecryptionFailedError,
  decryptSecret,
  EncryptionUnavailableError,
  encryptionAvailable,
  encryptSecret,
  envelopeKeyVersion,
  newSigningSecret,
  SIGNING_SECRET_BYTES,
  signaturesMatch,
  signPayload,
} from "@/server/integrations/webhooks/crypto";

/**
 * Authenticated encryption for the two values a destination holds worth stealing.
 *
 * Every key used here is generated in the test and lives in a local variable. **No value for
 * `INTEGRATION_ENCRYPTION_KEY` is embedded anywhere in this repository**, and the one for a real
 * environment is Freebuff's to provision — see `docs/INTEGRATIONS-CAPABILITY-MATRIX.md` §8a.
 */

/** A throwaway key per test. Never written down, never reused between tests. */
function key(): NodeJS.ProcessEnv {
  return { INTEGRATION_ENCRYPTION_KEY: randomBytes(32).toString("hex") } as unknown as NodeJS.ProcessEnv;
}

describe("a value survives a round trip and nothing else does", () => {
  it("encrypts and decrypts", () => {
    const env = key();
    const secret = "https://hooks.example.test/path?token=abc";
    expect(decryptSecret(encryptSecret(secret, env), env)).toBe(secret);
  });

  it("produces a different ciphertext every time, for the same plaintext", () => {
    // A fresh nonce per value. Identical ciphertexts would tell an observer of the table which two
    // destinations point at the same place.
    const env = key();
    const a = encryptSecret("https://hooks.example.test/x", env);
    const b = encryptSecret("https://hooks.example.test/x", env);
    expect(a).not.toBe(b);
    expect(decryptSecret(a, env)).toBe(decryptSecret(b, env));
  });

  it("carries its algorithm version in the envelope", () => {
    const env = key();
    const envelope = encryptSecret("x", env);
    expect(envelope.startsWith(`v${CURRENT_KEY_VERSION}.`)).toBe(true);
    expect(envelopeKeyVersion(envelope)).toBe(CURRENT_KEY_VERSION);
    // Four dot-separated parts, which is also what the database CHECK constraint insists on.
    expect(envelope.split(".")).toHaveLength(4);
  });

  it("never contains the plaintext", () => {
    const env = key();
    const secret = "https://hooks.example.test/very-distinctive-path";
    const envelope = encryptSecret(secret, env);
    expect(envelope).not.toContain("hooks.example.test");
    expect(envelope).not.toContain("very-distinctive-path");
  });

  it("refuses a value encrypted under a different key", () => {
    const envelope = encryptSecret("x", key());
    expect(() => decryptSecret(envelope, key())).toThrow(DecryptionFailedError);
  });
});

describe("tampering is rejected, not decoded", () => {
  const env = key();
  const plain = "https://hooks.example.test/path";

  function tamper(part: number): string {
    const parts = encryptSecret(plain, env).split(".");
    // Flip one base64url character in the named part.
    const chars = parts[part].split("");
    chars[0] = chars[0] === "A" ? "B" : "A";
    parts[part] = chars.join("");
    return parts.join(".");
  }

  it("refuses a tampered nonce, tag and ciphertext alike", () => {
    // GCM authenticates, so none of these decrypts to something else — they all fail.
    for (const part of [1, 2, 3]) {
      expect(() => decryptSecret(tamper(part), env), `part ${part}`).toThrow(DecryptionFailedError);
    }
  });

  it("refuses a malformed envelope", () => {
    for (const bad of ["", "x", "v1.a.b", "v1.a.b.c.d", "notaversion.a.b.c", "v1...", "v1.@@@.@@@.@@@"]) {
      expect(() => decryptSecret(bad, env), JSON.stringify(bad)).toThrow(DecryptionFailedError);
    }
  });

  it("tells a caller nothing about WHICH part failed", () => {
    /*
     * The same error for a wrong key, a tampered nonce, a tampered tag and a malformed envelope. A
     * caller that could tell them apart has an oracle.
     */
    const messages = new Set<string>();
    for (const bad of [tamper(1), tamper(2), tamper(3), "v1.a.b"]) {
      try {
        decryptSecret(bad, env);
      } catch (e) {
        messages.add((e as Error).message);
      }
    }
    try {
      decryptSecret(encryptSecret("x", key()), env);
    } catch (e) {
      messages.add((e as Error).message);
    }
    expect(messages.size).toBe(1);
  });
});

describe("a missing or malformed key fails closed", () => {
  it("refuses when the variable is absent or blank", () => {
    for (const source of [{}, { INTEGRATION_ENCRYPTION_KEY: "" }, { INTEGRATION_ENCRYPTION_KEY: "   " }]) {
      expect(() => encryptSecret("x", source as unknown as NodeJS.ProcessEnv)).toThrow(EncryptionUnavailableError);
      expect(encryptionAvailable(source as unknown as NodeJS.ProcessEnv)).toBe(false);
    }
  });

  it("refuses a key of the wrong length, rather than stretching it", () => {
    // A 31-byte key is a typo, not a weaker key. Accepting one means a deployment that looks
    // configured and is not.
    for (const bad of [randomBytes(31).toString("hex"), randomBytes(33).toString("hex"), "abc", "z".repeat(64)]) {
      expect(() => encryptSecret("x", { INTEGRATION_ENCRYPTION_KEY: bad } as unknown as NodeJS.ProcessEnv), bad.slice(0, 8)).toThrow(
        EncryptionUnavailableError,
      );
    }
  });

  it("accepts hex and base64 alike", () => {
    const raw = randomBytes(32);
    for (const encoded of [raw.toString("hex"), raw.toString("base64"), raw.toString("base64url")]) {
      const source = { INTEGRATION_ENCRYPTION_KEY: encoded } as unknown as NodeJS.ProcessEnv;
      expect(encryptionAvailable(source), encoded.slice(0, 8)).toBe(true);
      expect(decryptSecret(encryptSecret("x", source), source)).toBe("x");
    }
  });

  it("names the variable and never any part of its value", () => {
    const bad = randomBytes(31).toString("hex");
    try {
      encryptSecret("x", { INTEGRATION_ENCRYPTION_KEY: bad } as unknown as NodeJS.ProcessEnv);
      throw new Error("should have thrown");
    } catch (e) {
      const message = (e as Error).message;
      expect(message).toContain("INTEGRATION_ENCRYPTION_KEY");
      expect(message).not.toContain(bad);
      // Not even a prefix. A logged error that quotes eight characters of a key has quoted a key.
      expect(message).not.toContain(bad.slice(0, 8));
    }
  });

  it("has no plaintext fallback", () => {
    /*
     * The rule this whole module exists for. There is no source, and no combination of arguments,
     * that returns the plaintext unencrypted — the only two outcomes are ciphertext and a refusal.
     */
    for (const source of [{}, { INTEGRATION_ENCRYPTION_KEY: "too-short" }, { NODE_ENV: "development" }]) {
      let result: string | null = null;
      try {
        result = encryptSecret("https://hooks.example.test/x", source as unknown as NodeJS.ProcessEnv);
      } catch {
        // expected
      }
      expect(result).toBeNull();
    }
  });
});

describe("the signature", () => {
  it("is HMAC-SHA-256 over the timestamp, a dot, and the body", () => {
    const secret = newSigningSecret();
    const sig = signPayload(secret, "1700000000", '{"id":"x"}');
    expect(sig).toMatch(/^[0-9a-f]{64}$/);
    expect(signPayload(secret, "1700000000", '{"id":"x"}')).toBe(sig);
  });

  it("changes when the timestamp changes, so a body cannot be replayed under a new one", () => {
    // The reason the timestamp is INSIDE the signed string rather than only in a header.
    const secret = newSigningSecret();
    const body = '{"id":"x"}';
    expect(signPayload(secret, "1700000000", body)).not.toBe(signPayload(secret, "1700000001", body));
  });

  it("changes when the body changes, and when the secret changes", () => {
    const a = newSigningSecret();
    const b = newSigningSecret();
    expect(signPayload(a, "1", "x")).not.toBe(signPayload(a, "1", "y"));
    expect(signPayload(a, "1", "x")).not.toBe(signPayload(b, "1", "x"));
  });

  it("mints a high-entropy secret", () => {
    const secrets = new Set(Array.from({ length: 50 }, () => newSigningSecret()));
    expect(secrets.size).toBe(50);
    // 32 bytes as base64url is 43 characters.
    for (const s of secrets) expect(s.length).toBeGreaterThanOrEqual(Math.ceil((SIGNING_SECRET_BYTES * 4) / 3));
  });

  it("compares without leaking how far two signatures matched", () => {
    const sig = signPayload(newSigningSecret(), "1", "x");
    expect(signaturesMatch(sig, sig)).toBe(true);
    // Flip the last character to something it certainly is not, rather than to a fixed value that
    // might already be there — which is how this assertion was flaky the first time it ran.
    const flipped = sig.slice(0, -1) + (sig.endsWith("0") ? "1" : "0");
    expect(flipped).not.toBe(sig);
    expect(signaturesMatch(sig, flipped)).toBe(false);
    // A length mismatch returns false rather than throwing, so a malformed header is not a 500.
    expect(signaturesMatch("abc", "abcd")).toBe(false);
  });
});
