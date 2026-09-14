import { randomBytes } from "node:crypto";
import { WebhookErrorClass } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const session = vi.hoisted(() => ({ userId: null as string | null }));

vi.mock("@/server/auth/session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/auth/session")>();
  const { UnauthorizedError } = await import("@/server/errors");
  return {
    ...actual,
    getCurrentUserId: async () => session.userId,
    requireUserId: async () => {
      if (!session.userId) throw new UnauthorizedError();
      return session.userId;
    },
  };
});

import { prisma } from "@/server/db";
import { encryptSecret } from "@/server/integrations/webhooks/crypto";
import { MAX_ATTEMPTS } from "@/server/integrations/webhooks/delivery";
import { createStampCafe, migratorPrisma, resetDatabase, type StampCafeFixture } from "../setup/fixtures";

/**
 * What an error class MEANS, enforced by the database rather than by the code that writes it.
 *
 * ## The gap this closes
 *
 * Migration 16 added `GATEWAY_UNAVAILABLE` and `GATEWAY_REJECTED` to `WebhookErrorClass` and, in its
 * first version, stopped there. But `walaaplus_validate_webhook_attempt` and
 * `walaaplus_webhook_delivery_guard` enumerate the permanent and retryable classes **by name**. A
 * value the enum knows and the triggers do not is a value the database has no opinion about — so
 * the restricted runtime role could have written `GATEWAY_REJECTED` as `RETRYABLE`, exhausted it to
 * `FAILED`, or recorded `GATEWAY_UNAVAILABLE` as `PERMANENT`, and an append-only history would have
 * said something false about work that was never done.
 *
 * The application never writes any of those, and that is exactly the point. Every other rule in
 * those functions is also one the application never breaks; they exist because "the code is
 * currently correct" is not a constraint, and an append-only table cannot be corrected later.
 *
 * ## How these tests are written
 *
 * Every write goes through `prisma`, the **restricted runtime client** — the same role `web` and
 * `worker` use — with no service in the way, exactly as a second service, a backfill script or a
 * console session would. `migratorPrisma()` appears only once, to read the trigger functions' own
 * source for the drift guard at the bottom, which is a question about the schema rather than about
 * a row.
 */

const PERMANENT_MESSAGE = /is permanent/;
const RETRYABLE_MESSAGE = /is retryable, not permanent/;
const NEVER_EXHAUSTED = /never retried to exhaustion/;
const NEVER_REFUSED = /never a refusal/;
const ONLY_AT_CAP = /only at the attempt cap/;

let savedKey: string | undefined;

beforeAll(() => {
  savedKey = process.env.INTEGRATION_ENCRYPTION_KEY;
  process.env.INTEGRATION_ENCRYPTION_KEY = randomBytes(32).toString("hex");
});

afterAll(() => {
  if (savedKey === undefined) delete process.env.INTEGRATION_ENCRYPTION_KEY;
  else process.env.INTEGRATION_ENCRYPTION_KEY = savedKey;
});

let cafe: StampCafeFixture;
let destinationId: string;
let deliveryId: string;

/** A café, an enabled destination and one pending test delivery — all through the runtime role. */
async function world(name: string): Promise<void> {
  cafe = await createStampCafe({ name });
  session.userId = cafe.userId;
  const host = "hooks.example.com";
  destinationId = (
    await prisma.webhookDestination.create({
      data: {
        businessId: cafe.businessId,
        name: `Ops for ${name}`,
        endpointHost: host,
        endpointDigest: randomBytes(32).toString("hex"),
        endpointCipher: encryptSecret(`https://${host}/hook`),
        signingSecretCipher: encryptSecret(randomBytes(32).toString("base64url")),
        cipherAlgorithm: "AES_256_GCM",
        cipherKeyVersion: 1,
        secretIssuedAt: new Date(),
      },
      select: { id: true },
    })
  ).id;
  await prisma.webhookDestination.update({ where: { id: destinationId }, data: { state: "ENABLED" } });
  deliveryId = (
    await prisma.webhookDelivery.create({
      data: { businessId: cafe.businessId, destinationId, isTest: true, nextAttemptAt: new Date() },
      select: { id: true },
    })
  ).id;
}

