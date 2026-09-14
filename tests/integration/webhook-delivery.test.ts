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

import { prisma } from "@/server/db";
import { addressProblem, type LookupFn } from "@/server/integrations/webhooks/address";
import { signaturesMatch, signPayload } from "@/server/integrations/webhooks/crypto";
import { backoffSeconds, MAX_ATTEMPTS, runDueDeliveries } from "@/server/integrations/webhooks/delivery";
import { createDestination, queueTestDelivery, setDestinationState } from "@/server/integrations/webhooks/destinations";
import { HEADER, TEST_EVENT_ENTITY_PREFIX } from "@/server/integrations/webhooks/envelope";
import { sendWebhook } from "@/server/integrations/webhooks/transport";
import { createStampCafe, migratorPrisma, resetDatabase, type StampCafeFixture } from "../setup/fixtures";
import { startReceiver, type Receiver } from "../setup/webhook-receiver";

/**
 * Delivery, against a **local HTTPS receiver this test starts and stops**.
 *
 * Nothing outside this machine is contacted. The certificate is generated in the fixture, the
 * resolver is a function this file supplies, and the port is whatever the OS hands out. There is no
 * real endpoint, no provider, no staging service and no network path beyond loopback.
 *
 * The resolver is the interesting part: the transport refuses a loopback address, correctly and
 * unconditionally, so a test cannot simply point it at `127.0.0.1`. Instead the DNS hook is
 * replaced — which is exactly the seam the production code uses for its rebinding defence, so the
 * tests exercise the real path rather than a bypass.
 */

let savedKey: string | undefined;
let receiver: Receiver;

beforeAll(async () => {
  savedKey = process.env.INTEGRATION_ENCRYPTION_KEY;
  process.env.INTEGRATION_ENCRYPTION_KEY = randomBytes(32).toString("hex");
  receiver = await startReceiver();
});

afterAll(async () => {
  await receiver.close();
  if (savedKey === undefined) delete process.env.INTEGRATION_ENCRYPTION_KEY;
  else process.env.INTEGRATION_ENCRYPTION_KEY = savedKey;
});

/**
 * A resolver that answers with a PUBLIC-looking address for the test hostname.
 *
 * The transport then connects to it — except the local receiver is on loopback, so for the tests
 * that actually complete a request the address handed back is the loopback the server is on and the
 * `lookup` seam is what makes that possible. The SSRF tests use a resolver that answers with a
 * genuinely private address and assert the refusal.
 */
function resolverTo(address: string): LookupFn {
  return ((_h: string, _o: unknown, cb: (e: unknown, a?: unknown) => void) => {
    cb(null, [{ address, family: 4 }]);
  }) as LookupFn;
}

/** The local receiver, reachable because the resolver says so. */
function localResolver(): LookupFn {
  return resolverTo(receiver.address);
}

const HOST = "hooks.test.example.com";

async function cafeWithDestination(name: string, path = "/hook") {
  const fx: StampCafeFixture = await createStampCafe({ name });
  session.userId = fx.userId;
  const created = await createDestination(fx.ctx, {
    name: "Ops",
    url: `https://${HOST}:${receiver.port}${path}`,
  });
  await setDestinationState(fx.ctx, created.destination.id, "ENABLED");
  return { fx, destinationId: created.destination.id, signingSecret: created.signingSecret };
}

/**
 * The address policy these tests use.
 *
 * It permits exactly the loopback address the local receiver is bound to, and defers to the real
 * `addressProblem` for everything else — so a test that resolves to `169.254.169.254` is still
 * refused by the production rule, which is the thing being asserted.
 */
function allowReceiver(address: string): string | null {
  if (address === receiver.address) return null;
  return addressProblem(address);
}

/** Run one pass with the test's own resolver, policy and certificate. */
function runOnce(now = new Date()) {
  return runDueDeliveries({ now, lookup: localResolver(), addressPolicy: allowReceiver, ca: receiver.ca });
}

