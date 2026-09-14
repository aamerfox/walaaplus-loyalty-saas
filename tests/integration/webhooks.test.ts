import { randomBytes } from "node:crypto";
import { MembershipRole } from "@prisma/client";
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

import { POST as promotionsRoute } from "@/app/api/staff/promotions/route";
import { POST as webhooksRoute } from "@/app/api/staff/webhooks/route";
import { AuditAction } from "@/server/audit/audit";
import { prisma } from "@/server/db";
import { ForbiddenError } from "@/server/errors";
import { decryptSecret } from "@/server/integrations/webhooks/crypto";
import {
  createDestination,
  listDeliveries,
  listDestinations,
  MAX_DESTINATIONS_PER_BUSINESS,
  queueTestDelivery,
  rotateSecret,
  setDestinationState,
  webhooksConfigured,
} from "@/server/integrations/webhooks/destinations";
import { redeemCoupon } from "@/server/promotions/redemption";
import {
  createStampCafe,
  enrolCustomer,
  migratorPrisma,
  resetDatabase,
  uniqueSyrianPhone,
  type StampCafeFixture,
} from "../setup/fixtures";

/**
 * Webhook destinations through the services and the route that reach them.
 *
 * `webhook-integrity.test.ts` proves the DATABASE refuses a wrong row; `webhook-delivery.test.ts`
 * proves the worker's side. This proves the owner's side: who may do what, that the secret is shown
 * exactly once, that the URL never comes back, and that the outbox is written in the same
 * transaction as the event.
 *
 * **The encryption key is generated here, in memory, per run.** No value for
 * `INTEGRATION_ENCRYPTION_KEY` exists in this repository.
 */

const CODE = "AUTUMN10";
const URL_A = "https://hooks.example.com/walaaplus";
const URL_B = "https://hooks.example.net/other";

let savedKey: string | undefined;

beforeAll(() => {
  savedKey = process.env.INTEGRATION_ENCRYPTION_KEY;
  process.env.INTEGRATION_ENCRYPTION_KEY = randomBytes(32).toString("hex");
});

afterAll(() => {
  if (savedKey === undefined) delete process.env.INTEGRATION_ENCRYPTION_KEY;
  else process.env.INTEGRATION_ENCRYPTION_KEY = savedKey;
});

