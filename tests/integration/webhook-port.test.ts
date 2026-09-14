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
import { WebhookPortError } from "@/server/errors";
import { DispatchContractError, parseDispatch, REQUIRED_PORT } from "@/egress/contract";
import { WEBHOOK_PORT } from "@/server/integrations/webhooks/address";
import { createDestination, listDestinations } from "@/server/integrations/webhooks/destinations";
import { createStampCafe, migratorPrisma, resetDatabase, type StampCafeFixture } from "../setup/fixtures";

/**
 * The port rule, at the moment the owner presses Save.
 *
 * The egress gateway has always refused anything but 443 — but it refuses at DISPATCH, which meant
 * an owner who typed `:8443` got a destination that saved, sat in the list looking configured, and
 * then failed every attempt with `GATEWAY_REJECTED`. A rule the product only tells you about after
 * you have already used it is not a rule the product has explained.
 *
 * Two things are asserted here and they are different:
 *
 *   1. the refusal happens **before anything exists** — no row, no ciphertext, no audit entry, no
 *      delivery, no secret shown to anybody;
 *   2. the gateway's own check is **unchanged**, because it is what still covers a row written
 *      before this rule existed, restored from a backup, or inserted by something that is not the
 *      create path.
 */

const HOST = "hooks.example.com";

let savedKey: string | undefined;
let cafe: StampCafeFixture;

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
  cafe = await createStampCafe({ name: "Port café" });
  session.userId = cafe.userId;
});