/**
 * Walk the attempt counter up to `count`, one at a time.
 *
 * One at a time because the guard refuses a jump, and from wherever it currently IS because the
 * guard also refuses a counter that goes down. It stops short of the cap on purpose: the guard
 * refuses a PENDING delivery at the cap, so the last step is always part of the settling update.
 */
async function attemptsTo(count: number): Promise<void> {
  const current = (
    await prisma.webhookDelivery.findFirstOrThrow({ where: { id: deliveryId }, select: { attemptCount: true } })
  ).attemptCount;
  for (let n = current + 1; n <= count; n += 1) {
    await prisma.webhookDelivery.update({ where: { id: deliveryId }, data: { attemptCount: n } });
  }
}

function settle(status: "REFUSED" | "FAILED", errorClass: WebhookErrorClass, attemptCount?: number) {
  return prisma.webhookDelivery.update({
    where: { id: deliveryId },
    data: {
      status,
      settledAt: new Date(),
      nextAttemptAt: null,
      lastErrorClass: errorClass,
      ...(attemptCount === undefined ? {} : { attemptCount }),
    },
  });
}

function attempt(outcome: "DELIVERED" | "RETRYABLE" | "PERMANENT", errorClass: WebhookErrorClass) {
  return prisma.webhookDeliveryAttempt.create({
    data: { businessId: cafe.businessId, deliveryId, attemptNumber: 1, outcome, errorClass, httpStatus: null },
  });
}

describe("GATEWAY_REJECTED is permanent, and the database says so", () => {
  beforeEach(async () => {
    await resetDatabase();
    await world("Rejected café");
    await attemptsTo(1);
  });

  it("refuses an attempt that records it as retryable", async () => {
    /*
     * The gateway refused the dispatch CONTRACT — a malformed URL, an oversized body, a header
     * outside the allow-list. That is a defect on this side, and waiting does not make a malformed
     * dispatch well formed. Recording it retryable would mean four more attempts at a request that
     * cannot become valid.
     */
    await expect(attempt("RETRYABLE", "GATEWAY_REJECTED")).rejects.toThrow(PERMANENT_MESSAGE);
  });

  it("refuses an attempt that records it as delivered", async () => {
    // Belt and braces: the pre-existing coherence rule still applies to the new class.
    await expect(attempt("DELIVERED", "GATEWAY_REJECTED")).rejects.toThrow(/carries no error class/);
  });

  it("refuses a delivery exhausted to FAILED with it", async () => {
    // A permanent class is never retried, so it can never be the reason a delivery ran out of
    // attempts. Below the cap first, then AT it - because "it had used all five" is the one excuse
    // that might look legitimate, and it is refused too.
    await expect(settle("FAILED", "GATEWAY_REJECTED")).rejects.toThrow(NEVER_EXHAUSTED);
    await attemptsTo(MAX_ATTEMPTS - 1);
    await expect(settle("FAILED", "GATEWAY_REJECTED", MAX_ATTEMPTS)).rejects.toThrow(NEVER_EXHAUSTED);
  });

  it("accepts the truthful shape: a permanent attempt and a REFUSED delivery", async () => {
    const row = await attempt("PERMANENT", "GATEWAY_REJECTED");
    expect(row.id).toBeTruthy();
    const settled = await settle("REFUSED", "GATEWAY_REJECTED");
    expect(settled.status).toBe("REFUSED");
    expect(settled.lastErrorClass).toBe("GATEWAY_REJECTED");
  });
});