async function call(handler: (req: Request) => Promise<Response>, path: string, body: unknown) {
  const res = await handler(
    new Request(`http://localhost${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  return { status: res.status, body: (await res.json().catch(() => null)) as Record<string, unknown> | null };
}

const webhooks = (body: unknown) => call(webhooksRoute, "/api/staff/webhooks", body);
const promotions = (body: unknown) => call(promotionsRoute, "/api/staff/promotions", body);

async function cafe(name: string): Promise<StampCafeFixture> {
  const fx = await createStampCafe({ name });
  session.userId = fx.userId;
  return fx;
}

describe("only the owner may manage a destination", () => {
  let fx: StampCafeFixture;

  beforeEach(async () => {
    await resetDatabase();
    fx = await cafe("Owner café");
  });

  it("lets the owner create one", async () => {
    const created = await createDestination(fx.ctx, { name: "Ops", url: URL_A });
    expect(created.destination.endpointHost).toBe("hooks.example.com");
    expect(created.signingSecret.length).toBeGreaterThan(20);
  });

  it("refuses a manager, everywhere", async () => {
    /*
     * Stricter than every other screen in this product, and deliberately. A destination is a
     * standing instruction to send this business's activity to a third party; a manager who could
     * create one could arrange for every redemption to be copied somewhere the owner never looked.
     */
    const manager = { ...fx.ctx, role: MembershipRole.MANAGER };
    const created = await createDestination(fx.ctx, { name: "Ops", url: URL_A });
    const id = created.destination.id;

    await expect(listDestinations(manager)).rejects.toThrow(ForbiddenError);
    await expect(createDestination(manager, { name: "Theirs", url: URL_B })).rejects.toThrow(ForbiddenError);
    await expect(setDestinationState(manager, id, "ENABLED")).rejects.toThrow(ForbiddenError);
    await expect(rotateSecret(manager, id)).rejects.toThrow(ForbiddenError);
    await expect(queueTestDelivery(manager, id)).rejects.toThrow(ForbiddenError);
    await expect(listDeliveries(manager, id)).rejects.toThrow(ForbiddenError);
  });

  it("refuses a cashier, everywhere", async () => {
    const cashier = { ...fx.ctx, role: MembershipRole.CASHIER };
    const created = await createDestination(fx.ctx, { name: "Ops", url: URL_A });
    for (const attempt of [
      () => listDestinations(cashier),
      () => createDestination(cashier, { name: "Theirs", url: URL_B }),
      () => setDestinationState(cashier, created.destination.id, "ENABLED"),
      () => rotateSecret(cashier, created.destination.id),
      () => queueTestDelivery(cashier, created.destination.id),
    ]) {
      await expect(attempt()).rejects.toThrow(ForbiddenError);
    }
  });

  it("refuses a manager at the route, not only in the service", async () => {
    await prisma.businessMembership.updateMany({
      where: { businessId: fx.businessId, userId: fx.userId },
      data: { role: "MANAGER" },
    });
    const res = await webhooks({ action: "create", businessId: fx.businessId, name: "Ops", url: URL_A });
    expect(res.status).toBe(403);
    expect(await migratorPrisma().webhookDestination.count({ where: { businessId: fx.businessId } })).toBe(0);
  });

  it("shows one business nothing of another's", async () => {
    await createDestination(fx.ctx, { name: "Ops", url: URL_A });
    const other = await cafe("Other café");
    await createDestination(other.ctx, { name: "Theirs", url: URL_B });

    session.userId = fx.userId;
    const mine = await listDestinations(fx.ctx);
    expect(mine).toHaveLength(1);
    expect(mine[0].name).toBe("Ops");
  });
});

describe("a destination begins disabled and receives nothing", () => {
  let fx: StampCafeFixture;

  beforeEach(async () => {
    await resetDatabase();
    fx = await cafe("Lifecycle café");
  });

  it("is created disabled, whatever a caller asks for", async () => {
    const created = await createDestination(fx.ctx, { name: "Ops", url: URL_A });
    expect(created.destination.state).toBe("DISABLED");
    // The route has no way to ask for another state either.
    const res = await webhooks({
      action: "create",
      businessId: fx.businessId,
      name: "Second",
      url: URL_B,
      state: "ENABLED",
    });
    expect(res.status).toBe(400);
  });

  it("gets no delivery for an event while it is disabled", async () => {
    const created = await createDestination(fx.ctx, { name: "Ops", url: URL_A });
    await redeemThroughTill(fx);
    expect(await migratorPrisma().webhookDelivery.count({ where: { destinationId: created.destination.id } })).toBe(0);
  });

  it("gets one delivery per event once enabled", async () => {
    const created = await createDestination(fx.ctx, { name: "Ops", url: URL_A });
    await setDestinationState(fx.ctx, created.destination.id, "ENABLED");
    await redeemThroughTill(fx);

    const deliveries = await migratorPrisma().webhookDelivery.findMany({
      where: { destinationId: created.destination.id },
    });
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0].status).toBe("PENDING");
    expect(deliveries[0].isTest).toBe(false);
    expect(deliveries[0].integrationEventId).toBeTruthy();
  });

  it("does not backfill an event that happened before it was enabled", async () => {
    // The same rule as Prompt 1, one layer out: an obligation created later would claim a decision
    // was taken at a moment when it was not.
    const created = await createDestination(fx.ctx, { name: "Ops", url: URL_A });
    await redeemThroughTill(fx);
    await setDestinationState(fx.ctx, created.destination.id, "ENABLED");
    expect(await migratorPrisma().webhookDelivery.count({ where: { destinationId: created.destination.id } })).toBe(0);
  });

  it("stops receiving when disabled again, and revoking is terminal", async () => {
    const created = await createDestination(fx.ctx, { name: "Ops", url: URL_A });
    const id = created.destination.id;
    await setDestinationState(fx.ctx, id, "ENABLED");
    await setDestinationState(fx.ctx, id, "DISABLED");
    await redeemThroughTill(fx);
    expect(await migratorPrisma().webhookDelivery.count({ where: { destinationId: id } })).toBe(0);

    await setDestinationState(fx.ctx, id, "REVOKED");
    await expect(setDestinationState(fx.ctx, id, "ENABLED")).rejects.toThrow();
    await expect(rotateSecret(fx.ctx, id)).rejects.toThrow();
    await expect(queueTestDelivery(fx.ctx, id)).rejects.toThrow();
  });
});

describe("the secret is shown once and the URL never", () => {
  let fx: StampCafeFixture;

  beforeEach(async () => {
    await resetDatabase();
    fx = await cafe("Secret café");
  });

  it("returns the secret at creation and from no other path", async () => {
    const created = await createDestination(fx.ctx, { name: "Ops", url: URL_A });
    const secret = created.signingSecret;

    // Not in the list, not in the deliveries, not in the route's own responses.
    const listed = JSON.stringify(await listDestinations(fx.ctx));
    expect(listed).not.toContain(secret);
    expect(listed).not.toContain(URL_A);
    expect(listed).not.toContain("endpointCipher");
    expect(listed).not.toContain("signingSecretCipher");

    // There is no reveal action to call.
    const reveal = await webhooks({ action: "reveal", businessId: fx.businessId, destinationId: created.destination.id });
    expect(reveal.status).toBe(400);
  });

  it("stores the URL and the secret only as ciphertext", async () => {
    const created = await createDestination(fx.ctx, { name: "Ops", url: URL_A });
    const row = await migratorPrisma().webhookDestination.findFirstOrThrow({
      where: { id: created.destination.id },
    });
    const serialized = JSON.stringify(row);
    expect(serialized).not.toContain(created.signingSecret);
    expect(serialized).not.toContain("/walaaplus");
    // The host is plaintext on purpose, and it is the only part of the URL that is.
    expect(row.endpointHost).toBe("hooks.example.com");
    expect(row.cipherAlgorithm).toBe("AES_256_GCM");
    expect(row.cipherKeyVersion).toBe(1);
    // And it really is the URL underneath.
    expect(decryptSecret(row.endpointCipher)).toBe(`${URL_A}`);
    expect(decryptSecret(row.signingSecretCipher)).toBe(created.signingSecret);
  });

  it("issues a different secret on rotation and stops the old one working", async () => {
    const created = await createDestination(fx.ctx, { name: "Ops", url: URL_A });
    const rotated = await rotateSecret(fx.ctx, created.destination.id);
    expect(rotated.signingSecret).not.toBe(created.signingSecret);

    const row = await migratorPrisma().webhookDestination.findFirstOrThrow({
      where: { id: created.destination.id },
    });
    expect(decryptSecret(row.signingSecretCipher)).toBe(rotated.signingSecret);
    expect(decryptSecret(row.signingSecretCipher)).not.toBe(created.signingSecret);
    // The disclosure time moved with it; the trigger refuses one without the other.
    expect(row.secretIssuedAt.getTime()).toBeGreaterThanOrEqual(created.destination.secretIssuedAt.getTime());
  });

  it("keeps the secret, the URL and the ciphertext out of every audit row", async () => {
    const created = await createDestination(fx.ctx, { name: "Ops", url: URL_A });
    await setDestinationState(fx.ctx, created.destination.id, "ENABLED");
    await rotateSecret(fx.ctx, created.destination.id);
    await queueTestDelivery(fx.ctx, created.destination.id);

    const row = await migratorPrisma().webhookDestination.findFirstOrThrow({
      where: { id: created.destination.id },
    });
    const audits = await prisma.auditLog.findMany({ where: { businessId: fx.businessId } });
    const serialized = JSON.stringify(audits);

    for (const secret of [created.signingSecret, URL_A, "/walaaplus", row.endpointCipher, row.signingSecretCipher]) {
      expect(serialized, secret.slice(0, 16)).not.toContain(secret);
    }
    // The host is there, because a person reading an audit trail needs to know where it went.
    expect(serialized).toContain("hooks.example.com");
    expect(audits.map((a) => a.action)).toContain(AuditAction.WEBHOOK_TEST_QUEUED);
  });
});

describe("the URL is judged before anything is stored", () => {
  let fx: StampCafeFixture;

  beforeEach(async () => {
    await resetDatabase();
    fx = await cafe("SSRF café");
  });

  it("refuses every unsafe address at the route, and writes nothing", async () => {
    for (const url of [
      "http://hooks.example.com/x",
      "https://127.0.0.1/x",
      "https://localhost/x",
      "https://10.0.0.1/x",
      "https://user:pass@hooks.example.com/x",
      "https://metadata.internal/x",
      "https://router/x",
      "file:///etc/passwd",
    ]) {
      const res = await webhooks({ action: "create", businessId: fx.businessId, name: `n-${url}`, url });
      expect(res.status, url).toBe(400);
    }
    expect(await migratorPrisma().webhookDestination.count({ where: { businessId: fx.businessId } })).toBe(0);
  });

  it("refuses a duplicate endpoint and a duplicate name without saying which", async () => {
    await createDestination(fx.ctx, { name: "Ops", url: URL_A });
    const sameUrl = await webhooks({ action: "create", businessId: fx.businessId, name: "Different", url: URL_A });
    expect(sameUrl.status).toBe(409);
    expect(JSON.stringify(sameUrl.body)).toMatch(/name or address/i);

    const sameName = await webhooks({ action: "create", businessId: fx.businessId, name: "Ops", url: URL_B });
    expect(sameName.status).toBe(409);
  });

  it("bounds how many a business may keep", async () => {
    for (let i = 0; i < MAX_DESTINATIONS_PER_BUSINESS; i += 1) {
      await createDestination(fx.ctx, { name: `Ops ${i}`, url: `https://hooks.example.com/x${i}` });
    }
    await expect(
      createDestination(fx.ctx, { name: "One too many", url: "https://hooks.example.com/overflow" }),
    ).rejects.toThrow(/at most/);
  });
});

