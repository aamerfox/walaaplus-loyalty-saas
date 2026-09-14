import { randomBytes, randomUUID } from "node:crypto";
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
import { codeDigest, newCodeSalt } from "@/server/promotions/codes";
import {
  createStampCafe,
  enrolCustomer,
  migratorPrisma,
  resetDatabase,
  uniqueSyrianPhone,
  type StampCafeFixture,
} from "../setup/fixtures";

/**
 * What the DATABASE refuses, with the services taken out of the picture.
 *
 * `webhooks.test.ts` proves the services write correct rows; this proves a correct row is the only
 * kind the database accepts. Every insert below goes through `prisma`, the **restricted runtime
 * client**, with no service in the way — exactly as a second service, a backfill script or a console
 * session would.
 *
 * Foreign keys check that each id EXISTS. Nothing in a foreign key checks that the destination is
 * this business's, that the event is, that an attempt count only rises, or that a row claiming
 * DELIVERED carries no error.
 */

const REFUSED = /Webhook(Destination|Delivery|DeliveryAttempt):/;
const REFUSED_OR_DENIED = /Webhook|permission denied|append-only|never removed/i;

let savedKey: string | undefined;

beforeAll(() => {
  savedKey = process.env.INTEGRATION_ENCRYPTION_KEY;
  process.env.INTEGRATION_ENCRYPTION_KEY = randomBytes(32).toString("hex");
});

afterAll(() => {
  if (savedKey === undefined) delete process.env.INTEGRATION_ENCRYPTION_KEY;
  else process.env.INTEGRATION_ENCRYPTION_KEY = savedKey;
});

interface World {
  cafe: StampCafeFixture;
  destinationId: string;
}

/** A café with one ENABLED destination, built without any service. */
async function build(name: string, host = "hooks.example.com"): Promise<World> {
  const cafe = await createStampCafe({ name });
  session.userId = cafe.userId;
  const row = await prisma.webhookDestination.create({
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
  });
  await prisma.webhookDestination.update({ where: { id: row.id }, data: { state: "ENABLED" } });
  return { cafe, destinationId: row.id };
}

function destinationData(w: World, overrides: Record<string, unknown> = {}) {
  return {
    businessId: w.cafe.businessId,
    name: `Another ${Math.random().toString(36).slice(2, 8)}`,
    endpointHost: "hooks.example.org",
    endpointDigest: randomBytes(32).toString("hex"),
    endpointCipher: encryptSecret("https://hooks.example.org/hook"),
    signingSecretCipher: encryptSecret("s"),
    cipherAlgorithm: "AES_256_GCM" as const,
    cipherKeyVersion: 1,
    secretIssuedAt: new Date(),
    ...overrides,
  };
}

describe("a destination has to be the right shape", () => {
  let mine: World;

  beforeEach(async () => {
    await resetDatabase();
    mine = await build("Integrity café");
  });

  it("accepts a well-formed destination", async () => {
    const row = await prisma.webhookDestination.create({ data: destinationData(mine), select: { id: true } });
    expect(row.id).toBeTruthy();
  });

  it("refuses one created already enabled", async () => {
    // The screen says "begins disabled"; this is the layer that cannot be bypassed.
    await expect(
      prisma.webhookDestination.create({ data: destinationData(mine, { state: "ENABLED" }) }),
    ).rejects.toThrow(REFUSED);
  });

  it("refuses a plaintext URL in the ciphertext column", async () => {
    /*
     * The CHECK that makes an accident impossible rather than merely unlikely: a plaintext URL
     * cannot satisfy the four-part base64url shape, so there is no path by which one gets stored.
     */
    for (const bad of ["https://hooks.example.org/hook", "", "v1.short.short.x", "notacipher"]) {
      await expect(
        prisma.webhookDestination.create({ data: destinationData(mine, { endpointCipher: bad }) }),
        bad,
      ).rejects.toThrow(/check constraint|Webhook/i);
    }
  });

  it("refuses a plaintext signing secret the same way", async () => {
    await expect(
      prisma.webhookDestination.create({ data: destinationData(mine, { signingSecretCipher: "hunter2" }) }),
    ).rejects.toThrow(/check constraint|Webhook/i);
  });

  it("refuses a truncated nonce or tag", async () => {
    // Exact lengths, because a shortened tag is how an authenticated cipher stops authenticating.
    const good = encryptSecret("https://hooks.example.org/hook").split(".");
    const shortNonce = [good[0], good[1].slice(0, 12), good[2], good[3]].join(".");
    const shortTag = [good[0], good[1], good[2].slice(0, 18), good[3]].join(".");
    for (const bad of [shortNonce, shortTag]) {
      await expect(
        prisma.webhookDestination.create({ data: destinationData(mine, { endpointCipher: bad }) }),
      ).rejects.toThrow(/check constraint|Webhook/i);
    }
  });

  it("refuses a URL, a scheme or an IP literal in the host column", async () => {
    for (const bad of ["https://hooks.example.org", "10.0.0.1", "localhost", "HOOKS.EXAMPLE.ORG", ""]) {
      await expect(
        prisma.webhookDestination.create({ data: destinationData(mine, { endpointHost: bad }) }),
        JSON.stringify(bad),
      ).rejects.toThrow(/check constraint|Webhook/i);
    }
  });

  it("refuses a key version that is not a counter", async () => {
    for (const bad of [0, -1]) {
      await expect(
        prisma.webhookDestination.create({ data: destinationData(mine, { cipherKeyVersion: bad }) }),
      ).rejects.toThrow(/check constraint|Webhook/i);
    }
  });
});