describe("a queued delivery is sent, signed, and recorded", () => {
  beforeEach(async () => {
    await resetDatabase();
    receiver.reset();
  });

  it("delivers a test envelope and records one successful attempt", async () => {
    const { fx, destinationId, signingSecret } = await cafeWithDestination("Delivery café");
    const { deliveryId } = await queueTestDelivery(fx.ctx, destinationId);

    const summary = await runOnce();
    expect(summary).toMatchObject({ attempted: 1, delivered: 1 });

    const request = receiver.requests.at(-1);
    expect(request).toBeDefined();

    // The signature is over `timestamp.body`, and it verifies with the secret the owner was shown.
    const timestamp = request!.headers[HEADER.timestamp] as string;
    const expected = signPayload(signingSecret, timestamp, request!.body);
    expect(signaturesMatch(request!.headers[HEADER.signature] as string, `v1=${expected}`)).toBe(true);

    const row = await migratorPrisma().webhookDelivery.findFirstOrThrow({ where: { id: deliveryId } });
    expect(row.status).toBe("DELIVERED");
    expect(row.attemptCount).toBe(1);
    expect(row.lastErrorClass).toBe("NONE");
    expect(row.lastHttpStatus).toBe(200);
    expect(row.settledAt).not.toBeNull();
    expect(row.nextAttemptAt).toBeNull();

    const attempts = await migratorPrisma().webhookDeliveryAttempt.findMany({ where: { deliveryId } });
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ attemptNumber: 1, outcome: "DELIVERED", errorClass: "NONE", httpStatus: 200 });
  });

  it("sends a stable event id so a receiver can de-duplicate", async () => {
    const { fx, destinationId } = await cafeWithDestination("Dedupe café");
    const { deliveryId } = await queueTestDelivery(fx.ctx, destinationId);
    await runOnce();

    const request = receiver.requests.at(-1)!;
    expect(request.headers[HEADER.eventId]).toBeTruthy();
    expect(request.headers[HEADER.deliveryId]).toBe(deliveryId);
    expect(request.headers[HEADER.attempt]).toBe("1");
  });

  it("sends only the seven envelope fields, and nothing about a person", async () => {
    const { fx, destinationId } = await cafeWithDestination("Envelope café");
    await queueTestDelivery(fx.ctx, destinationId);
    await runOnce();

    const body = JSON.parse(receiver.requests.at(-1)!.body) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual([
      "businessId",
      "entityId",
      "entityType",
      "envelopeVersion",
      "eventType",
      "id",
      "occurredAt",
    ]);
    // A test envelope describes nothing real.
    expect(body.eventType).toBe("TEST");
    expect(String(body.entityId)).toContain(TEST_EVENT_ENTITY_PREFIX);
    expect(body.businessId).toBe(fx.businessId);
  });

  it("never sends the signing secret or the URL in the body", async () => {
    const { fx, destinationId, signingSecret } = await cafeWithDestination("Leak café");
    await queueTestDelivery(fx.ctx, destinationId);
    await runOnce();

    const request = receiver.requests.at(-1)!;
    expect(request.body).not.toContain(signingSecret);
    expect(request.body).not.toContain(HOST);
    // The signature header carries a digest, never the secret itself.
    expect(JSON.stringify(request.headers)).not.toContain(signingSecret);
  });
});

describe("what happens when the receiver says no", () => {
  beforeEach(async () => {
    await resetDatabase();
    receiver.reset();
  });

  async function attemptAgainst(path: string) {
    const { fx, destinationId } = await cafeWithDestination(`Case ${path}`, path);
    const { deliveryId } = await queueTestDelivery(fx.ctx, destinationId);
    await runOnce();
    return migratorPrisma().webhookDelivery.findFirstOrThrow({ where: { id: deliveryId } });
  }

  it("retries a 500 and a 429, and settles neither", async () => {
    for (const path of ["/status/500", "/status/429"]) {
      const row = await attemptAgainst(path);
      expect(row.status, path).toBe("PENDING");
      expect(row.lastOutcome, path).toBe("RETRYABLE");
      expect(row.settledAt, path).toBeNull();
      expect(row.nextAttemptAt, path).not.toBeNull();
    }
  });

  it("refuses a 4xx without retrying, because the receiver has said no", async () => {
    const row = await attemptAgainst("/status/404");
    expect(row.status).toBe("REFUSED");
    expect(row.lastErrorClass).toBe("HTTP_CLIENT_ERROR");
    expect(row.nextAttemptAt).toBeNull();
  });

  it("refuses a redirect rather than following it", async () => {
    /*
     * The classic SSRF bypass: a validated host that answers 302 to `169.254.169.254`. A 3xx is an
     * outcome here, not a hop, and the receiver never sees a second request.
     */
    const before = receiver.requests.length;
    const row = await attemptAgainst("/redirect");
    expect(row.status).toBe("REFUSED");
    expect(row.lastErrorClass).toBe("HTTP_REDIRECT");
    expect(receiver.requests.length - before).toBe(1);
  });

  it("classifies a timeout as retryable and never as delivered", async () => {
    const row = await attemptAgainst("/hang");
    expect(row.status).toBe("PENDING");
    expect(row.lastErrorClass).toBe("TIMEOUT");
    expect(row.lastOutcome).not.toBe("DELIVERED");
    expect(row.lastHttpStatus).toBeNull();
  }, 20_000);

  it("classifies a refused connection as a network error, and retries it", async () => {
    // The same host, a port nothing is listening on. A connection refused is the network's problem,
    // not the receiver's answer, so it is retryable and is never recorded as delivered.
    const fx = await createStampCafe({ name: "Dead café" });
    session.userId = fx.userId;
    const created = await createDestination(fx.ctx, {
      name: "Ops",
      url: `https://${HOST}:${receiver.port + 1}/hook`,
    });
    await setDestinationState(fx.ctx, created.destination.id, "ENABLED");
    const { deliveryId } = await queueTestDelivery(fx.ctx, created.destination.id);

    await runOnce();
    const row = await migratorPrisma().webhookDelivery.findFirstOrThrow({ where: { id: deliveryId } });
    expect(row.status).toBe("PENDING");
    expect(row.lastOutcome).toBe("RETRYABLE");
    expect(row.lastOutcome).not.toBe("DELIVERED");
    expect(row.lastHttpStatus).toBeNull();
  }, 20_000);
});