describe("a test delivery is synthetic and never automatic", () => {
  let fx: StampCafeFixture;

  beforeEach(async () => {
    await resetDatabase();
    fx = await cafe("Test café");
  });

  it("queues a row that names no event", async () => {
    const created = await createDestination(fx.ctx, { name: "Ops", url: URL_A });
    const { deliveryId } = await queueTestDelivery(fx.ctx, created.destination.id);

    const row = await migratorPrisma().webhookDelivery.findFirstOrThrow({ where: { id: deliveryId } });
    expect(row.isTest).toBe(true);
    expect(row.integrationEventId).toBeNull();
    expect(row.status).toBe("PENDING");
  });

  it("works while the destination is still disabled, which is the point of a test", async () => {
    const created = await createDestination(fx.ctx, { name: "Ops", url: URL_A });
    expect(created.destination.state).toBe("DISABLED");
    await expect(queueTestDelivery(fx.ctx, created.destination.id)).resolves.toBeTruthy();
  });

  it("is never produced by anything but the owner asking", async () => {
    const created = await createDestination(fx.ctx, { name: "Ops", url: URL_A });
    await setDestinationState(fx.ctx, created.destination.id, "ENABLED");
    // A real event produces a real delivery, never a test one.
    await redeemThroughTill(fx);
    const tests = await migratorPrisma().webhookDelivery.count({
      where: { businessId: fx.businessId, isTest: true },
    });
    expect(tests).toBe(0);
  });

  it("returns 202 from the route, because it queues rather than sends", async () => {
    const created = await createDestination(fx.ctx, { name: "Ops", url: URL_A });
    const res = await webhooks({ action: "test", businessId: fx.businessId, destinationId: created.destination.id });
    expect(res.status).toBe(202);
    expect(res.body).toHaveProperty("deliveryId");
  });
});