describe("a destination's identity is frozen and it is never removed", () => {
  let mine: World;

  beforeEach(async () => {
    await resetDatabase();
    mine = await build("Frozen café");
  });

  it("refuses a changed endpoint, host, digest or business", async () => {
    /*
     * A URL that could be edited under a live destination would redirect an existing stream of a
     * merchant's activity somewhere else, without a new decision by anybody.
     */
    const other = await build("Other café");
    for (const data of [
      { endpointCipher: encryptSecret("https://elsewhere.example.com/hook") },
      { endpointHost: "elsewhere.example.com" },
      { endpointDigest: randomBytes(32).toString("hex") },
      { businessId: other.cafe.businessId },
    ]) {
      await expect(
        prisma.webhookDestination.update({ where: { id: mine.destinationId }, data }),
        JSON.stringify(Object.keys(data)),
      ).rejects.toThrow(REFUSED);
    }
  });

  it("refuses an illegal state transition, and revoking is terminal", async () => {
    await prisma.webhookDestination.update({ where: { id: mine.destinationId }, data: { state: "REVOKED" } });
    for (const state of ["ENABLED", "DISABLED"] as const) {
      await expect(
        prisma.webhookDestination.update({ where: { id: mine.destinationId }, data: { state } }),
        state,
      ).rejects.toThrow(REFUSED);
    }
  });

  it("refuses editing a revoked destination's name or secret", async () => {
    await prisma.webhookDestination.update({ where: { id: mine.destinationId }, data: { state: "REVOKED" } });
    await expect(
      prisma.webhookDestination.update({ where: { id: mine.destinationId }, data: { name: "Renamed" } }),
    ).rejects.toThrow(REFUSED);
  });

  it("refuses a rotated secret without a new disclosure time, and the reverse", async () => {
    /*
     * The two move together or not at all. A rotated secret with an old disclosure time would be a
     * row claiming the owner saw a value they never did.
     */
    await expect(
      prisma.webhookDestination.update({
        where: { id: mine.destinationId },
        data: { signingSecretCipher: encryptSecret("new") },
      }),
    ).rejects.toThrow(/move together/);

    await expect(
      prisma.webhookDestination.update({
        where: { id: mine.destinationId },
        data: { secretIssuedAt: new Date(Date.now() + 1000) },
      }),
    ).rejects.toThrow(/move together/);

    // Together, it works.
    await expect(
      prisma.webhookDestination.update({
        where: { id: mine.destinationId },
        data: { signingSecretCipher: encryptSecret("new"), secretIssuedAt: new Date() },
      }),
    ).resolves.toBeTruthy();
  });

  it("is never deleted, by the app or by the owner", async () => {
    await expect(prisma.webhookDestination.delete({ where: { id: mine.destinationId } })).rejects.toThrow(
      REFUSED_OR_DENIED,
    );
    const owner = migratorPrisma();
    await expect(owner.webhookDestination.delete({ where: { id: mine.destinationId } })).rejects.toThrow(
      /never removed/i,
    );
    await expect(owner.$executeRawUnsafe('TRUNCATE TABLE "WebhookDestination" CASCADE')).rejects.toThrow(
      /never removed/i,
    );
  });
});