describe("GATEWAY_UNAVAILABLE is retryable, and the database says so", () => {
  beforeEach(async () => {
    await resetDatabase();
    await world("Unavailable café");
    await attemptsTo(1);
  });

  it("refuses an attempt that records it as permanent", async () => {
    /*
     * It means the egress gateway was unreachable, unauthenticated, unconfigured or at its
     * concurrency limit — so NOTHING WAS SENT, and the fault is ours and temporary. Recording it
     * permanent would refuse a merchant's webhook because one of our own containers was restarting.
     */
    await expect(attempt("PERMANENT", "GATEWAY_UNAVAILABLE")).rejects.toThrow(RETRYABLE_MESSAGE);
  });

  it("refuses a delivery settled as a permanent REFUSAL with it", async () => {
    // "We refused to deliver this" about a delivery that was never attempted.
    await expect(settle("REFUSED", "GATEWAY_UNAVAILABLE")).rejects.toThrow(NEVER_REFUSED);
  });

  it("refuses FAILED before the attempt cap", async () => {
    for (const count of [1, 2, MAX_ATTEMPTS - 1]) {
      await attemptsTo(count);
      await expect(settle("FAILED", "GATEWAY_UNAVAILABLE"), String(count)).rejects.toThrow(ONLY_AT_CAP);
    }
  });

  it("accepts a retryable attempt", async () => {
    const row = await attempt("RETRYABLE", "GATEWAY_UNAVAILABLE");
    expect(row.id).toBeTruthy();
    expect(row.outcome).toBe("RETRYABLE");
  });

  it("accepts FAILED once, and only once, the cap is reached", async () => {
    // The final attempt and the settlement are ONE update: a PENDING delivery may never sit at the
    // cap, so there is no intermediate state where the counter has reached it and the status has
    // not. That is the real shape `recordAttempt` writes, too.
    await attemptsTo(MAX_ATTEMPTS - 1);
    const settled = await settle("FAILED", "GATEWAY_UNAVAILABLE", MAX_ATTEMPTS);
    expect(settled.status).toBe("FAILED");
    expect(settled.attemptCount).toBe(MAX_ATTEMPTS);
    expect(settled.lastErrorClass).toBe("GATEWAY_UNAVAILABLE");
  });
});

/**
 * Every class the database is supposed to have an opinion about, and what that opinion is.
 *
 * This table is the regression guard. A value added to `WebhookErrorClass` later and not declared
 * here fails the first assertion below; a value declared here that the triggers do not actually
 * enforce fails the ones after it. Between them, a new enum value cannot reach a deployment while
 * the database still has no opinion about what it means — which is precisely the gap migration 16
 * shipped with in its first version.
 *
 * `UNCONSTRAINED` is a deliberate answer, not a gap, and each one carries the reason it is one.
 */
const CLASSIFICATION: Record<WebhookErrorClass, "PERMANENT" | "RETRYABLE" | "UNCONSTRAINED"> = {
  // No error at all. Its coherence with DELIVERED is enforced by its own rule, not by this table.
  NONE: "UNCONSTRAINED",

  // ── Constrained, because getting these wrong is not a cosmetic mistake ──────
  /** Retrying an SSRF attempt is attempting it again. */
  UNSAFE_ADDRESS: "PERMANENT",
  /** A stored value that will not decrypt under a key that IS present is tampered or orphaned. */
  CIPHERTEXT_INVALID: "PERMANENT",
  /** An owner's disable or revoke is a decision, not a transient condition. */
  DESTINATION_NOT_ELIGIBLE: "PERMANENT",
  /** Our own dispatch contract was violated. Waiting does not make it well formed. */
  GATEWAY_REJECTED: "PERMANENT",
  /** A deployment condition an operator corrects. Nothing was sent; the delivery waits. */
  ENCRYPTION_UNAVAILABLE: "RETRYABLE",
  /** Our own container was unreachable or unconfigured. Nothing was sent; the delivery waits. */
  GATEWAY_UNAVAILABLE: "RETRYABLE",

  // ── Unconstrained on purpose ───────────────────────────────────────────────
  /*
   * Everything below describes what the RECEIVER or the network did, and the code's classification
   * of each follows from an HTTP status or an error code rather than from a policy the database
   * could restate. A 500 is retryable and a 404 is not, but both are `httpStatus`-derived facts,
   * and a trigger asserting "HTTP_SERVER_ERROR must be RETRYABLE" would be re-deriving the same
   * thing from less information. The classes above are different: each encodes a DECISION — ours
   * or the owner's — where recording the opposite would make the history say something false about
   * what was done rather than about what a stranger's server answered.
   */
  HTTP_CLIENT_ERROR: "UNCONSTRAINED",
  HTTP_RATE_LIMITED: "UNCONSTRAINED",
  HTTP_SERVER_ERROR: "UNCONSTRAINED",
  HTTP_REDIRECT: "UNCONSTRAINED",
  TIMEOUT: "UNCONSTRAINED",
  NETWORK: "UNCONSTRAINED",
  TLS: "UNCONSTRAINED",
};

