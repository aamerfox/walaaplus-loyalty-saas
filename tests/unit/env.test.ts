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

  describe("a password that breaks the connection string", () => {
    // `openssl rand -base64 24` produces a `/` roughly a third of the time, and the resulting
    // URL is not a URL: the authority ends at the slash. Before this check the process started
    // and failed at the first query instead, with a driver error pointing nowhere near the
    // password — which is what made the failure look intermittent rather than deterministic.
    const withPassword = (pw: string) => `postgresql://walaaplus:${pw}@db:5432/loyalty?schema=public`;

    it("refuses a raw slash, and names the variable without echoing it", () => {
      let caught: unknown;
      try {
        validateEnv({ ...VALID, DATABASE_URL: withPassword("abc/def") });
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(EnvValidationError);
      const err = caught as EnvValidationError;
      expect(err.variables).toEqual(["DATABASE_URL"]);
      expect(err.message).not.toContain("abc/def");
    });

    it("refuses an unencoded percent sign", () => {
      // decodeURIComponent throws on this, exactly where the driver would.
      expect(() => validateEnv({ ...VALID, DATABASE_URL: withPassword("ab%zz") })).toThrow(EnvValidationError);
    });

    it("accepts the same password once it is percent-encoded", () => {
      expect(() => validateEnv({ ...VALID, DATABASE_URL: withPassword("abc%2Fdef") })).not.toThrow();
    });

    it("accepts hex, which is what the templates now recommend", () => {
      expect(() => validateEnv({ ...VALID, DATABASE_URL: withPassword("f".repeat(64)) })).not.toThrow();
    });

    it("refuses a connection string with no database name", () => {
      expect(() => validateEnv({ ...VALID, DATABASE_URL: "postgresql://u:p@db:5432" })).toThrow(EnvValidationError);
    });

    it("refuses a connection string with no host", () => {
      expect(() => validateEnv({ ...VALID, DATABASE_URL: "postgresql:///loyalty" })).toThrow(EnvValidationError);
    });
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