describe("a delivery cannot cross a tenant or start as done", () => {
  let mine: World;
  let theirs: World;

  beforeEach(async () => {
    await resetDatabase();
    mine = await build("Delivery café");
    theirs = await build("Another café", "hooks.other.example.com");
    session.userId = mine.cafe.userId;
  });

  function deliveryData(overrides: Record<string, unknown> = {}) {
    return {
      businessId: mine.cafe.businessId,
      destinationId: mine.destinationId,
      isTest: true,
      nextAttemptAt: new Date(),
      ...overrides,
    };
  }

  it("accepts a well-formed test delivery", async () => {
    const row = await prisma.webhookDelivery.create({ data: deliveryData(), select: { id: true } });
    expect(row.id).toBeTruthy();
  });

  it("refuses another business's destination", async () => {
    /*
     * The cross-tenant rule, and the reason it is a trigger: both ids exist and both foreign keys
     * are satisfied by a row that would send one merchant's activity to another's endpoint.
     */
    await expect(
      prisma.webhookDelivery.create({ data: deliveryData({ destinationId: theirs.destinationId }) }),
    ).rejects.toThrow(/different business/);
  });

  it("refuses a revoked destination", async () => {
    await prisma.webhookDestination.update({ where: { id: mine.destinationId }, data: { state: "REVOKED" } });
    await expect(prisma.webhookDelivery.create({ data: deliveryData() })).rejects.toThrow(/revoked/);
  });

  it("refuses a real delivery to a destination that is not enabled", async () => {
    // What "begins disabled" has to mean at the layer that cannot be bypassed.
    const event = await eventFor(mine);
    await prisma.webhookDestination.update({ where: { id: mine.destinationId }, data: { state: "DISABLED" } });
    await expect(
      prisma.webhookDelivery.create({ data: deliveryData({ isTest: false, integrationEventId: event }) }),
    ).rejects.toThrow(/not enabled/);
  });

  it("refuses a delivery that is both a test and an event, or neither", async () => {
    const event = await eventFor(mine);
    await expect(
      prisma.webhookDelivery.create({ data: deliveryData({ isTest: true, integrationEventId: event }) }),
    ).rejects.toThrow(/check constraint|Webhook/i);
    await expect(
      prisma.webhookDelivery.create({ data: deliveryData({ isTest: false, integrationEventId: null }) }),
    ).rejects.toThrow(/check constraint|Webhook/i);
  });

  it("refuses one created already delivered or already attempted", async () => {
    for (const data of [{ status: "DELIVERED" as const }, { attemptCount: 3 }, { settledAt: new Date() }]) {
      await expect(prisma.webhookDelivery.create({ data: deliveryData(data) }), JSON.stringify(data)).rejects.toThrow(
        REFUSED,
      );
    }
  });

  it("allows only one delivery per destination per event", async () => {
    const event = await eventFor(mine);
    await prisma.webhookDelivery.create({ data: deliveryData({ isTest: false, integrationEventId: event }) });
    await expect(
      prisma.webhookDelivery.create({ data: deliveryData({ isTest: false, integrationEventId: event }) }),
    ).rejects.toThrow(/Unique constraint|duplicate key/i);
  });
});