/** The route, called the way the screen calls it. */
async function post(body: unknown) {
  const res = await webhooksRoute(
    new Request("http://localhost:3000/api/staff/webhooks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  return { status: res.status, body: (await res.json()) as { error?: { code?: string; message?: string } } };
}

/** Everything that would exist if a save had got any distance at all. */
async function traces() {
  const db = migratorPrisma();
  const [destinations, deliveries, audits] = await Promise.all([
    db.webhookDestination.findMany({ where: { businessId: cafe.businessId } }),
    db.webhookDelivery.findMany({ where: { businessId: cafe.businessId } }),
    db.auditLog.findMany({ where: { businessId: cafe.businessId, entityType: "WebhookDestination" } }),
  ]);
  return { destinations, deliveries, audits };
}

describe("a port other than 443 is refused when the owner saves", () => {
  it("refuses an explicit non-443 port, http, and a malformed one", async () => {
    for (const url of [
      `https://${HOST}:8443/hook`,
      `https://${HOST}:80/hook`,
      `https://${HOST}:3000/hook`,
      `https://${HOST}:22/hook`,
      `https://${HOST}:1/hook`,
      `https://${HOST}:65535/hook`,
    ]) {
      await expect(createDestination(cafe.ctx, { name: `D ${url}`, url }), url).rejects.toBeInstanceOf(
        WebhookPortError,
      );
    }
  });

  it("refuses http, which never had a port this product would accept", async () => {
    // `http://host` has an effective port of 80 and is refused by the scheme rule first. Asserted
    // so that "effective port is not 443" is covered for a URL that names no port at all.
    for (const url of [`http://${HOST}/hook`, `http://${HOST}:443/hook`, `http://${HOST}:80/hook`]) {
      await expect(createDestination(cafe.ctx, { name: `D ${url}`, url }), url).rejects.toThrow(/https/i);
    }
  });

  it("refuses a malformed port without ever reaching the port rule", async () => {
    // `:abc` and `:99999` are not URLs the parser accepts, so they are refused earlier. What matters
    // is that they are refused, not which rule does it.
    for (const url of [`https://${HOST}:abc/hook`, `https://${HOST}:99999/hook`, `https://${HOST}:-1/hook`]) {
      await expect(createDestination(cafe.ctx, { name: `D ${url}`, url }), url).rejects.toThrow();
    }
  });

  it("leaves no row, no ciphertext, no audit record and no delivery behind", async () => {
    /*
     * The requirement that matters most. A refusal that happened after encryption, after the row,
     * or after the audit entry would leave a half-configured destination the owner cannot see and
     * cannot remove — and an audit trail claiming a destination was created.
     */
    const before = await traces();
    expect(before.destinations).toHaveLength(0);

    await expect(createDestination(cafe.ctx, { name: "Nope", url: `https://${HOST}:8443/hook` })).rejects.toBeInstanceOf(
      WebhookPortError,
    );

    const after = await traces();
    expect(after.destinations, "a destination row was written").toHaveLength(0);
    expect(after.deliveries, "a delivery was queued").toHaveLength(0);
    expect(after.audits, "an audit entry was written").toHaveLength(0);
    // And nothing the owner can list.
    expect(await listDestinations(cafe.ctx)).toHaveLength(0);
  });

  it("says one thing, and never repeats what was typed", async () => {
    /*
     * An endpoint's path or query can carry a token the receiver treats as authentication, and an
     * error message is the single most likely place for one to be copied into a screenshot or a
     * support ticket. So the message is a fixed sentence.
     */
    const secretish = `https://${HOST}:8443/hook?token=SUPER-SECRET-PATH-TOKEN`;
    let thrown: WebhookPortError | undefined;
    try {
      await createDestination(cafe.ctx, { name: "Nope", url: secretish });
    } catch (e) {
      thrown = e as WebhookPortError;
    }
    expect(thrown).toBeInstanceOf(WebhookPortError);
    expect(thrown?.message).toBe("Webhook endpoints must use HTTPS port 443");
    expect(thrown?.code).toBe("WEBHOOK_PORT_NOT_443");
    expect(thrown?.status).toBe(400);
    for (const fragment of [HOST, "8443", "/hook", "token", "SUPER-SECRET-PATH-TOKEN"]) {
      expect(thrown?.message, fragment).not.toContain(fragment);
    }
  });
});

describe("port 443 still saves, exactly as before", () => {
  it("accepts a plain https URL and creates a DISABLED destination", async () => {
    const created = await createDestination(cafe.ctx, { name: "Ops", url: `https://${HOST}/hook` });
    expect(created.destination.state).toBe("DISABLED");
    expect(created.destination.endpointHost).toBe(HOST);
    expect(created.signingSecret).toBeTruthy();

    const rows = await migratorPrisma().webhookDestination.findMany({ where: { businessId: cafe.businessId } });
    expect(rows).toHaveLength(1);
    // Encrypted, not plaintext — the save path is otherwise untouched.
    expect(rows[0].endpointCipher.startsWith("v1.")).toBe(true);
    expect(rows[0].endpointCipher).not.toContain(HOST);
  });

  it("accepts an explicit :443, and normalises it away", async () => {
    const created = await createDestination(cafe.ctx, { name: "Explicit", url: `https://${HOST}:443/hook` });
    expect(created.destination.state).toBe("DISABLED");
    expect(created.destination.endpointHost).toBe(HOST);
  });

  it("accepts a path and a query on 443", async () => {
    const created = await createDestination(cafe.ctx, { name: "Pathy", url: `https://${HOST}/a/b?c=d` });
    expect(created.destination.endpointHost).toBe(HOST);
  });

  it("writes an audit entry for the one that succeeded, and only that one", async () => {
    await expect(createDestination(cafe.ctx, { name: "Bad", url: `https://${HOST}:8443/hook` })).rejects.toThrow();
    await createDestination(cafe.ctx, { name: "Good", url: `https://${HOST}/hook` });
    const { audits, destinations } = await traces();
    expect(destinations).toHaveLength(1);
    expect(audits).toHaveLength(1);
  });
});

describe("the gateway's own port check is unchanged", () => {
  it("still refuses a non-443 dispatch, which is what covers rows this path never saw", () => {
    /*
     * Defence in depth, and the two halves are deliberately not the same check: the save path stops
     * an owner from configuring one, and this stops a row that exists anyway — written before the
     * rule, restored from a backup, or inserted directly — from being dispatched.
     */
    const body = JSON.stringify({
      url: `https://${HOST}:8443/hook`,
      body: "{}",
      headers: {
        "x-walaaplus-event-id": "e",
        "x-walaaplus-delivery-id": "d",
        "x-walaaplus-attempt": "1",
        "x-walaaplus-timestamp": "1700000000",
        "x-walaaplus-signature": "v1=deadbeef",
      },
    });
    expect(() => parseDispatch(body)).toThrow(DispatchContractError);
    expect(parseDispatch(body.replace(":8443", "")).port).toBe(REQUIRED_PORT);
  });

  it("shares ONE constant with the save path, so the two cannot drift", () => {
    expect(REQUIRED_PORT).toBe(WEBHOOK_PORT);
    expect(WEBHOOK_PORT).toBe(443);
  });
});

describe("the route says which rule was broken, and says nothing else", () => {
  it("answers 400 with a code the screen can key on", async () => {
    /*
     * The status alone was never enough: every other refusal on that form is also a 400, and the
     * screen renders "Check the address and try again" for all of them — which is no help at all to
     * an owner who typed a perfectly good address with `:8443` on the end. The CODE is what lets
     * the screen pick its own translated sentence.
     */
    const answer = await post({
      action: "create",
      businessId: cafe.businessId,
      name: "Ops",
      url: `https://${HOST}:8443/hook`,
    });
    expect(answer.status).toBe(400);
    expect(answer.body.error?.code).toBe("WEBHOOK_PORT_NOT_443");
  });

  it("puts nothing of the submitted address in the response", async () => {
    const answer = await post({
      action: "create",
      businessId: cafe.businessId,
      name: "Ops",
      url: `https://${HOST}:8443/hook?token=SUPER-SECRET-PATH-TOKEN`,
    });
    const serialized = JSON.stringify(answer.body);
    for (const fragment of [HOST, "8443", "/hook", "token", "SUPER-SECRET-PATH-TOKEN"]) {
      expect(serialized, fragment).not.toContain(fragment);
    }
  });

  it("creates nothing, and shows no secret, for a refused port", async () => {
    const answer = await post({
      action: "create",
      businessId: cafe.businessId,
      name: "Ops",
      url: `https://${HOST}:8443/hook`,
    });
    // The one response in this product that can carry a secret must not carry one here.
    expect(JSON.stringify(answer.body)).not.toContain("signingSecret");
    const after = await traces();
    expect(after.destinations).toHaveLength(0);
    expect(after.deliveries).toHaveLength(0);
    expect(after.audits).toHaveLength(0);
  });

  it("still creates a destination on 443, and returns the secret exactly once", async () => {
    const answer = await post({
      action: "create",
      businessId: cafe.businessId,
      name: "Ops",
      url: `https://${HOST}/hook`,
    });
    expect(answer.status).toBe(201);
    const created = answer.body as unknown as { destination: { state: string }; signingSecret: string };
    expect(created.destination.state).toBe("DISABLED");
    expect(created.signingSecret).toBeTruthy();
    // And the response never echoes the address back, on the happy path either.
    expect(JSON.stringify(created)).not.toContain("/hook");
  });
});

describe("the message the owner reads exists in both languages", () => {
  it("has an Integrations.errorPort in English and Arabic, and neither names a port but 443", async () => {
    /*
     * The screen keys on the error CODE and renders one of these; the server's own message is never
     * displayed. `tests/unit/message-parity.test.ts` is what holds every other key in step — this
     * asserts the one sentence this correction exists to produce, in both files, and that neither
     * of them invites an owner to try a different port.
     */
    const [en, ar] = await Promise.all([
      import("../../messages/en.json").then((m) => m.default as unknown as Record<string, Record<string, string>>),
      import("../../messages/ar.json").then((m) => m.default as unknown as Record<string, Record<string, string>>),
    ]);
    expect(en.Integrations.errorPort).toContain("443");
    expect(ar.Integrations.errorPort).toContain("443");
    expect(en.Integrations.errorPort).not.toBe(ar.Integrations.errorPort);
    // The hint on the field says the same thing before the owner submits.
    expect(en.Integrations.urlHint).toContain("443");
    expect(ar.Integrations.urlHint).toContain("443");
  });
});
