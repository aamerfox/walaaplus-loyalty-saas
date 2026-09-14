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
import { startEgressServer, type EgressServer } from "@/egress/server";
import { addressProblem, type AddressPolicy, type LookupFn } from "@/server/integrations/webhooks/address";
import { encryptSecret, signaturesMatch, signPayload } from "@/server/integrations/webhooks/crypto";
import {
  backoffSeconds,
  LEASE_SECONDS,
  MAX_ATTEMPTS,
  runDueDeliveries,
} from "@/server/integrations/webhooks/delivery";
import {
  createDestination,
  queueTestDelivery,
  rotateSecret,
  setDestinationState,
} from "@/server/integrations/webhooks/destinations";
import { HEADER, TEST_EVENT_ENTITY_PREFIX } from "@/server/integrations/webhooks/envelope";
import { sendWebhook } from "@/server/integrations/webhooks/gateway";
import { codeDigest, newCodeSalt } from "@/server/promotions/codes";
import {
  createStampCafe,
  enrolCustomer,
  migratorPrisma,
  resetDatabase,
  uniqueSyrianPhone,
  type StampCafeFixture,
} from "../setup/fixtures";
import { startReceiver, type Receiver } from "../setup/webhook-receiver";

/**
 * Delivery, against a **local HTTPS receiver this test starts and stops**, through a **real egress
 * gateway running in this process**.
 *
 * Nothing outside this machine is contacted. The certificate is generated in the fixture, the
 * resolver is a function this file supplies, the gateway is `startEgressServer` on loopback, and
 * every port is whatever the OS hands out. There is no real endpoint, no provider, no staging
 * service and no network path beyond loopback.
 *
 * ## What changed in Prompt 3, and what deliberately did not
 *
 * The request is no longer made by the worker. `runDueDeliveries` claims, re-reads, decrypts,
 * builds the envelope and signs it, then hands the signed bytes to the gateway over HTTP; the
 * gateway re-validates the address, resolves it under the guard and opens the TLS connection.
 *
 * So the DNS seams moved with the code that uses them: they are options of the **gateway** now, not
 * of the runner. A test that needs a different resolver sets `currentLookup` and the gateway picks
 * it up on its next dispatch — which keeps every assertion below about the same production path,
 * just one process further along. Nothing here bypasses the guard: the address policy defaults to
 * the real rule and is widened only to the one loopback address the receiver is bound to.
 */

let savedKey: string | undefined;
let savedGatewaySecret: string | undefined;
let receiver: Receiver;
let gateway: EgressServer;
let gatewayUrl: string;

/**
 * The resolver and policy the in-process gateway uses for the NEXT dispatch.
 *
 * Mutable, because the gateway is started once and some tests need it to answer differently. Set
 * through `withResolver` rather than written directly, so every test states which one it wants.
 */
let currentLookup: LookupFn;
let currentPolicy: AddressPolicy;

beforeAll(async () => {
  savedKey = process.env.INTEGRATION_ENCRYPTION_KEY;
  savedGatewaySecret = process.env.WEBHOOK_GATEWAY_SECRET;
  process.env.INTEGRATION_ENCRYPTION_KEY = randomBytes(32).toString("hex");
  // Generated per run, never printed, never written down. Two different values: reusing one would
  // be the exact mistake .env.staging.example warns about.
  process.env.WEBHOOK_GATEWAY_SECRET = randomBytes(32).toString("hex");

  receiver = await startReceiver();
  currentLookup = resolverTo(receiver.address);
  currentPolicy = allowReceiver;

  gateway = await startEgressServer({
    host: "127.0.0.1",
    // Indirected through the mutable variables so a test can change the answer between passes.
    lookup: ((h, o, cb) => currentLookup(h, o, cb)) as LookupFn,
    addressPolicy: (address) => currentPolicy(address),
    ca: receiver.ca,
    /*
     * The one test seam on the port rule. A receiver cannot bind 443; see `ParseOptions`. The
     * second entry is a port nothing listens on, so the refused-connection test can prove that a
     * dead endpoint is the NETWORK's problem - retryable - rather than a contract refusal.
     */
    allowedPorts: [receiver.port, receiver.port + 1],
  });
  gatewayUrl = `http://127.0.0.1:${gateway.port}`;
});