describe("delivery state moves one way, and never lies", () => {
  let mine: World;
  let deliveryId: string;

  beforeEach(async () => {
    await resetDatabase();
    mine = await build("State café");
    deliveryId = (
      await prisma.webhookDelivery.create({
        data: { businessId: mine.cafe.businessId, destinationId: mine.destinationId, isTest: true, nextAttemptAt: new Date() },
        select: { id: true },
      })
    ).id;
  });

  it("refuses a changed identity", async () => {
    const other = await build("Other café", "hooks.other.example.com");
    for (const data of [
      { destinationId: other.destinationId },
      { businessId: other.cafe.businessId },
      { isTest: false },
    ]) {
      await expect(
        prisma.webhookDelivery.update({ where: { id: deliveryId }, data }),
        JSON.stringify(Object.keys(data)),
      ).rejects.toThrow(REFUSED);
    }
  });

  it("refuses an attempt count that goes down, or jumps", async () => {
    // A counter that could be rewritten is a retry cap that is not a cap.
    await prisma.webhookDelivery.update({ where: { id: deliveryId }, data: { attemptCount: 1 } });
    await expect(
      prisma.webhookDelivery.update({ where: { id: deliveryId }, data: { attemptCount: 0 } }),
    ).rejects.toThrow(/cannot go down/);
    await expect(
      prisma.webhookDelivery.update({ where: { id: deliveryId }, data: { attemptCount: 5 } }),
    ).rejects.toThrow(/one at a time/);
  });

  it("refuses a second move once settled", async () => {
    await prisma.webhookDelivery.update({
      where: { id: deliveryId },
      data: { status: "DELIVERED", settledAt: new Date(), nextAttemptAt: null, lastHttpStatus: 200 },
    });
    await expect(
      prisma.webhookDelivery.update({ where: { id: deliveryId }, data: { status: "PENDING" } }),
    ).rejects.toThrow(/rest state/);
  });

  it("refuses DELIVERED carrying an error class or a non-2xx status", async () => {
    /*
     * The rule a bug would most plausibly break, and the one the brief names explicitly: a timeout
     * or a network error is NEVER delivered.
     */
    await expect(
      prisma.webhookDelivery.update({
        where: { id: deliveryId },
        data: { status: "DELIVERED", settledAt: new Date(), nextAttemptAt: null, lastErrorClass: "TIMEOUT", lastHttpStatus: 200 },
      }),
    ).rejects.toThrow(/carries no error class/);

    await expect(
      prisma.webhookDelivery.update({
        where: { id: deliveryId },
        data: { status: "DELIVERED", settledAt: new Date(), nextAttemptAt: null, lastHttpStatus: 500 },
      }),
    ).rejects.toThrow(/answered 2xx/);

    await expect(
      prisma.webhookDelivery.update({
        where: { id: deliveryId },
        data: { status: "DELIVERED", settledAt: new Date(), nextAttemptAt: null, lastHttpStatus: null },
      }),
    ).rejects.toThrow(/answered 2xx/);
  });

  it("refuses an unsafe address retried to exhaustion", async () => {
    // An unsafe address is permanent by definition; it settles REFUSED, never FAILED.
    await expect(
      prisma.webhookDelivery.update({
        where: { id: deliveryId },
        data: { status: "FAILED", settledAt: new Date(), nextAttemptAt: null, lastErrorClass: "UNSAFE_ADDRESS" },
      }),
    ).rejects.toThrow(/never retried to exhaustion/);
  });

  it("refuses a settled delivery that is still due, or a pending one that is settled", async () => {
    await expect(
      prisma.webhookDelivery.update({
        where: { id: deliveryId },
        data: { status: "REFUSED", settledAt: new Date(), nextAttemptAt: new Date(), lastErrorClass: "TLS" },
      }),
    ).rejects.toThrow(/no next attempt/);

    await expect(
      prisma.webhookDelivery.update({ where: { id: deliveryId }, data: { settledAt: new Date() } }),
    ).rejects.toThrow(/not settled/);
  });

  it("is never deleted", async () => {
    await expect(prisma.webhookDelivery.delete({ where: { id: deliveryId } })).rejects.toThrow(REFUSED_OR_DENIED);
    await expect(migratorPrisma().webhookDelivery.delete({ where: { id: deliveryId } })).rejects.toThrow(
      /never removed/i,
    );
  });
});

