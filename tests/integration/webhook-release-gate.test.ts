import { randomBytes } from "node:crypto";
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

import { POST as webhooksRoute } from "@/app/api/staff/webhooks/route";
import { prisma } from "@/server/db";
import { ConflictError } from "@/server/errors";
import { encryptSecret } from "@/server/integrations/webhooks/crypto";
import {
  createDestination,
  queueTestDelivery,
  setDestinationState,
} from "@/server/integrations/webhooks/destinations";
import { createStampCafe, migratorPrisma, resetDatabase, type StampCafeFixture } from "../setup/fixtures";

/**
 * Findings from the Phase 3B Prompt 3 release gate, held closed.
 *
 * ## The one that matters
 *
 * `queueTestDelivery` had no bound. A probe queued fifty in a row and every one was accepted and
 * left `PENDING`. On its own that is a row count; what made it a defect is the other half of the
 * design: `claimDue` takes ten rows a minute **across every business**, ordered by when they became
 * due, and a test delivery is created due **immediately**.
 *
 * So one owner's loop put an unbounded number of their own rows at the front of a queue every
 * tenant shares. Stated precisely, because the honest version is narrower than the alarming one:
 * nothing was exposed, no other tenant's delivery was marked failed, and a delivery that is never
 * claimed consumes no attempt. What the caller gained was **control over how long every other
 * business's webhooks wait** — without limit, and with no access beyond their own owner session.
 *
 * Closed in two places, as everything else in this feature is: the service refuses, and
 * `walaaplus_webhook_delivery_guard` refuses (migration 17), so it also holds against a writer
 * holding the runtime role directly.
 *
 * ## The two that were already true, and are now asserted
 *
 * The audit verified both by probe; neither had a permanent test, and both are claims this product
 * makes out loud. They are here so an upgrade cannot quietly falsify them.
 */

const HOST = "hooks.example.com";

let savedKey: string | undefined;
let cafe: StampCafeFixture;
let destinationId: string;

beforeAll(() => {
  savedKey = process.env.INTEGRATION_ENCRYPTION_KEY;
  process.env.INTEGRATION_ENCRYPTION_KEY = randomBytes(32).toString("hex");
});

afterAll(() => {
  if (savedKey === undefined) delete process.env.INTEGRATION_ENCRYPTION_KEY;
  else process.env.INTEGRATION_ENCRYPTION_KEY = savedKey;
});

beforeEach(async () => {
  await resetDatabase();
  cafe = await createStampCafe({ name: "Gate café" });
  session.userId = cafe.userId;
  const created = await createDestination(cafe.ctx, { name: "Ops", url: `https://${HOST}/hook` });
  destinationId = created.destination.id;
  await setDestinationState(cafe.ctx, destinationId, "ENABLED");
});

function pendingTests(): Promise<number> {
  return migratorPrisma().webhookDelivery.count({
    where: { businessId: cafe.businessId, isTest: true, status: "PENDING" },
  });
}

/** A test delivery written straight through the restricted runtime client, with no service. */
function insertTestDelivery() {
  return prisma.webhookDelivery.create({
    data: { businessId: cafe.businessId, destinationId, isTest: true, nextAttemptAt: new Date() },
    select: { id: true },
  });
}