afterAll(async () => {
  await gateway.close();
  await receiver.close();
  if (savedKey === undefined) delete process.env.INTEGRATION_ENCRYPTION_KEY;
  else process.env.INTEGRATION_ENCRYPTION_KEY = savedKey;
  if (savedGatewaySecret === undefined) delete process.env.WEBHOOK_GATEWAY_SECRET;
  else process.env.WEBHOOK_GATEWAY_SECRET = savedGatewaySecret;
});

/** Point the gateway's next dispatch at a particular answer. The policy defaults to the loose one. */
function withResolver(lookup: LookupFn, policy: AddressPolicy = allowReceiver): void {
  currentLookup = lookup;
  currentPolicy = policy;
}

/**
 * A resolver that answers with a chosen address for the test hostname.
 *
 * The gateway then connects to it — except the local receiver is on loopback, so for the tests that
 * actually complete a request the address handed back is the loopback the server is on and the
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

/** Run one pass against the in-process gateway, resolving to the local receiver. */
function runOnce(now = new Date()) {
  withResolver(localResolver());
  return runDueDeliveries({ now, gatewayUrl });
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
    expect(summary).toMatchObject({ claimed: 1, delivered: 1 });

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

    withResolver(resolverTo("169.254.169.254"));
    await runDueDeliveries({ gatewayUrl });

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
      withResolver(resolverTo(address), addressProblem);
      await runDueDeliveries({ gatewayUrl });
      const row = await migratorPrisma().webhookDelivery.findFirstOrThrow({ where: { id: deliveryId } });
      expect(row.lastErrorClass, address).toBe("UNSAFE_ADDRESS");
      expect(row.status, address).toBe("REFUSED");
    }
  });

  it("records the refusal without the address ever reaching a column", async () => {
    const { fx, destinationId } = await cafeWithDestination("Quiet café");
    await queueTestDelivery(fx.ctx, destinationId);
    withResolver(resolverTo("169.254.169.254"));
    await runDueDeliveries({ gatewayUrl });

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
    expect(second.claimed).toBe(0);
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

describe("an unavailable key waits; a corrupt ciphertext does not", () => {
  beforeEach(async () => {
    await resetDatabase();
    receiver.reset();
  });

  it("treats a missing key as retryable, sends nothing, and recovers when it comes back", async () => {
    /*
     * The gap this closes. A missing environment variable is a deployment condition an operator
     * corrects in minutes; refusing every queued delivery permanently because of one would turn a
     * short outage into lost webhooks.
     */
    const { fx, destinationId } = await cafeWithDestination("Keyless caf\u00e9");
    const { deliveryId } = await queueTestDelivery(fx.ctx, destinationId);
    const before = receiver.requests.length;

    const key = process.env.INTEGRATION_ENCRYPTION_KEY;
    delete process.env.INTEGRATION_ENCRYPTION_KEY;
    let now = new Date();
    try {
      await runOnce(now);
    } finally {
      process.env.INTEGRATION_ENCRYPTION_KEY = key;
    }

    const paused = await migratorPrisma().webhookDelivery.findFirstOrThrow({ where: { id: deliveryId } });
    expect(paused.lastErrorClass).toBe("ENCRYPTION_UNAVAILABLE");
    expect(paused.lastOutcome).toBe("RETRYABLE");
    expect(paused.status, "a brief outage must not settle the delivery").toBe("PENDING");
    expect(paused.nextAttemptAt).not.toBeNull();
    expect(receiver.requests.length, "nothing may be sent without the key").toBe(before);

    // The operator puts the key back. The next due pass delivers it.
    now = new Date(now.getTime() + backoffSeconds(1) * 1000 + 1000);
    await runOnce(now);

    const recovered = await migratorPrisma().webhookDelivery.findFirstOrThrow({ where: { id: deliveryId } });
    expect(recovered.status).toBe("DELIVERED");
    expect(recovered.lastErrorClass).toBe("NONE");
    expect(receiver.requests.length).toBe(before + 1);
  }, 30_000);

  it("exhausts to FAILED if the key never comes back", async () => {
    const { fx, destinationId } = await cafeWithDestination("Still keyless caf\u00e9");
    const { deliveryId } = await queueTestDelivery(fx.ctx, destinationId);

    const key = process.env.INTEGRATION_ENCRYPTION_KEY;
    delete process.env.INTEGRATION_ENCRYPTION_KEY;
    let now = new Date();
    try {
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
        await runOnce(now);
        now = new Date(now.getTime() + backoffSeconds(attempt) * 1000 + 1000);
      }
    } finally {
      process.env.INTEGRATION_ENCRYPTION_KEY = key;
    }

    const row = await migratorPrisma().webhookDelivery.findFirstOrThrow({ where: { id: deliveryId } });
    expect(row.status).toBe("FAILED");
    expect(row.attemptCount).toBe(MAX_ATTEMPTS);
    expect(row.lastErrorClass).toBe("ENCRYPTION_UNAVAILABLE");
    // Bounded: the cap is the cap, in the database as well as in the code.
    expect(row.settledAt).not.toBeNull();
  }, 60_000);

  it("refuses an undecryptable ciphertext permanently, and sends nothing", async () => {
    /*
     * A key that IS present and well-formed, against a value that will not decrypt under it: the row
     * is corrupt, or was written under a key that no longer exists. Waiting cannot fix either, and
     * retrying would hide it behind five quiet failures.
     *
     * The destination is created with ciphertext written under a DIFFERENT key rather than by
     * editing an existing row \u2014 `webhook_destination_guard` freezes the endpoint, so the row cannot
     * be tampered with after the fact, which is itself the protection working. A wrong-key
     * ciphertext exercises exactly the same failure: `decryptSecret` cannot tell the two apart, by
     * design, because a caller that could would have an oracle.
     */
    const cafe = await createStampCafe({ name: "Undecryptable caf\u00e9" });
    session.userId = cafe.userId;
    const strangerKey = { INTEGRATION_ENCRYPTION_KEY: randomBytes(32).toString("hex") } as unknown as NodeJS.ProcessEnv;

    const destination = await prisma.webhookDestination.create({
      data: {
        businessId: cafe.businessId,
        name: "Ops",
        endpointHost: HOST,
        endpointDigest: randomBytes(32).toString("hex"),
        endpointCipher: encryptSecret(`https://${HOST}:${receiver.port}/hook`, strangerKey),
        signingSecretCipher: encryptSecret(randomBytes(32).toString("base64url"), strangerKey),
        cipherAlgorithm: "AES_256_GCM",
        cipherKeyVersion: 1,
        secretIssuedAt: new Date(),
      },
      select: { id: true },
    });
    await prisma.webhookDestination.update({ where: { id: destination.id }, data: { state: "ENABLED" } });

    const { deliveryId } = await queueTestDelivery(cafe.ctx, destination.id);
    const before = receiver.requests.length;

    await runOnce();

    const settled = await migratorPrisma().webhookDelivery.findFirstOrThrow({ where: { id: deliveryId } });
    expect(settled.lastErrorClass).toBe("CIPHERTEXT_INVALID");
    expect(settled.lastOutcome).toBe("PERMANENT");
    expect(settled.status).toBe("REFUSED");
    expect(settled.attemptCount).toBe(1);
    expect(settled.nextAttemptAt).toBeNull();
    expect(receiver.requests.length, "an undecryptable destination was contacted").toBe(before);
  });

  it("leaves the till, the ledger and B7 alone while the key is gone", async () => {
    const key = process.env.INTEGRATION_ENCRYPTION_KEY;
    delete process.env.INTEGRATION_ENCRYPTION_KEY;
    try {
      const enroll = await import("@/app/api/enroll/route");
      expect((await enroll.GET()).status).toBe(410);
      expect((await enroll.POST()).status).toBe(410);
    } finally {
      process.env.INTEGRATION_ENCRYPTION_KEY = key;
    }
  });
});

describe("an oversized body is refused before it crosses the hop", () => {
  it("never puts more than the cap on the wire, and never reaches the gateway", async () => {
    const before = receiver.requests.length;
    const result = await sendWebhook({
      url: `https://${HOST}:${receiver.port}/hook`,
      signingSecret: "x",
      body: "x".repeat(5000),
      eventId: "e",
      deliveryId: "d",
      attemptNumber: 1,
      gatewayUrl,
    });
    // Permanent, and named as ours rather than the merchant's: a body this size is our defect.
    expect(result.outcome).toBe("PERMANENT");
    expect(result.errorClass).toBe("GATEWAY_REJECTED");
    expect(result.httpStatus).toBeNull();
    expect(receiver.requests.length).toBe(before);
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

describe("who may be dispatched to, and when", () => {
  /*
   * One table, agreed by the worker, the service, the screen and the trigger:
   *
   *   REVOKED   nothing, ever
   *   DISABLED  a synthetic test the owner asked for, and nothing else
   *   ENABLED   everything
   *
   * The disabled-test case is the point of a test: checking an address BEFORE turning it on. The
   * previous version refused it, which quietly broke the button the screen offers.
   */
  beforeEach(async () => {
    await resetDatabase();
    receiver.reset();
  });

  it("dispatches a synthetic test to a DISABLED destination", async () => {
    const { fx, destinationId } = await cafeWithDestination("Disabled test caf\u00e9");
    await setDestinationState(fx.ctx, destinationId, "DISABLED");
    const { deliveryId } = await queueTestDelivery(fx.ctx, destinationId);
    const before = receiver.requests.length;

    await runOnce();

    const row = await migratorPrisma().webhookDelivery.findFirstOrThrow({ where: { id: deliveryId } });
    expect(row.status).toBe("DELIVERED");
    expect(receiver.requests.length).toBe(before + 1);
    // And it carried the synthetic envelope, not a real event.
    expect(JSON.parse(receiver.requests.at(-1)!.body).eventType).toBe("TEST");
  });

  it("refuses a real event queued for a destination that was disabled before dispatch", async () => {
    const { fx, destinationId } = await cafeWithDestination("Cutover caf\u00e9");
    const eventId = await realEventFor(fx);
    const deliveryId = (
      await prisma.webhookDelivery.create({
        data: {
          businessId: fx.businessId,
          destinationId,
          integrationEventId: eventId,
          nextAttemptAt: new Date(),
        },
        select: { id: true },
      })
    ).id;

    // The owner switches it off between queueing and dispatch.
    await setDestinationState(fx.ctx, destinationId, "DISABLED");
    const before = receiver.requests.length;

    await runOnce();

    const row = await migratorPrisma().webhookDelivery.findFirstOrThrow({ where: { id: deliveryId } });
    expect(row.lastErrorClass).toBe("DESTINATION_NOT_ELIGIBLE");
    expect(row.status).toBe("REFUSED");
    expect(receiver.requests.length, "a disabled destination received a real event").toBe(before);
  });

  it("refuses a test to a REVOKED destination", async () => {
    const { fx, destinationId } = await cafeWithDestination("Revoked caf\u00e9");
    const { deliveryId } = await queueTestDelivery(fx.ctx, destinationId);
    await setDestinationState(fx.ctx, destinationId, "REVOKED");
    const before = receiver.requests.length;

    await runOnce();

    const row = await migratorPrisma().webhookDelivery.findFirstOrThrow({ where: { id: deliveryId } });
    expect(row.lastErrorClass).toBe("DESTINATION_NOT_ELIGIBLE");
    expect(row.status).toBe("REFUSED");
    expect(receiver.requests.length).toBe(before);
  });
});

describe("two passes cannot dispatch the same delivery", () => {
  beforeEach(async () => {
    await resetDatabase();
    receiver.reset();
  });

  it("sends exactly one request when two passes run at the same time", async () => {
    /*
     * The gap this closes. The previous design read due rows with `findMany`, sent them, and only
     * then wrote the attempt — so two overlapping passes both read the same row and both sent.
     *
     * The claim is now one atomic `UPDATE ... FOR UPDATE SKIP LOCKED ... RETURNING`, so the second
     * pass steps over a row the first is taking rather than duplicating it.
     */
    const { fx, destinationId } = await cafeWithDestination("Race caf\u00e9");
    const { deliveryId } = await queueTestDelivery(fx.ctx, destinationId);
    const before = receiver.requests.length;

    const [a, b] = await Promise.all([runOnce(), runOnce()]);

    expect(a.claimed + b.claimed, "both passes claimed the same row").toBe(1);
    expect(receiver.requests.length - before, "the receiver got it twice").toBe(1);

    const row = await migratorPrisma().webhookDelivery.findFirstOrThrow({ where: { id: deliveryId } });
    expect(row.attemptCount).toBe(1);
    expect(row.status).toBe("DELIVERED");

    // Exactly one attempt record, and no lease left behind.
    const attempts = await migratorPrisma().webhookDeliveryAttempt.findMany({ where: { deliveryId } });
    expect(attempts).toHaveLength(1);
    expect(row.claimToken).toBeNull();
    expect(row.leaseExpiresAt).toBeNull();
  });

  it("splits a batch between two passes rather than duplicating it", async () => {
    const { fx, destinationId } = await cafeWithDestination("Batch caf\u00e9");
    for (let i = 0; i < 4; i += 1) await queueTestDelivery(fx.ctx, destinationId);
    const before = receiver.requests.length;

    const [a, b] = await Promise.all([runOnce(), runOnce()]);

    expect(a.claimed + b.claimed).toBe(4);
    expect(receiver.requests.length - before).toBe(4);
    const rows = await migratorPrisma().webhookDelivery.findMany({ where: { businessId: fx.businessId } });
    expect(rows.every((r) => r.attemptCount === 1)).toBe(true);
    expect(await migratorPrisma().webhookDeliveryAttempt.count({ where: { businessId: fx.businessId } })).toBe(4);
  });

  it("does not pick up a row somebody else is holding", async () => {
    const { fx, destinationId } = await cafeWithDestination("Held caf\u00e9");
    const { deliveryId } = await queueTestDelivery(fx.ctx, destinationId);

    // A live lease, as a crashed worker would have left behind moments ago.
    const now = new Date();
    await migratorPrisma().webhookDelivery.update({
      where: { id: deliveryId },
      data: {
        claimedAt: now,
        leaseExpiresAt: new Date(now.getTime() + LEASE_SECONDS * 1000),
        claimToken: randomUUID(),
      },
    });

    const summary = await runOnce(now);
    expect(summary.claimed).toBe(0);
    expect(await migratorPrisma().webhookDeliveryAttempt.count({ where: { deliveryId } })).toBe(0);
  });

  it("takes a row again once its lease expires, so a crash strands nothing", async () => {
    /*
     * Crash recovery. A worker that dies holding a claim leaves the row exactly as it was; the lease
     * is what makes it work again rather than waiting for somebody to notice.
     */
    const { fx, destinationId } = await cafeWithDestination("Crashed caf\u00e9");
    const { deliveryId } = await queueTestDelivery(fx.ctx, destinationId);

    const crashedAt = new Date();
    await migratorPrisma().webhookDelivery.update({
      where: { id: deliveryId },
      data: {
        claimedAt: crashedAt,
        leaseExpiresAt: new Date(crashedAt.getTime() + LEASE_SECONDS * 1000),
        claimToken: randomUUID(),
      },
    });

    // Before the lease expires: nothing.
    expect((await runOnce(new Date(crashedAt.getTime() + 1000))).claimed).toBe(0);

    // After it: the row is work again.
    const later = new Date(crashedAt.getTime() + (LEASE_SECONDS + 5) * 1000);
    const summary = await runOnce(later);
    expect(summary.claimed).toBe(1);

    const row = await migratorPrisma().webhookDelivery.findFirstOrThrow({ where: { id: deliveryId } });
    expect(row.status).toBe("DELIVERED");
    expect(row.attemptCount).toBe(1);
    expect(row.claimToken).toBeNull();
  });

  it("writes nothing when the lease was lost mid-flight", async () => {
    /*
     * A worker slow enough to lose its lease must not trample whoever took the row next. Every write
     * carries the claim token, so a stale one affects zero rows and writes no attempt.
     */
    const { fx, destinationId } = await cafeWithDestination("Slow caf\u00e9");
    const { deliveryId } = await queueTestDelivery(fx.ctx, destinationId);

    withResolver(localResolver());
    await runDueDeliveries({
      gatewayUrl,
      // Between the claim and the write, somebody else re-claims the row.
      send: async () => {
        await migratorPrisma().webhookDelivery.update({
          where: { id: deliveryId },
          data: { claimToken: randomUUID() },
        });
        return { outcome: "DELIVERED" as const, errorClass: "NONE" as const, httpStatus: 200 };
      },
    });

    const row = await migratorPrisma().webhookDelivery.findFirstOrThrow({ where: { id: deliveryId } });
    expect(row.attemptCount, "a stale claim wrote an attempt").toBe(0);
    expect(row.status).toBe("PENDING");
    expect(await migratorPrisma().webhookDeliveryAttempt.count({ where: { deliveryId } })).toBe(0);
  });
});

/**
 * A real `IntegrationEvent` for this caf\u00e9, written the way Prompt 1's trigger requires.
 *
 * The event's `occurredAt` must equal the redemption's `recordedAt`, which is true only inside one
 * transaction \u2014 so the redemption and the event are created together, as the service does it.
 */
async function realEventFor(fx: StampCafeFixture): Promise<string> {
  const customer = await enrolCustomer(fx, { phone: uniqueSyrianPhone(), firstName: "\u0644\u064a\u0644\u0649" });
  const salt = newCodeSalt();
  const promotion = await prisma.promotion.create({
    data: {
      businessId: fx.businessId,
      name: `Offer ${Math.random().toString(36).slice(2, 8)}`,
      normalizedName: Math.random().toString(36).slice(2, 8),
      benefitDescription: "A free espresso",
      codeDigest: codeDigest(salt, fx.businessId, "AUTUMN10"),
      codeSalt: salt,
    },
    select: { id: true },
  });
  await prisma.promotion.update({ where: { id: promotion.id }, data: { state: "ACTIVE" } });

  return prisma.$transaction(async (tx) => {
    const redemption = await tx.promotionRedemption.create({
      data: {
        businessId: fx.businessId,
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
        businessId: fx.businessId,
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

describe("the dispatch read is per delivery, not per batch", () => {
  /*
   * The gap this closes. `loadClaimed` used to read the whole claimed batch once, before the loop,
   * and every later delivery used that snapshot. With two claimed and the first one slow, an owner
   * could disable the second destination and the second delivery would still go out against a stale
   * `ENABLED` — and against a stale signing secret if they had rotated it.
   *
   * Every test here claims TWO deliveries and changes the second's destination while the first is
   * being sent. That is deterministic: the change happens inside the first delivery's `send`, so it
   * is committed before the second delivery's read by construction, not by timing.
   */
  beforeEach(async () => {
    await resetDatabase();
    receiver.reset();
  });

  /**
   * Two destinations in one business, both enabled, each with one queued test delivery.
   *
   * The claim orders by `nextAttemptAt`, so the first delivery is backdated to make the order
   * **deterministic**. Without that the two are queued microseconds apart and either can be sent
   * first — which made the interleaved assertions pass or fail on timing rather than on behaviour,
   * and is exactly the kind of test that lies when it is green.
   */
  async function twoQueued(name: string) {
    const fx = await createStampCafe({ name });
    session.userId = fx.userId;

    const made: { destinationId: string; deliveryId: string; signingSecret: string }[] = [];
    for (const n of [1, 2]) {
      const created = await createDestination(fx.ctx, {
        name: `Ops ${n}`,
        url: `https://${HOST}:${receiver.port}/hook?d=${n}`,
      });
      await setDestinationState(fx.ctx, created.destination.id, "ENABLED");
      const { deliveryId } = await queueTestDelivery(fx.ctx, created.destination.id);
      made.push({ destinationId: created.destination.id, deliveryId, signingSecret: created.signingSecret });
    }

    // A minute earlier, so this one is unambiguously first in the claim's ORDER BY.
    await migratorPrisma().webhookDelivery.update({
      where: { id: made[0].deliveryId },
      data: { nextAttemptAt: new Date(Date.now() - 60_000) },
    });

    return { fx, first: made[0], second: made[1] };
  }

  /**
   * Run one pass, committing `change` while a delivery OTHER than `target` is on the wire.
   *
   * Keyed on the delivery id rather than on a counter, so it cannot depend on which order the claim
   * happened to return. The real gateway still runs for every delivery; the hook only interposes a
   * committed database change between two dispatches, which is exactly the race being tested.
   */
  function runInterleaved(targetDeliveryId: string, change: () => Promise<void>) {
    let changed = false;
    withResolver(localResolver());
    return runDueDeliveries({
      gatewayUrl,
      send: async (input) => {
        if (!changed && input.deliveryId !== targetDeliveryId) {
          changed = true;
          await change();
        }
        return sendWebhook(input);
      },
    });
  }

  it("sends nothing to a destination disabled while an earlier delivery was in flight", async () => {
    const { fx, first, second } = await twoQueued("Interleave disable caf\u00e9");
    const before = receiver.requests.length;

    const summary = await runInterleaved(second.deliveryId, async () => {
      await setDestinationState(fx.ctx, second.destinationId, "DISABLED");
    });

    expect(summary.claimed).toBe(2);

    const firstRow = await migratorPrisma().webhookDelivery.findFirstOrThrow({ where: { id: first.deliveryId } });
    expect(firstRow.status, "the first delivery should have gone").toBe("DELIVERED");

    const secondRow = await migratorPrisma().webhookDelivery.findFirstOrThrow({ where: { id: second.deliveryId } });
    /*
     * A synthetic test MAY run while disabled — that rule is unchanged and deliberate. What must not
     * happen is the second delivery using the stale ENABLED snapshot; here it correctly sees
     * DISABLED and, being a test, is still allowed through. The batch-snapshot bug is proved by the
     * revoke and rotate cases below, where the two paths differ.
     */
    expect(secondRow.attemptCount).toBe(1);
    expect(receiver.requests.length - before).toBe(2);
  });

  it("sends nothing — not even a test — to a destination revoked while an earlier delivery was in flight", async () => {
    const { fx, first, second } = await twoQueued("Interleave revoke caf\u00e9");
    const before = receiver.requests.length;

    const summary = await runInterleaved(second.deliveryId, async () => {
      await setDestinationState(fx.ctx, second.destinationId, "REVOKED");
    });

    expect(summary.claimed).toBe(2);

    const firstRow = await migratorPrisma().webhookDelivery.findFirstOrThrow({ where: { id: first.deliveryId } });
    expect(firstRow.status).toBe("DELIVERED");

    const secondRow = await migratorPrisma().webhookDelivery.findFirstOrThrow({ where: { id: second.deliveryId } });
    expect(secondRow.lastErrorClass, "a revoked destination was contacted").toBe("DESTINATION_NOT_ELIGIBLE");
    expect(secondRow.status).toBe("REFUSED");
    expect(secondRow.lastHttpStatus).toBeNull();

    // Exactly one request left the process: the first delivery's.
    expect(receiver.requests.length - before, "the revoked destination received something").toBe(1);
    const attempts = await migratorPrisma().webhookDeliveryAttempt.findMany({
      where: { deliveryId: second.deliveryId },
    });
    expect(attempts).toHaveLength(1);
    expect(attempts[0].outcome).toBe("PERMANENT");
  });

  it("refuses a REAL event queued for a destination disabled mid-batch", async () => {
    const fx = await createStampCafe({ name: "Interleave real caf\u00e9" });
    session.userId = fx.userId;

    // One test delivery to keep the batch busy, then a real one to a second destination.
    const keepBusy = await createDestination(fx.ctx, { name: "Busy", url: `https://${HOST}:${receiver.port}/hook?d=0` });
    await setDestinationState(fx.ctx, keepBusy.destination.id, "ENABLED");
    const busy = await queueTestDelivery(fx.ctx, keepBusy.destination.id);
    await migratorPrisma().webhookDelivery.update({
      where: { id: busy.deliveryId },
      data: { nextAttemptAt: new Date(Date.now() - 60_000) },
    });

    const target = await createDestination(fx.ctx, { name: "Target", url: `https://${HOST}:${receiver.port}/hook?d=1` });
    await setDestinationState(fx.ctx, target.destination.id, "ENABLED");
    const eventId = await realEventFor(fx);
    const realDeliveryId = (
      await prisma.webhookDelivery.create({
        data: {
          businessId: fx.businessId,
          destinationId: target.destination.id,
          integrationEventId: eventId,
          nextAttemptAt: new Date(),
        },
        select: { id: true },
      })
    ).id;

    const before = receiver.requests.length;
    const summary = await runInterleaved(realDeliveryId, async () => {
      await setDestinationState(fx.ctx, target.destination.id, "DISABLED");
    });

    expect(summary.claimed).toBe(2);
    const row = await migratorPrisma().webhookDelivery.findFirstOrThrow({ where: { id: realDeliveryId } });
    expect(row.lastErrorClass, "a disabled destination received a real event").toBe("DESTINATION_NOT_ELIGIBLE");
    expect(row.status).toBe("REFUSED");
    expect(receiver.requests.length - before, "only the first delivery should have gone").toBe(1);
  });

  it("signs with the NEW secret when it was rotated mid-batch", async () => {
    const { fx, second } = await twoQueued("Interleave rotate caf\u00e9");
    const oldSecret = second.signingSecret;
    let newSecret = "";

    await runInterleaved(second.deliveryId, async () => {
      newSecret = (await rotateSecret(fx.ctx, second.destinationId)).signingSecret;
    });

    expect(newSecret).not.toBe(oldSecret);

    // The second delivery's request, identified by its own header rather than by position.
    const request = receiver.requests.find((r) => r.headers[HEADER.deliveryId] === second.deliveryId)!;
    expect(request, "the second delivery never reached the receiver").toBeDefined();
    const timestamp = request.headers[HEADER.timestamp] as string;
    const signature = request.headers[HEADER.signature] as string;

    expect(
      signaturesMatch(signature, `v1=${signPayload(newSecret, timestamp, request.body)}`),
      "the request was signed with the secret captured before the rotation",
    ).toBe(true);
    expect(signaturesMatch(signature, `v1=${signPayload(oldSecret, timestamp, request.body)}`)).toBe(false);
  });

  it("skips a delivery re-claimed by somebody else, without a request or an attempt", async () => {
    const { second } = await twoQueued("Interleave steal caf\u00e9");
    const before = receiver.requests.length;

    const summary = await runInterleaved(second.deliveryId, async () => {
      // Somebody else takes the second row while the first is on the wire.
      await migratorPrisma().webhookDelivery.update({
        where: { id: second.deliveryId },
        data: { claimToken: randomUUID() },
      });
    });

    expect(summary.claimed).toBe(2);
    expect(summary.skipped).toBe(1);
    expect(receiver.requests.length - before).toBe(1);

    const row = await migratorPrisma().webhookDelivery.findFirstOrThrow({ where: { id: second.deliveryId } });
    expect(row.attemptCount, "a stolen row was attempted anyway").toBe(0);
    expect(await migratorPrisma().webhookDeliveryAttempt.count({ where: { deliveryId: second.deliveryId } })).toBe(0);
  });
});