describe("an attempt is append-only and has to match its delivery", () => {
  let mine: World;
  let deliveryId: string;

  beforeEach(async () => {
    await resetDatabase();
    mine = await build("Attempt café");
    deliveryId = (
      await prisma.webhookDelivery.create({
        data: { businessId: mine.cafe.businessId, destinationId: mine.destinationId, isTest: true, nextAttemptAt: new Date() },
        select: { id: true },
      })
    ).id;
    await prisma.webhookDelivery.update({ where: { id: deliveryId }, data: { attemptCount: 1 } });
  });

  function attemptData(overrides: Record<string, unknown> = {}) {
    return {
      businessId: mine.cafe.businessId,
      deliveryId,
      attemptNumber: 1,
      outcome: "DELIVERED" as const,
      errorClass: "NONE" as const,
      httpStatus: 200,
      ...overrides,
    };
  }

  it("accepts an attempt numbered to follow the delivery", async () => {
    const row = await prisma.webhookDeliveryAttempt.create({ data: attemptData(), select: { id: true } });
    expect(row.id).toBeTruthy();
  });

  it("refuses an attempt number that does not follow the delivery's count", async () => {
    // Writing attempt 7 against a delivery that has made one is rewriting history.
    for (const attemptNumber of [2, 7]) {
      await expect(
        prisma.webhookDeliveryAttempt.create({ data: attemptData({ attemptNumber }) }),
        String(attemptNumber),
      ).rejects.toThrow(/does not follow/);
    }
  });

  it("refuses another business's delivery", async () => {
    const theirs = await build("Other café", "hooks.other.example.com");
    await expect(
      prisma.webhookDeliveryAttempt.create({ data: attemptData({ businessId: theirs.cafe.businessId }) }),
    ).rejects.toThrow(/different business/);
  });

  it("refuses an outcome and an error class that disagree", async () => {
    await expect(
      prisma.webhookDeliveryAttempt.create({ data: attemptData({ outcome: "DELIVERED", errorClass: "TIMEOUT" }) }),
    ).rejects.toThrow(/carries no error class/);
    await expect(
      prisma.webhookDeliveryAttempt.create({ data: attemptData({ outcome: "RETRYABLE", errorClass: "NONE" }) }),
    ).rejects.toThrow(/says why/);
  });

  it("refuses an unsafe address classified as retryable", async () => {
    await expect(
      prisma.webhookDeliveryAttempt.create({ data: attemptData({ outcome: "RETRYABLE", errorClass: "UNSAFE_ADDRESS" }) }),
    ).rejects.toThrow(/is permanent/);
  });

  it("assigns the attempt time itself", async () => {
    const supplied = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000);
    const row = await prisma.webhookDeliveryAttempt.create({
      data: attemptData({ attemptedAt: supplied }),
      select: { attemptedAt: true },
    });
    expect(row.attemptedAt.getTime()).not.toBe(supplied.getTime());
    expect(Math.abs(row.attemptedAt.getTime() - Date.now())).toBeLessThan(60_000);
  });

  it("refuses UPDATE, DELETE and TRUNCATE, for the runtime role and the owner alike", async () => {
    const id = (await prisma.webhookDeliveryAttempt.create({ data: attemptData(), select: { id: true } })).id;
    await expect(
      prisma.webhookDeliveryAttempt.update({ where: { id }, data: { httpStatus: 500 } }),
    ).rejects.toThrow(REFUSED_OR_DENIED);
    await expect(prisma.webhookDeliveryAttempt.delete({ where: { id } })).rejects.toThrow(REFUSED_OR_DENIED);

    const owner = migratorPrisma();
    await expect(owner.webhookDeliveryAttempt.update({ where: { id }, data: { httpStatus: 500 } })).rejects.toThrow(
      /append-only/i,
    );
    await expect(owner.$executeRawUnsafe('TRUNCATE TABLE "WebhookDeliveryAttempt"')).rejects.toThrow(/append-only/i);
  });
});

describe("least privilege, asked as the runtime role itself", () => {
  it("holds SELECT and INSERT on the attempt table, and no more", async () => {
    const [p] = await prisma.$queryRawUnsafe<Record<string, boolean>[]>(
      `SELECT has_table_privilege('"WebhookDeliveryAttempt"', 'SELECT')   AS s,
              has_table_privilege('"WebhookDeliveryAttempt"', 'INSERT')   AS i,
              has_table_privilege('"WebhookDeliveryAttempt"', 'UPDATE')   AS u,
              has_table_privilege('"WebhookDeliveryAttempt"', 'DELETE')   AS d,
              has_table_privilege('"WebhookDeliveryAttempt"', 'TRUNCATE') AS t`,
    );
    expect({ ...p }).toEqual({ s: true, i: true, u: false, d: false, t: false });
  });

  it("holds UPDATE but never DELETE on the destination and the delivery", async () => {
    // Both genuinely change state, so UPDATE is unavoidable; what it may become is the trigger's
    // job. Neither may be removed, because what a business sent and to whom is part of the record.
    for (const table of ["WebhookDestination", "WebhookDelivery"]) {
      const [p] = await prisma.$queryRawUnsafe<Record<string, boolean>[]>(
        `SELECT has_table_privilege('"${table}"', 'SELECT')   AS s,
                has_table_privilege('"${table}"', 'INSERT')   AS i,
                has_table_privilege('"${table}"', 'UPDATE')   AS u,
                has_table_privilege('"${table}"', 'DELETE')   AS d,
                has_table_privilege('"${table}"', 'TRUNCATE') AS t`,
      );
      expect({ ...p }, table).toEqual({ s: true, i: true, u: true, d: false, t: false });
    }
  });
});