describe("no error class can be added without the database learning what it means", () => {
  beforeEach(async () => {
    await resetDatabase();
    await world("Drift café");
    await attemptsTo(1);
  });

  it("declares a classification for every value the enum has, and for no value it does not", () => {
    /*
     * The assertion that fires first when somebody adds a class. It does not need a database: two
     * lists have to agree, and the one on the right is generated by Prisma from the schema.
     */
    expect(Object.keys(CLASSIFICATION).sort()).toEqual(Object.values(WebhookErrorClass).sort());
  });

  it("enforces every PERMANENT declaration on a live insert, not just in this file", async () => {
    for (const [name, kind] of Object.entries(CLASSIFICATION)) {
      if (kind !== "PERMANENT") continue;
      await expect(attempt("RETRYABLE", name as WebhookErrorClass), name).rejects.toThrow(PERMANENT_MESSAGE);
    }
  });

  it("enforces every RETRYABLE declaration on a live insert", async () => {
    for (const [name, kind] of Object.entries(CLASSIFICATION)) {
      if (kind !== "RETRYABLE") continue;
      await expect(attempt("PERMANENT", name as WebhookErrorClass), name).rejects.toThrow(RETRYABLE_MESSAGE);
    }
  });

  it("names every constrained class inside the trigger functions themselves", async () => {
    /*
     * Read the functions the database is actually running — not the migration file, which could
     * have been edited without being applied, and not the application, which is the thing being
     * checked. `pg_get_functiondef` returns the live definition.
     *
     * This is the assertion that would have failed on the first version of migration 16: both new
     * classes existed in the enum and neither appeared in either function.
     */
    const rows = await migratorPrisma().$queryRaw<{ name: string; def: string }[]>`
      SELECT p.proname AS name, pg_get_functiondef(p.oid) AS def
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public'
         AND p.proname IN ('walaaplus_validate_webhook_attempt', 'walaaplus_webhook_delivery_guard')
    `;
    expect(rows).toHaveLength(2);
    const source = rows.map((r) => r.def).join("\n");

    for (const [name, kind] of Object.entries(CLASSIFICATION)) {
      if (kind === "UNCONSTRAINED") continue;
      expect(source, `${name} is declared ${kind} but no trigger function mentions it`).toContain(name);
    }
  });

  it("compares classes as text, so a value added in the same transaction is still usable", async () => {
    /*
     * Not a style preference. PostgreSQL refuses to let a value added by `ALTER TYPE … ADD VALUE`
     * be used as an enum literal in the same transaction, and Prisma runs each migration in one —
     * so a redefined function that compared `NEW."errorClass" = 'GATEWAY_REJECTED'` would have
     * made the migration itself unapplyable. Comparing the label as text changes no semantics.
     */
    const rows = await migratorPrisma().$queryRaw<{ def: string }[]>`
      SELECT pg_get_functiondef(p.oid) AS def
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'walaaplus_validate_webhook_attempt'
    `;
    expect(rows[0].def).toContain('"errorClass"::text');
  });
});