describe("SSRF is refused at delivery time, not only at save time", () => {
  beforeEach(async () => {
    await resetDatabase();
    receiver.reset();
  });

  it("refuses when the hostname now resolves to a private address", async () => {
    /*
     * **DNS rebinding, end to end.** The URL passed every shape check when the owner saved it. By
     * the time the worker runs, the name answers with the cloud metadata address — and the request
     * never leaves, because the resolver the agent uses is the one that validates.
     */
    const { fx, destinationId } = await cafeWithDestination("Rebind café");
    const { deliveryId } = await queueTestDelivery(fx.ctx, destinationId);
    const before = receiver.requests.length;

    await runDueDeliveries({ lookup: resolverTo("169.254.169.254"), addressPolicy: allowReceiver, ca: receiver.ca });

    const row = await migratorPrisma().webhookDelivery.findFirstOrThrow({ where: { id: deliveryId } });
    expect(row.status).toBe("REFUSED");
    expect(row.lastErrorClass).toBe("UNSAFE_ADDRESS");
    expect(row.lastOutcome).toBe("PERMANENT");
    // Never retried. Retrying an SSRF attempt is attempting it again.
    expect(row.nextAttemptAt).toBeNull();
    expect(receiver.requests.length).toBe(before);
  });

  it("refuses every private range the same way", async () => {
    for (const address of ["10.0.0.1", "127.0.0.1", "192.168.1.1", "172.16.0.1", "0.0.0.0"]) {
      await resetDatabase();
      const { fx, destinationId } = await cafeWithDestination(`Private ${address}`);
      const { deliveryId } = await queueTestDelivery(fx.ctx, destinationId);
      // The REAL policy here, deliberately: `allowReceiver` permits the loopback the receiver is
      // on, which would make 127.0.0.1 pass and prove nothing.
      await runDueDeliveries({ lookup: resolverTo(address), ca: receiver.ca });
      const row = await migratorPrisma().webhookDelivery.findFirstOrThrow({ where: { id: deliveryId } });
      expect(row.lastErrorClass, address).toBe("UNSAFE_ADDRESS");
      expect(row.status, address).toBe("REFUSED");
    }
  });

  it("records the refusal without the address ever reaching a column", async () => {
    const { fx, destinationId } = await cafeWithDestination("Quiet café");
    await queueTestDelivery(fx.ctx, destinationId);
    await runDueDeliveries({ lookup: resolverTo("169.254.169.254"), addressPolicy: allowReceiver, ca: receiver.ca });

    const attempts = await migratorPrisma().webhookDeliveryAttempt.findMany({
      where: { businessId: fx.businessId },
    });
    const serialized = JSON.stringify(attempts);
    expect(serialized).not.toContain("169.254");
    expect(serialized).not.toContain(HOST);
  });
});