describe("the tables have nowhere to put anything sensitive", () => {
  it("has exactly the columns it should, and no JSON anywhere", async () => {
    const expected: Record<string, string[]> = {
      WebhookDestination: [
        "businessId", "cipherAlgorithm", "cipherKeyVersion", "createdAt", "createdByUserId",
        "endpointCipher", "endpointDigest", "endpointHost", "id", "name", "secretIssuedAt",
        "signingSecretCipher", "state", "updatedAt",
      ],
      WebhookDelivery: [
        "attemptCount", "businessId", "claimToken", "claimedAt", "createdAt", "destinationId", "id",
        "integrationEventId", "isTest", "lastAttemptAt", "lastErrorClass", "lastHttpStatus",
        "lastOutcome", "leaseExpiresAt", "nextAttemptAt", "settledAt", "status",
      ],
      WebhookDeliveryAttempt: [
        "attemptNumber", "attemptedAt", "businessId", "createdAt", "deliveryId", "errorClass",
        "httpStatus", "id", "outcome",
      ],
    };

    for (const [table, columns] of Object.entries(expected)) {
      const rows = await migratorPrisma().$queryRawUnsafe<{ column_name: string; data_type: string }[]>(
        `SELECT column_name, data_type FROM information_schema.columns
          WHERE table_name = '${table}' ORDER BY column_name`,
      );
      expect(rows.map((r) => r.column_name), table).toEqual(columns);
      expect(rows.map((r) => r.data_type), table).not.toContain("jsonb");
      expect(rows.map((r) => r.data_type), table).not.toContain("json");
    }
  });

  it("has no column that could hold a response, a header, a raw URL or a customer", async () => {
    /*
     * Typed columns and no JSON bag means a response body cannot be added at two in the morning by
     * somebody debugging a delivery failure — they would have to write a migration, which is a
     * thing a person reviews.
     *
     * `endpointCipher` and `signingSecretCipher` are exempt by name: they are the ciphertext this
     * design is built around, and the CHECK constraints above prove they cannot hold plaintext.
     */
    const EXEMPT = new Set([
      "endpointCipher",
      "signingSecretCipher",
      "endpointHost",
      "endpointDigest",
      // A timestamp recording WHEN the secret was shown. It holds no secret, and naming it
      // anything else would make the column worse to read in order to satisfy a regex.
      "secretIssuedAt",
      /*
       * A lease identifier: a uuid naming which pass holds a row, checked into that shape by a
       * CHECK constraint. It is a "token" only in the sense that a cloakroom ticket is — it grants
       * nothing and means nothing outside this table, and the constraint above proves nothing
       * longer than a uuid can be stored in it.
       */
      "claimToken",
    ]);
    /*
     * `name` on its own is exempt by construction: it is the OWNER's label for their own
     * destination, typed by them, shown only to them. What the pattern is looking for is a
     * PERSON's name, so it names those forms instead of matching every column ending in "name" —
     * which is the difference between a rule and a tripwire.
     */
    const FORBIDDEN =
      /phone|email|(customer|first|last|full|contact|holder)Name|address|body|header|response|request|payload|metadata|config|secret|token|password|url|endpoint|error(Message|Text)|amount|price|currency|total|balance|points|stamps|reward|coupon|card|wallet/i;

    for (const table of ["WebhookDestination", "WebhookDelivery", "WebhookDeliveryAttempt"]) {
      const rows = await migratorPrisma().$queryRawUnsafe<{ column_name: string }[]>(
        `SELECT column_name FROM information_schema.columns WHERE table_name = '${table}'`,
      );
      for (const { column_name } of rows) {
        if (EXEMPT.has(column_name)) continue;
        expect(column_name, `${table}.${column_name}`).not.toMatch(FORBIDDEN);
      }
    }
  });
});

/**
 * An `IntegrationEvent` for this caf\u00e9, written the way Prompt 1's trigger requires.
 *
 * That trigger insists the event's `occurredAt` equals the redemption's `recordedAt`, which is true
 * only inside one transaction \u2014 so the promotion, the redemption and the event are created
 * together here, exactly as the service does it. A helper that reached for the migrator to dodge the
 * rule would be a helper that made the rest of this file prove less.
 */