describe("without the encryption key, everything webhook fails closed", () => {
  let fx: StampCafeFixture;

  beforeEach(async () => {
    await resetDatabase();
    fx = await cafe("Keyless café");
  });

  it("refuses to create or test, and says the deployment is not configured", async () => {
    const key = process.env.INTEGRATION_ENCRYPTION_KEY;
    delete process.env.INTEGRATION_ENCRYPTION_KEY;
    try {
      expect(webhooksConfigured()).toBe(false);
      await expect(createDestination(fx.ctx, { name: "Ops", url: URL_A })).rejects.toThrow(
        /INTEGRATION_ENCRYPTION_KEY/,
      );
      expect(await migratorPrisma().webhookDestination.count({ where: { businessId: fx.businessId } })).toBe(0);
    } finally {
      process.env.INTEGRATION_ENCRYPTION_KEY = key;
    }
  });

  it("leaves the till, the ledger and B7 completely alone", async () => {
    /*
     * The promise that makes the fail-closed design acceptable. Without the key a merchant cannot
     * configure a webhook, and everything they actually sell with keeps working.
     */
    const key = process.env.INTEGRATION_ENCRYPTION_KEY;
    delete process.env.INTEGRATION_ENCRYPTION_KEY;
    try {
      const outcome = await redeemThroughTill(fx);
      expect(outcome).toBe("RECORDED");

      const enroll = await import("@/app/api/enroll/route");
      expect((await enroll.GET()).status).toBe(410);
      expect((await enroll.POST()).status).toBe(410);

      // And the event itself was still written, because it does not touch the crypto.
      expect(await migratorPrisma().integrationEvent.count({ where: { businessId: fx.businessId } })).toBe(1);
    } finally {
      process.env.INTEGRATION_ENCRYPTION_KEY = key;
    }
  });
});

/** Create an active promotion and redeem it at the till. Returns the outcome. */
async function redeemThroughTill(fx: StampCafeFixture): Promise<string> {
  session.userId = fx.userId;
  const existing = await prisma.promotion.findFirst({ where: { businessId: fx.businessId }, select: { id: true } });
  let promotionId = existing?.id;
  if (!promotionId) {
    const created = await promotions({
      action: "create",
      businessId: fx.businessId,
      name: "Autumn offer",
      benefitDescription: "A free espresso",
      code: CODE,
    });
    promotionId = String((created.body as unknown as { id: string }).id);
    await promotions({ action: "setState", businessId: fx.businessId, promotionId, state: "ACTIVE" });
  }
  const customer = await enrolCustomer(fx, { phone: uniqueSyrianPhone(), firstName: "ليلى" });
  const result = await redeemCoupon(fx.ctx, { code: CODE, customerCardId: customer.customerCardId });
  return result.outcome;
}