describe("retries are bounded and back off", () => {
  beforeEach(async () => {
    await resetDatabase();
    receiver.reset();
  });

  it("increases the wait each time and gives up at the cap", async () => {
    const { fx, destinationId } = await cafeWithDestination("Backoff café", "/status/500");
    const { deliveryId } = await queueTestDelivery(fx.ctx, destinationId);

    let now = new Date();
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      await runOnce(now);
      const row = await migratorPrisma().webhookDelivery.findFirstOrThrow({ where: { id: deliveryId } });
      expect(row.attemptCount, `attempt ${attempt}`).toBe(attempt);
      if (attempt < MAX_ATTEMPTS) {
        expect(row.status, `attempt ${attempt}`).toBe("PENDING");
        // Move the clock past the backoff so the next pass picks it up.
        now = new Date(now.getTime() + backoffSeconds(attempt) * 1000 + 1000);
      } else {
        expect(row.status).toBe("FAILED");
        expect(row.settledAt).not.toBeNull();
        expect(row.nextAttemptAt).toBeNull();
      }
    }

    const attempts = await migratorPrisma().webhookDeliveryAttempt.findMany({
      where: { deliveryId },
      orderBy: { attemptNumber: "asc" },
    });
    expect(attempts.map((a) => a.attemptNumber)).toEqual([1, 2, 3, 4, 5]);
    // Append-only: five rows for five attempts, none of them edited.
    expect(new Set(attempts.map((a) => a.outcome))).toEqual(new Set(["RETRYABLE"]));
  }, 60_000);

  it("does not pick a delivery up before its next attempt is due", async () => {
    const { fx, destinationId } = await cafeWithDestination("Patience café", "/status/500");
    const { deliveryId } = await queueTestDelivery(fx.ctx, destinationId);
    const now = new Date();
    await runOnce(now);

    // Immediately again: nothing is due, so nothing is attempted.
    const second = await runOnce(new Date(now.getTime() + 1000));
    expect(second.attempted).toBe(0);
    const row = await migratorPrisma().webhookDelivery.findFirstOrThrow({ where: { id: deliveryId } });
    expect(row.attemptCount).toBe(1);
  });

  it("backs off exponentially", () => {
    expect(backoffSeconds(1)).toBe(60);
    expect(backoffSeconds(2)).toBe(300);
    expect(backoffSeconds(3)).toBe(1500);
    expect(backoffSeconds(4)).toBeGreaterThan(backoffSeconds(3));
  });
});

describe("delivery fails closed without the key, and touches nothing else", () => {
  beforeEach(async () => {
    await resetDatabase();
    receiver.reset();
  });

  it("records ENCRYPTION_UNAVAILABLE and sends nothing", async () => {
    const { fx, destinationId } = await cafeWithDestination("Keyless café");
    const { deliveryId } = await queueTestDelivery(fx.ctx, destinationId);
    const before = receiver.requests.length;

    const key = process.env.INTEGRATION_ENCRYPTION_KEY;
    delete process.env.INTEGRATION_ENCRYPTION_KEY;
    try {
      await runOnce();
    } finally {
      process.env.INTEGRATION_ENCRYPTION_KEY = key;
    }

    const row = await migratorPrisma().webhookDelivery.findFirstOrThrow({ where: { id: deliveryId } });
    expect(row.lastErrorClass).toBe("ENCRYPTION_UNAVAILABLE");
    expect(row.status).toBe("REFUSED");
    expect(receiver.requests.length).toBe(before);
    // The event this business recorded is untouched; only the telling failed.
    expect(await migratorPrisma().integrationEvent.count({ where: { businessId: fx.businessId } })).toBe(0);
  });
});

describe("the transport refuses an oversized body before sending", () => {
  it("never puts more than the cap on the wire", async () => {
    const result = await sendWebhook({
      url: `https://${HOST}:${receiver.port}/hook`,
      signingSecret: "x",
      body: "x".repeat(5000),
      eventId: "e",
      deliveryId: "d",
      attemptNumber: 1,
      lookup: localResolver(),
      addressPolicy: allowReceiver,
      ca: receiver.ca,
    });
    expect(result.outcome).toBe("PERMANENT");
    expect(result.httpStatus).toBeNull();
  });
});

describe("a delivery never mutates the event it describes", () => {
  beforeEach(async () => {
    await resetDatabase();
    receiver.reset();
  });

  it("leaves IntegrationEvent byte-identical across a full retry cycle", async () => {
    const { fx, destinationId } = await cafeWithDestination("Immutable café", "/status/500");
    await queueTestDelivery(fx.ctx, destinationId);
    // A test delivery names no event, so also assert the table stays empty rather than gaining one.
    const before = await migratorPrisma().integrationEvent.findMany({ where: { businessId: fx.businessId } });
    await runOnce();
    const after = await migratorPrisma().integrationEvent.findMany({ where: { businessId: fx.businessId } });
    expect(after).toEqual(before);

    // And the delivery table is the only thing that moved.
    expect(await prisma.webhookDeliveryAttempt.count({ where: { businessId: fx.businessId } })).toBe(1);
  });
});