async function eventFor(w: World): Promise<string> {
  const customer = await enrolCustomer(w.cafe, { phone: uniqueSyrianPhone(), firstName: "\u0644\u064a\u0644\u0649" });
  const salt = newCodeSalt();
  const promotion = await prisma.promotion.create({
    data: {
      businessId: w.cafe.businessId,
      name: `Offer ${Math.random().toString(36).slice(2, 8)}`,
      normalizedName: Math.random().toString(36).slice(2, 8),
      benefitDescription: "A free espresso",
      codeDigest: codeDigest(salt, w.cafe.businessId, "AUTUMN10"),
      codeSalt: salt,
    },
    select: { id: true },
  });
  await prisma.promotion.update({ where: { id: promotion.id }, data: { state: "ACTIVE" } });

  return prisma.$transaction(async (tx) => {
    const redemption = await tx.promotionRedemption.create({
      data: {
        businessId: w.cafe.businessId,
        promotionId: promotion.id,
        entry: "REDEEMED",
        customerCardId: customer.customerCardId,
        customerBusinessProfileId: customer.customerBusinessProfileId,
        method: "COUNTER_TYPED_CODE",
      },
      select: { id: true },
    });
    const event = await tx.integrationEvent.create({
      data: {
        businessId: w.cafe.businessId,
        envelopeVersion: 1,
        eventType: "PROMOTION_REDEMPTION_RECORDED",
        entityType: "PROMOTION_REDEMPTION",
        entityId: redemption.id,
      },
      select: { id: true },
    });
    return event.id;
  });
}

describe("the lease cannot be forged", () => {
  let mine: World;
  let deliveryId: string;

  beforeEach(async () => {
    await resetDatabase();
    mine = await build("Lease caf\u00e9");
    deliveryId = (
      await prisma.webhookDelivery.create({
        data: { businessId: mine.cafe.businessId, destinationId: mine.destinationId, isTest: true, nextAttemptAt: new Date() },
        select: { id: true },
      })
    ).id;
  });

  const token = () => randomUUID();

  it("refuses a delivery created already claimed", async () => {
    const now = new Date();
    await expect(
      prisma.webhookDelivery.create({
        data: {
          businessId: mine.cafe.businessId,
          destinationId: mine.destinationId,
          isTest: true,
          nextAttemptAt: now,
          claimedAt: now,
          leaseExpiresAt: new Date(now.getTime() + 1000),
          claimToken: token(),
        },
      }),
    ).rejects.toThrow(/unclaimed/);
  });

  it("refuses a half-set lease, in every combination", async () => {
    // A lease missing one of its three columns is a row nobody can reason about.
    const now = new Date();
    for (const data of [
      { claimedAt: now },
      { leaseExpiresAt: now },
      { claimToken: token() },
      { claimedAt: now, leaseExpiresAt: new Date(now.getTime() + 1000) },
      { claimedAt: now, claimToken: token() },
    ]) {
      await expect(
        prisma.webhookDelivery.update({ where: { id: deliveryId }, data }),
        JSON.stringify(Object.keys(data)),
      ).rejects.toThrow(/check constraint|Webhook/i);
    }
  });

  it("refuses a lease that expires before it starts", async () => {
    const now = new Date();
    await expect(
      prisma.webhookDelivery.update({
        where: { id: deliveryId },
        data: { claimedAt: now, leaseExpiresAt: new Date(now.getTime() - 1000), claimToken: token() },
      }),
    ).rejects.toThrow(/check constraint|Webhook/i);
  });

  it("refuses a claim token that is not a uuid", async () => {
    // Nothing longer fits, so nothing longer can be smuggled into the lease.
    const now = new Date();
    for (const bad of ["not-a-uuid", "https://hooks.example.com/x", "a".repeat(64), ""]) {
      await expect(
        prisma.webhookDelivery.update({
          where: { id: deliveryId },
          data: { claimedAt: now, leaseExpiresAt: new Date(now.getTime() + 1000), claimToken: bad },
        }),
        JSON.stringify(bad),
      ).rejects.toThrow(/check constraint|Webhook/i);
    }
  });

  it("accepts a well-formed lease, and releasing it", async () => {
    const now = new Date();
    await expect(
      prisma.webhookDelivery.update({
        where: { id: deliveryId },
        data: { claimedAt: now, leaseExpiresAt: new Date(now.getTime() + 1000), claimToken: token() },
      }),
    ).resolves.toBeTruthy();
    await expect(
      prisma.webhookDelivery.update({
        where: { id: deliveryId },
        data: { claimedAt: null, leaseExpiresAt: null, claimToken: null },
      }),
    ).resolves.toBeTruthy();
  });

  it("refuses a settled delivery that still holds a claim", async () => {
    const now = new Date();
    await expect(
      prisma.webhookDelivery.update({
        where: { id: deliveryId },
        data: {
          status: "DELIVERED",
          settledAt: now,
          nextAttemptAt: null,
          lastHttpStatus: 200,
          attemptCount: 1,
          claimedAt: now,
          leaseExpiresAt: new Date(now.getTime() + 1000),
          claimToken: token(),
        },
      }),
    ).rejects.toThrow(/holds no claim/);
  });
});

