import { describe, expect, it } from "vitest";
import { EnvValidationError, validateEnv } from "@/server/env";

const VALID = {
  DATABASE_URL: "postgresql://user:pw@localhost:5432/db?schema=public",
  NEXTAUTH_SECRET: "a".repeat(40),
  NEXTAUTH_URL: "http://localhost:3000",
};

describe("validateEnv", () => {
  it("accepts a complete environment and applies defaults", () => {
    const env = validateEnv(VALID);
    expect(env.NODE_ENV).toBe("development");
    expect(env.WORKER_HEALTH_PORT).toBe(8081);
    expect(env.DATABASE_URL).toBe(VALID.DATABASE_URL);
  });

  it("fails when required variables are missing and reports NAMES only", () => {
    let caught: unknown;
    try {
      validateEnv({});
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(EnvValidationError);
    const err = caught as EnvValidationError;
    expect(err.variables).toEqual(["DATABASE_URL", "NEXTAUTH_SECRET", "NEXTAUTH_URL"]);
    expect(err.message).toContain("DATABASE_URL");
    expect(err.message).toContain(".env.example");
  });

  it("never echoes a supplied value in the error message", () => {
    const secretish = "postgresql://leak:me@host/db";
    let message = "";
    try {
      validateEnv({ ...VALID, DATABASE_URL: secretish, NEXTAUTH_SECRET: "short" });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).not.toContain("leak");
    expect(message).not.toContain("short");
    expect(message).toContain("NEXTAUTH_SECRET");
  });

  it("rejects a NEXTAUTH_SECRET shorter than 32 characters", () => {
    expect(() => validateEnv({ ...VALID, NEXTAUTH_SECRET: "x".repeat(31) })).toThrow(EnvValidationError);
    expect(() => validateEnv({ ...VALID, NEXTAUTH_SECRET: "x".repeat(32) })).not.toThrow();
  });

  it("rejects a non-postgres DATABASE_URL", () => {
    expect(() => validateEnv({ ...VALID, DATABASE_URL: "mysql://x" })).toThrow(EnvValidationError);
  });

  it("rejects an unknown NODE_ENV", () => {
    expect(() => validateEnv({ ...VALID, NODE_ENV: "staging" })).toThrow(EnvValidationError);
  });

  it("refuses the burned prototype fallback secrets even though they satisfy the length rule", () => {
    // These two literals are already public in git history (docs/PHASE-0-HYGIENE.md H-1).
    // They are not secrets; this test exists precisely so they can never become one again.
    for (const burned of ["super-secret-walaaplus-dev-key-123", "walaaplus-local-dev-secret-key-123"]) {
      expect(burned.length).toBeGreaterThanOrEqual(32);
      let err: unknown;
      try {
        validateEnv({ ...VALID, NEXTAUTH_SECRET: burned });
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(EnvValidationError);
      expect((err as EnvValidationError).variables).toEqual(["NEXTAUTH_SECRET"]);
      expect((err as Error).message).toContain("compromised");
      expect((err as Error).message).not.toContain(burned);
    }
  });

  it("coerces WORKER_HEALTH_PORT and rejects out-of-range values", () => {
    expect(validateEnv({ ...VALID, WORKER_HEALTH_PORT: "0" }).WORKER_HEALTH_PORT).toBe(0);
    expect(() => validateEnv({ ...VALID, WORKER_HEALTH_PORT: "70000" })).toThrow(EnvValidationError);
  });
});