describe("one owner cannot fill a queue every tenant shares", () => {
  it("accepts the first test and refuses the second, with a code the screen can use", async () => {
    const first = await queueTestDelivery(cafe.ctx, destinationId);
    expect(first.deliveryId).toBeTruthy();

    let thrown: ConflictError | undefined;
    try {
      await queueTestDelivery(cafe.ctx, destinationId);
    } catch (e) {
      thrown = e as ConflictError;
    }
    expect(thrown).toBeInstanceOf(ConflictError);
    expect(thrown?.code).toBe("WEBHOOK_TEST_PENDING");
    expect(thrown?.status).toBe(409);
    expect(await pendingTests()).toBe(1);
  });

  it("stays at one however many times it is called", async () => {
    // The probe that found this queued fifty. This is the same loop against the fixed code.
    let accepted = 0;
    for (let i = 0; i < 50; i += 1) {
      try {
        await queueTestDelivery(cafe.ctx, destinationId);
        accepted += 1;
      } catch {
        /* expected after the first */
      }
    }
    expect(accepted).toBe(1);
    expect(await pendingTests()).toBe(1);
  });

  it("allows another once the first has settled", async () => {
    /*
     * The bound is on what is WAITING, not on how many tests a destination may ever have. An owner
     * whose first test came back refused must be able to fix their server and try again.
     */
    await queueTestDelivery(cafe.ctx, destinationId);
    const row = await migratorPrisma().webhookDelivery.findFirstOrThrow({
      where: { businessId: cafe.businessId, isTest: true },
      select: { id: true },
    });
    await prisma.webhookDelivery.update({
      where: { id: row.id },
      data: { status: "REFUSED", settledAt: new Date(), nextAttemptAt: null, lastErrorClass: "HTTP_CLIENT_ERROR" },
    });

    const second = await queueTestDelivery(cafe.ctx, destinationId);
    expect(second.deliveryId).toBeTruthy();
    expect(await pendingTests()).toBe(1);
  });

  it("bounds each destination separately, so the ceiling is the destination limit", async () => {
    const other = await createDestination(cafe.ctx, { name: "Second", url: `https://${HOST}/other` });
    await setDestinationState(cafe.ctx, other.destination.id, "ENABLED");

    await queueTestDelivery(cafe.ctx, destinationId);
    await queueTestDelivery(cafe.ctx, other.destination.id);
    expect(await pendingTests()).toBe(2);

    // And neither destination will take a second.
    await expect(queueTestDelivery(cafe.ctx, destinationId)).rejects.toBeInstanceOf(ConflictError);
    await expect(queueTestDelivery(cafe.ctx, other.destination.id)).rejects.toBeInstanceOf(ConflictError);
    expect(await pendingTests()).toBe(2);
  });

  it("refuses a direct insert too, through the restricted runtime role", async () => {
    /*
     * The half that matters most. The service's check is a `count` followed by an insert, which two
     * concurrent callers could both pass; the trigger is what makes the rule true rather than
     * likely, and it is also what holds against a second service, a backfill script or a console
     * session holding the same runtime role.
     */
    await insertTestDelivery();
    await expect(insertTestDelivery()).rejects.toThrow(/a test is already queued for this destination/);
    expect(await pendingTests()).toBe(1);
  });

  it("refuses two concurrent inserts, which is what a count-then-insert cannot do alone", async () => {
    const results = await Promise.allSettled([insertTestDelivery(), insertTestDelivery()]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
    expect(await pendingTests()).toBe(1);
  });

  it("is conditioned on isTest, so a real delivery for the same destination is untouched", async () => {
    /*
     * The rule must not reach real deliveries. A real one is already unique per
     * (destination, event) by index, and refusing a second one here would drop an event nobody
     * could get back.
     *
     * Read from the LIVE function rather than the migration file, which could have been edited
     * without being applied. The behavioural half — real deliveries continuing to be created,
     * claimed and sent alongside test ones — is `webhook-delivery.test.ts`, which builds them from
     * real redemptions and would fail loudly if this rule caught them.
     */
    await insertTestDelivery();
    const rows = await migratorPrisma().$queryRaw<{ def: string }[]>`
      SELECT pg_get_functiondef(p.oid) AS def
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'walaaplus_webhook_delivery_guard'
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0].def).toContain('IF NEW."isTest" AND EXISTS');
    expect(rows[0].def).toContain("a test is already queued for this destination");
  });

  it("answers 409 with that code at the route, and creates nothing extra", async () => {
    const call = () =>
      webhooksRoute(
        new Request("http://localhost:3000/api/staff/webhooks", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "test", businessId: cafe.businessId, destinationId }),
        }),
      );
    // The route answers 202: the work is accepted and queued, not done.
    expect((await call()).status).toBe(202);
    const second = await call();
    expect(second.status).toBe(409);
    const body = (await second.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe("WEBHOOK_TEST_PENDING");
    expect(await pendingTests()).toBe(1);
  });
});

describe("two claims this product makes out loud, asserted rather than assumed", () => {
  it("keeps the migration history out of the runtime role's reach entirely", async () => {
    /*
     * `scripts/db-roles.mjs` prints "no access to [_prisma_migrations]" on every deployment. That
     * sentence is a claim about the grants, and nothing was checking it for this table.
     *
     * It matters beyond tidiness: a runtime role that could empty that table would make the next
     * `prisma migrate deploy` refuse to run against a schema it could no longer recognise.
     */
    for (const sql of [
      "SELECT count(*) FROM _prisma_migrations",
      "DELETE FROM _prisma_migrations",
      "TRUNCATE _prisma_migrations",
      "DROP TABLE _prisma_migrations",
    ]) {
      await expect(prisma.$executeRawUnsafe(sql), sql).rejects.toThrow(/permission denied|must be owner/);
    }
  });

  it("never echoes a ciphertext or a plaintext URL back in a database refusal", async () => {
    /*
     * Every refusal in this feature is designed to say a fixed sentence. The one path that is NOT
     * ours to design is the driver's: a rejected write is reported by Prisma, and if its message
     * quoted the row being written, an endpoint ciphertext - or the path token inside it - would
     * reach a log the moment a constraint fired.
     *
     * Verified rather than assumed, because it is a property of Prisma's error formatting and an
     * upgrade could change it.
     */
    const url = `https://${HOST}/SECRET-PATH?token=SECRET-TOKEN-VALUE`;
    const cipher = encryptSecret(url);
    const secretCipher = encryptSecret("SIGNING-SECRET-VALUE");
    let message = "";
    try {
      await prisma.webhookDestination.create({
        data: {
          businessId: cafe.businessId,
          name: "Refused",
          endpointHost: HOST,
          endpointDigest: randomBytes(32).toString("hex"),
          endpointCipher: cipher,
          signingSecretCipher: secretCipher,
          cipherAlgorithm: "AES_256_GCM",
          cipherKeyVersion: 1,
          secretIssuedAt: new Date(),
          // Illegal: a destination may not be created already enabled.
          state: "ENABLED",
        },
      });
    } catch (e) {
      message = (e as Error).message;
    }

    expect(message).toContain("a new destination starts disabled");
    for (const fragment of [cipher, cipher.slice(0, 24), secretCipher, secretCipher.slice(0, 24), "SECRET-PATH", "SECRET-TOKEN-VALUE", url]) {
      expect(message, fragment.slice(0, 24)).not.toContain(fragment);
    }
  });
});