describe("the retry cap is the database's, not only the code's", () => {
  let mine: World;
  let deliveryId: string;

  beforeEach(async () => {
    await resetDatabase();
    mine = await build("Cap caf\u00e9");
    deliveryId = (
      await prisma.webhookDelivery.create({
        data: { businessId: mine.cafe.businessId, destinationId: mine.destinationId, isTest: true, nextAttemptAt: new Date() },
        select: { id: true },
      })
    ).id;
  });

  it("refuses an attempt count past the ceiling", async () => {
    // Walk it up to the cap one at a time, which is the only way the trigger allows.
    for (let n = 1; n <= 5; n += 1) {
      await prisma.webhookDelivery.update({
        where: { id: deliveryId },
        data:
          n === 5
            ? { attemptCount: n, status: "FAILED", settledAt: new Date(), nextAttemptAt: null, lastErrorClass: "TIMEOUT" }
            : { attemptCount: n },
      });
    }
    // And the sixth is refused by the CHECK, even for a settled row.
    await expect(
      migratorPrisma().$executeRawUnsafe('UPDATE "WebhookDelivery" SET "attemptCount" = 6 WHERE "id" = $1', deliveryId),
    ).rejects.toThrow(/check constraint|Webhook/i);
  });

  it("refuses a delivery left PENDING at the cap", async () => {
    // A row the worker would pick up forever.
    for (let n = 1; n <= 4; n += 1) {
      await prisma.webhookDelivery.update({ where: { id: deliveryId }, data: { attemptCount: n } });
    }
    await expect(
      prisma.webhookDelivery.update({ where: { id: deliveryId }, data: { attemptCount: 5 } }),
    ).rejects.toThrow(/at the attempt cap is settled/);
  });
});

describe("the permanent and retryable classes are the database's rules too", () => {
  let mine: World;
  let deliveryId: string;

  beforeEach(async () => {
    await resetDatabase();
    mine = await build("Class caf\u00e9");
    deliveryId = (
      await prisma.webhookDelivery.create({
        data: { businessId: mine.cafe.businessId, destinationId: mine.destinationId, isTest: true, nextAttemptAt: new Date() },
        select: { id: true },
      })
    ).id;
    await prisma.webhookDelivery.update({ where: { id: deliveryId }, data: { attemptCount: 1 } });
  });

  function attemptData(overrides: Record<string, unknown> = {}) {
    return {
      businessId: mine.cafe.businessId,
      deliveryId,
      attemptNumber: 1,
      outcome: "PERMANENT" as const,
      errorClass: "CIPHERTEXT_INVALID" as const,
      ...overrides,
    };
  }

  it("refuses a permanent class recorded as retryable", async () => {
    for (const errorClass of ["UNSAFE_ADDRESS", "CIPHERTEXT_INVALID", "DESTINATION_NOT_ELIGIBLE"] as const) {
      await expect(
        prisma.webhookDeliveryAttempt.create({ data: attemptData({ errorClass, outcome: "RETRYABLE" }) }),
        errorClass,
      ).rejects.toThrow(/is permanent/);
    }
  });

  it("refuses an unavailable key recorded as permanent", async () => {
    /*
     * The rule that closes the gap this prompt was about. Recording a brief key outage as permanent
     * would quietly discard every queued webhook because a variable was unset for five minutes.
     */
    await expect(
      prisma.webhookDeliveryAttempt.create({
        data: attemptData({ errorClass: "ENCRYPTION_UNAVAILABLE", outcome: "PERMANENT" }),
      }),
    ).rejects.toThrow(/retryable, not permanent/);
  });

  it("accepts an unavailable key recorded as retryable", async () => {
    const row = await prisma.webhookDeliveryAttempt.create({
      data: attemptData({ errorClass: "ENCRYPTION_UNAVAILABLE", outcome: "RETRYABLE" }),
      select: { id: true },
    });
    expect(row.id).toBeTruthy();
  });

  it("refuses each permanent class retried to exhaustion", async () => {
    for (const lastErrorClass of ["UNSAFE_ADDRESS", "CIPHERTEXT_INVALID", "DESTINATION_NOT_ELIGIBLE"] as const) {
      await expect(
        prisma.webhookDelivery.update({
          where: { id: deliveryId },
          data: { status: "FAILED", settledAt: new Date(), nextAttemptAt: null, lastErrorClass },
        }),
        lastErrorClass,
      ).rejects.toThrow(/never retried to exhaustion/);
    }
  });
});
