import { randomBytes, randomUUID } from "node:crypto";
import { ApiScope, PromotionState } from "@prisma/client";
import { beforeEach, describe, expect, it } from "vitest";

import { GET as eventRoute } from "@/app/api/v1/events/[eventId]/route";
import { GET as eventsRoute } from "@/app/api/v1/events/route";
import { hasScope, type ApiContext } from "@/server/api/auth";
import { MAX_PAGE_SIZE } from "@/server/api/contract";
import { signCursor, verifyCursor } from "@/server/api/cursor";
import { createKey, revokeKey } from "@/server/api/keys";
import { API_RATE_LIMIT_MAX } from "@/server/api/rate-limit";
import { createPromotion, setPromotionState } from "@/server/promotions/promotions";
import { redeemCoupon, voidRedemption } from "@/server/promotions/redemption";
import {
  createStampCafe,
  enrolCustomer,
  migratorPrisma,
  resetDatabase,
  uniqueSyrianPhone,
  type StampCafeFixture,
} from "../setup/fixtures";

/**
 * `/api/v1` — the first surface in this product that somebody outside it can reach.
 *
 * Everything here goes through the real route handlers, with a real key, against a real database.
 * Nothing about authentication, tenancy or pagination is stubbed, because the whole value of these
 * tests is that they exercise the same code path a merchant's server will.
 *
 * `api-keys.test.ts` proves the key; this proves what the key opens.
 */

const CODE = "AUTUMN10";

// ── calling the routes ───────────────────────────────────────────────────────────────────────

interface Answer {
  status: number;
  body: Record<string, unknown>;
  headers: Headers;
}

async function answer(res: Response): Promise<Answer> {
  return {
    status: res.status,
    body: ((await res.json().catch(() => null)) ?? {}) as Record<string, unknown>,
    headers: res.headers,
  };
}

/** `GET /api/v1/events`, with an optional key and an optional query string. */
function listEvents(key: string | null, query = ""): Promise<Answer> {
  const headers = new Headers();
  if (key !== null) headers.set("x-api-key", key);
  return eventsRoute(new Request(`http://localhost/api/v1/events${query}`, { headers })).then(answer);
}

/** `GET /api/v1/events/{id}`. */
function readEvent(key: string | null, eventId: string): Promise<Answer> {
  const headers = new Headers();
  if (key !== null) headers.set("x-api-key", key);
  return eventRoute(new Request(`http://localhost/api/v1/events/${eventId}`, { headers }), {
    params: Promise.resolve({ eventId }),
  }).then(answer);
}

type EventItem = { id: string; type: string; entityType: string; entityId: string; occurredAt: string; envelopeVersion: number };

function items(a: Answer): EventItem[] {
  return (a.body.data ?? []) as EventItem[];
}
function nextCursor(a: Answer): string | null {
  return ((a.body.page ?? {}) as { nextCursor?: string | null }).nextCursor ?? null;
}

// ── building a business with a real event history ────────────────────────────────────────────

interface World {
  cafe: StampCafeFixture;
  apiKey: string;
  /** Event ids, newest first — the order `/api/v1/events` must return them in. */
  eventIds: string[];
}

/**
 * A café with `redemptions` recorded events and `voids` further voided ones.
 *
 * Every event is produced by a real workflow. That matters more than convenience here: the
 * `IntegrationEvent` trigger refuses a row that was not written in the same transaction as the
 * redemption it names, so an event history assembled by hand would not be one the product can
 * actually produce.
 */
async function build(name: string, redemptions: number, voids = 0): Promise<World> {
  const cafe = await createStampCafe({ name });
  const promotion = await createPromotion(cafe.ctx, {
    name: `${name} offer`,
    benefitDescription: "A free espresso",
    code: CODE,
  });
  await setPromotionState(cafe.ctx, promotion.id, PromotionState.ACTIVE);

  const redemptionIds: string[] = [];
  for (let i = 0; i < redemptions; i += 1) {
    const customer = await enrolCustomer(cafe, { phone: uniqueSyrianPhone(), firstName: "ليلى" });
    const result = await redeemCoupon(cafe.ctx, { code: CODE, customerCardId: customer.customerCardId });
    if (result.outcome !== "RECORDED") throw new Error(`redemption ${i} was ${result.outcome}`);
    redemptionIds.push(result.redemptionId);
  }
  for (let i = 0; i < voids; i += 1) {
    await voidRedemption(cafe.ctx, redemptionIds[i], "the customer changed their mind");
  }

  const created = await createKey(cafe.ctx, { name: "Reader" });
  const stored = await migratorPrisma().integrationEvent.findMany({
    where: { businessId: cafe.businessId },
    orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
    select: { id: true },
  });
  return { cafe, apiKey: created.apiKey, eventIds: stored.map((e) => e.id) };
}

/** A well-formed key that was never issued. */
function strangerKey(): string {
  return `wpk_${randomBytes(4).toString("hex")}_${randomBytes(32).toString("base64url")}`;
}

beforeEach(async () => {
  await resetDatabase();
});

// ── authentication ───────────────────────────────────────────────────────────────────────────

describe("the header is the only way in", () => {
  it("serves a valid key and refuses every other condition with the same answer", async () => {
    const w = await build("Café A", 2);

    const ok = await listEvents(w.apiKey);
    expect(ok.status).toBe(200);
    expect(items(ok)).toHaveLength(2);

    const revoked = await createKey(w.cafe.ctx, { name: "Revoked" });
    await revokeKey(w.cafe.ctx, revoked.key.id);

    const expired = await createKey(w.cafe.ctx, { name: "Expired" });
    await lapse(expired.key.id);

    const refusals = await Promise.all([
      listEvents(null),
      listEvents(""),
      listEvents("not-a-key"),
      listEvents(strangerKey()),
      listEvents(revoked.apiKey),
      listEvents(expired.apiKey),
    ]);

    for (const r of refusals) expect(r.status).toBe(401);
    // Byte-identical bodies. A caller cannot tell "never existed" from "revoked yesterday".
    const rendered = new Set(refusals.map((r) => JSON.stringify(r.body)));
    expect(rendered.size, "every refusal must render the same body").toBe(1);
    expect([...rendered][0]).not.toMatch(/revoked|expired|unknown|malformed|missing/i);
  });

  it("does not accept a key from the query string, a cookie or anywhere but the header", async () => {
    const w = await build("Café Q", 1);

    // In the URL and nowhere else: refused, and refused as a bad request rather than served.
    const inUrl = await listEvents(null, `?api_key=${encodeURIComponent(w.apiKey)}`);
    expect(inUrl.status).toBe(400);
    expect(String((inUrl.body.error as { code: string }).code)).toBe("BAD_REQUEST");
    // The parameter's NAME, never its value.
    expect(JSON.stringify(inUrl.body)).toContain("api_key");
    expect(JSON.stringify(inUrl.body)).not.toContain(w.apiKey);
    expect(JSON.stringify(inUrl.body)).not.toContain(w.apiKey.slice(13));

    // A cookie carrying the key is simply not read, so this is the ordinary refusal.
    const viaCookie = await eventsRoute(
      new Request("http://localhost/api/v1/events", { headers: { cookie: `x-api-key=${w.apiKey}` } }),
    ).then(answer);
    expect(viaCookie.status).toBe(401);
  });

  it("refuses a credential-shaped parameter BEFORE authenticating, even with a good header", async () => {
    /*
     * The order is the point. If the refusal came after authentication, a merchant experimenting
     * with `?api_key=` would be served, learn nothing, and keep putting their key in URLs — where a
     * proxy log, a browser history and an analytics row all keep a copy we cannot reach.
     */
    const w = await build("Café P", 1);
    for (const name of ["api_key", "apiKey", "API-KEY", "key", "token", "secret", "access_token", "authorization"]) {
      const r = await listEvents(w.apiKey, `?${name}=anything`);
      expect(r.status, name).toBe(400);
      expect(String((r.body.error as { code: string }).code), name).toBe("BAD_REQUEST");
    }
    // And an ordinary unknown parameter is ignored, not refused.
    const harmless = await listEvents(w.apiKey, "?page=2&unknown=x");
    expect(harmless.status).toBe(200);
  });

  it("asks for the events:read scope, and a context without it is refused by hasScope", () => {
    /*
     * The 403 branch is live and is currently unreachable end to end: `ApiScope` has exactly one
     * value, every key is issued with it, and the database will not accept another. Rather than
     * fake a second scope, this asserts the two halves that are real — the routes demand the scope,
     * and the predicate they demand it with says no when it is absent.
     *
     * The day a second scope is added, a key carrying only that one produces the 403 through this
     * same path, and `guardApiRequest` needs no change.
     */
    const withoutScope = { businessId: "b", apiKeyId: "k", scopes: new Set<ApiScope>() } as ApiContext;
    expect(hasScope(withoutScope, ApiScope.EVENTS_READ)).toBe(false);
    const withScope = { businessId: "b", apiKeyId: "k", scopes: new Set([ApiScope.EVENTS_READ]) } as ApiContext;
    expect(hasScope(withScope, ApiScope.EVENTS_READ)).toBe(true);
  });
});

// ── what a response is allowed to contain ────────────────────────────────────────────────────

describe("an event on the wire carries six fields and no more", () => {
  it("has exactly the agreed shape", async () => {
    const w = await build("Café S", 1);
    const page = await listEvents(w.apiKey);

    expect(page.body.apiVersion).toBe("v1");
    expect(Object.keys(page.body).sort()).toEqual(["apiVersion", "data", "page"]);

    const [event] = items(page);
    expect(Object.keys(event).sort()).toEqual([
      "entityId",
      "entityType",
      "envelopeVersion",
      "id",
      "occurredAt",
      "type",
    ]);
    expect(event.type).toBe("PROMOTION_REDEMPTION_RECORDED");
    expect(event.entityType).toBe("PROMOTION_REDEMPTION");
    expect(event.envelopeVersion).toBe(1);
    expect(event.occurredAt).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
  });

  it("omits the tenant and the second timestamp deliberately", async () => {
    const w = await build("Café T", 1);
    const serialised = JSON.stringify((await listEvents(w.apiKey)).body);
    // The key already determines the business; a field that looks like a tenant selector is one a
    // client eventually tries to set.
    expect(serialised).not.toContain(w.cafe.businessId);
    expect(serialised).not.toContain("businessId");
    expect(serialised).not.toContain("createdAt");
  });

  it("carries nothing about the customer whose redemption it describes", async () => {
    const cafe = await createStampCafe({ name: "Café U" });
    const promotion = await createPromotion(cafe.ctx, {
      name: "Autumn offer",
      benefitDescription: "A free espresso",
      code: CODE,
    });
    await setPromotionState(cafe.ctx, promotion.id, PromotionState.ACTIVE);

    const phone = uniqueSyrianPhone();
    const customer = await enrolCustomer(cafe, { phone, firstName: "ليلى", lastName: "الحسيني" });
    const result = await redeemCoupon(cafe.ctx, { code: CODE, customerCardId: customer.customerCardId });
    if (result.outcome !== "RECORDED") throw new Error("expected a redemption");

    const created = await createKey(cafe.ctx, { name: "Reader" });
    const serialised = JSON.stringify((await listEvents(created.apiKey)).body);

    // Not the person, not their number, not their card, not the promotion, not the code.
    for (const secret of [phone, phone.slice(-6), "ليلى", "الحسيني", customer.customerCardId, promotion.id, CODE]) {
      expect(serialised, `response must not contain ${secret.slice(0, 12)}`).not.toContain(secret);
    }
    // The redemption id IS there — it is the correlation key, and it is an internal uuid of this
    // business holding nothing about anybody.
    expect(serialised).toContain(result.redemptionId);
  });

  it("never carries the key, its digest or its prefix back", async () => {
    const w = await build("Café V", 1);
    const row = await migratorPrisma().apiKey.findFirstOrThrow({
      where: { businessId: w.cafe.businessId },
      select: { keyDigest: true, keyPrefix: true },
    });
    for (const a of [await listEvents(w.apiKey), await readEvent(w.apiKey, w.eventIds[0]), await listEvents("bad")]) {
      const serialised = JSON.stringify(a.body);
      expect(serialised).not.toContain(w.apiKey);
      expect(serialised).not.toContain(w.apiKey.slice(13));
      expect(serialised).not.toContain(row.keyDigest);
      expect(serialised).not.toContain(row.keyPrefix);
    }
  });
});

// ── tenancy ──────────────────────────────────────────────────────────────────────────────────

describe("a key sees one business and cannot be argued out of it", () => {
  it("returns only its own events, and another tenant's id is a 404", async () => {
    const a = await build("Café A", 3);
    const b = await build("Café B", 2);

    const mine = await listEvents(a.apiKey);
    expect(items(mine).map((e) => e.id).sort()).toEqual([...a.eventIds].sort());
    for (const id of b.eventIds) expect(items(mine).map((e) => e.id)).not.toContain(id);

    // Another tenant's event, and an id that never existed, get the identical answer.
    const theirs = await readEvent(a.apiKey, b.eventIds[0]);
    const nothing = await readEvent(a.apiKey, randomUUID());
    expect(theirs.status).toBe(404);
    expect(nothing.status).toBe(404);
    expect(JSON.stringify(theirs.body)).toBe(JSON.stringify(nothing.body));
    expect(JSON.stringify(theirs.body)).not.toContain(b.eventIds[0]);
  });

  it("refuses a cursor minted for another business, rather than quietly reinterpreting it", async () => {
    /*
     * This behaviour changed under review, and the change is the point of the fix.
     *
     * Cursors used to be unsigned, so a cursor minted for business A and replayed with B's key was
     * simply honoured as a position in B's feed: safe, because the tenant filter comes from the
     * key, but silent. A forged cursor was indistinguishable from one we issued.
     *
     * Now the cursor is bound to the business it was minted for, so this is a 400. Nothing is read,
     * and the caller is told their cursor is not one this API issued — which is true, for them.
     */
    const a = await build("Café A", 4);
    const b = await build("Café B", 4);

    const aPage = await listEvents(a.apiKey, "?limit=2");
    const aCursor = nextCursor(aPage);
    expect(aCursor).not.toBeNull();

    const replayed = await listEvents(b.apiKey, `?limit=10&cursor=${encodeURIComponent(aCursor!)}`);
    expect(replayed.status).toBe(400);
    expect(String((replayed.body.error as { code: string }).code)).toBe("BAD_REQUEST");
    // Not echoed, and nothing of either tenant's feed came back.
    expect(JSON.stringify(replayed.body)).not.toContain(aCursor!.slice(0, 20));
    expect(replayed.body).not.toHaveProperty("data");

    // A's own cursor still works for A, so the refusal is about the binding and not the cursor.
    const mine = await listEvents(a.apiKey, `?limit=10&cursor=${encodeURIComponent(aCursor!)}`);
    expect(mine.status).toBe(200);
  });

  it("refuses a hand-built cursor naming another tenant's row, without reading a row", async () => {
    const a = await build("Café A", 3);
    const b = await build("Café B", 3);

    const stolen = await migratorPrisma().integrationEvent.findFirstOrThrow({
      where: { businessId: b.cafe.businessId },
      orderBy: { occurredAt: "asc" },
      select: { id: true, occurredAt: true },
    });

    // Signed for B — a perfectly valid cursor, for somebody else.
    const forB = signCursor({ at: stolen.occurredAt.toISOString(), id: stolen.id }, { businessId: b.cafe.businessId });
    const refused = await listEvents(a.apiKey, `?cursor=${encodeURIComponent(forB)}`);
    expect(refused.status).toBe(400);

    // And signed for A but naming B's row: the MAC passes, the tenant filter still holds, and the
    // page contains only A's events. Signing is not a substitute for the WHERE clause.
    const forA = signCursor({ at: stolen.occurredAt.toISOString(), id: stolen.id }, { businessId: a.cafe.businessId });
    const page = await listEvents(a.apiKey, `?cursor=${encodeURIComponent(forA)}`);
    expect(page.status).toBe(200);
    for (const event of items(page)) expect(a.eventIds).toContain(event.id);
  });

  it("refuses a cursor whose position was altered after we signed it", async () => {
    const w = await build("Café Tamper", 4);
    const page = await listEvents(w.apiKey, "?limit=2");
    const issued = nextCursor(page);
    expect(issued).not.toBeNull();

    const [format, payload, mac] = issued!.split(".");
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { at: string; id: string };

    const forgeries = [
      // A moved timestamp, which is how a caller would try to widen their window.
      `${format}.${Buffer.from(JSON.stringify({ ...decoded, at: "2099-01-01T00:00:00.000Z" })).toString("base64url")}.${mac}`,
      // A different row id.
      `${format}.${Buffer.from(JSON.stringify({ ...decoded, id: randomUUID() })).toString("base64url")}.${mac}`,
      // The signature itself.
      `${format}.${payload}.${"A".repeat(43)}`,
      // The unsigned format this API used to issue.
      Buffer.from(JSON.stringify(decoded), "utf8").toString("base64url"),
    ];

    for (const forged of forgeries) {
      const answer = await listEvents(w.apiKey, `?cursor=${encodeURIComponent(forged)}`);
      expect(answer.status, forged.slice(0, 24)).toBe(400);
      expect(String((answer.body.error as { code: string }).code)).toBe("BAD_REQUEST");
      expect(answer.body, "a refused cursor returns no rows").not.toHaveProperty("data");
      expect(JSON.stringify(answer.body)).not.toContain(forged.slice(0, 20));
    }

    // The one we actually issued still works, so none of the above failed for another reason.
    expect((await listEvents(w.apiKey, `?limit=10&cursor=${encodeURIComponent(issued!)}`)).status).toBe(200);
  });
});

// ── pagination ───────────────────────────────────────────────────────────────────────────────

describe("paging through the feed", () => {
  it("returns newest first, and the whole feed exactly once across pages", async () => {
    const w = await build("Café Pager", 5, 2); // 5 recorded + 2 voided = 7 events

    const all = await listEvents(w.apiKey, "?limit=100");
    expect(items(all).map((e) => e.id)).toEqual(w.eventIds);

    const walked: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 20; page += 1) {
      const answer: Answer = await listEvents(
        w.apiKey,
        `?limit=2${cursor === null ? "" : `&cursor=${encodeURIComponent(cursor)}`}`,
      );
      expect(answer.status).toBe(200);
      walked.push(...items(answer).map((e) => e.id));
      cursor = nextCursor(answer);
      if (cursor === null) break;
    }
    expect(cursor).toBeNull();
    // Same rows, same order, each exactly once.
    expect(walked).toEqual(w.eventIds);
    expect(new Set(walked).size).toBe(walked.length);
  });

  it("does not duplicate or skip when several events share a millisecond", async () => {
    /*
     * `occurredAt` is TIMESTAMP(3) and is set from `now()`, which is the TRANSACTION's start time —
     * so two transactions beginning in the same millisecond produce two events that compare exactly
     * equal. That is a real production case under two tills, not a contrived one.
     *
     * Forcing the collision needs the migrator and the trigger off, because the trigger's whole job
     * is to stop anybody choosing this column. What is under test is the pagination, not the
     * trigger: `integration-events-integrity.test.ts` owns that.
     */
    const w = await build("Café Tie", 6);
    /*
     * Two triggers stand in the way, and both are doing their job: `integration_event_append_only`
     * refuses any UPDATE at all, and `integration_event_validate` would refuse the new timestamp
     * because it no longer matches the redemption's. Both are off for one statement and straight
     * back on. `integration-events-integrity.test.ts` is what proves they work; this borrows the
     * table for a moment to build a state the column genuinely allows.
     */
    for (const trigger of ["integration_event_append_only", "integration_event_validate"]) {
      await migratorPrisma().$executeRawUnsafe(`ALTER TABLE "IntegrationEvent" DISABLE TRIGGER ${trigger}`);
    }
    try {
      await migratorPrisma().$executeRawUnsafe(
        `UPDATE "IntegrationEvent" SET "occurredAt" = TIMESTAMP '2026-09-15 10:00:00.000' WHERE "businessId" = $1::text`,
        w.cafe.businessId,
      );
    } finally {
      for (const trigger of ["integration_event_append_only", "integration_event_validate"]) {
        await migratorPrisma().$executeRawUnsafe(`ALTER TABLE "IntegrationEvent" ENABLE TRIGGER ${trigger}`);
      }
    }

    const expected = (
      await migratorPrisma().integrationEvent.findMany({
        where: { businessId: w.cafe.businessId },
        orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
        select: { id: true },
      })
    ).map((e) => e.id);

    const walked: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 20; page += 1) {
      const answer: Answer = await listEvents(
        w.apiKey,
        `?limit=2${cursor === null ? "" : `&cursor=${encodeURIComponent(cursor)}`}`,
      );
      walked.push(...items(answer).map((e) => e.id));
      cursor = nextCursor(answer);
      if (cursor === null) break;
    }
    // Six rows sharing one timestamp: the id tie-break is the only thing keeping this total.
    expect(walked).toEqual(expected);
    expect(new Set(walked).size).toBe(6);
  });

  it("does not repeat or lose a row when new events arrive mid-traversal", async () => {
    const w = await build("Café Live", 4);

    const first = await listEvents(w.apiKey, "?limit=2");
    const seen = items(first).map((e) => e.id);
    const cursor = nextCursor(first);
    expect(cursor).not.toBeNull();

    // Two more events, newer than everything — i.e. ahead of the window, where an OFFSET pager
    // would shift every later page and show a row twice.
    const customer = await enrolCustomer(w.cafe, { phone: uniqueSyrianPhone(), firstName: "سمر" });
    const fresh = await redeemCoupon(w.cafe.ctx, { code: CODE, customerCardId: customer.customerCardId });
    if (fresh.outcome !== "RECORDED") throw new Error("expected a redemption");

    const second = await listEvents(w.apiKey, `?limit=10&cursor=${encodeURIComponent(cursor!)}`);
    const rest = items(second).map((e) => e.id);

    expect(rest.filter((id) => seen.includes(id)), "no row may appear on two pages").toEqual([]);
    // The two older rows the first page had not reached are all still there.
    expect([...seen, ...rest].sort()).toEqual([...w.eventIds].sort());
    // And the row created after the traversal began is simply not in it, which is the correct
    // behaviour for a keyset walk: a consumer polls again from the top for new rows.
    expect([...seen, ...rest]).not.toContain(
      (await migratorPrisma().integrationEvent.findFirstOrThrow({
        where: { entityId: fresh.redemptionId },
        select: { id: true },
      })).id,
    );
  });

  it("clamps a silly limit and never errors on one", async () => {
    const w = await build("Café Limit", 3);
    for (const [query, expected] of [
      ["", 3],
      ["?limit=0", 3],
      ["?limit=-5", 3],
      ["?limit=abc", 3],
      ["?limit=1000000", 3],
      ["?limit=2", 2],
      ["?limit=2.9", 2],
    ] as const) {
      const a = await listEvents(w.apiKey, query);
      expect(a.status, query).toBe(200);
      expect(items(a).length, query).toBe(expected);
    }
    // The cap is the product's, whatever the caller asks for.
    const big = await listEvents(w.apiKey, `?limit=${MAX_PAGE_SIZE + 500}`);
    expect(items(big).length).toBeLessThanOrEqual(MAX_PAGE_SIZE);
  });

  it("refuses a cursor it did not issue, rather than quietly serving page one", async () => {
    /*
     * The consistency rule: clamp what has a sensible default, refuse what does not.
     *
     * A bad `limit` has one obviously-safe reading. A bad cursor has none — silently restarting the
     * traversal would send a client looping "fetch page, follow cursor" back to the beginning
     * forever, re-ingesting the whole feed without ever being told.
     */
    const w = await build("Café Cursor", 3);
    for (const bad of [
      "not-base64!",
      Buffer.from("not json").toString("base64url"),
      Buffer.from(JSON.stringify({ at: "nonsense", id: "x" })).toString("base64url"),
      Buffer.from(JSON.stringify({ at: new Date().toISOString() })).toString("base64url"),
      Buffer.from(JSON.stringify({ at: new Date().toISOString(), id: "x".repeat(65) })).toString("base64url"),
      "x".repeat(600),
    ]) {
      const a = await listEvents(w.apiKey, `?cursor=${encodeURIComponent(bad)}`);
      expect(a.status, bad.slice(0, 20)).toBe(400);
      expect(String((a.body.error as { code: string }).code)).toBe("BAD_REQUEST");
      expect(JSON.stringify(a.body), "the submitted cursor is not echoed").not.toContain(bad.slice(0, 20));
    }

    // An EMPTY cursor means "I have none" — it cannot have come from following `nextCursor`.
    const empty = await listEvents(w.apiKey, "?cursor=");
    expect(empty.status).toBe(200);
    expect(items(empty)).toHaveLength(3);
  });

  it("reports no total, and a last page with no cursor", async () => {
    const w = await build("Café Last", 2);
    const page = await listEvents(w.apiKey, "?limit=10");
    expect(page.body.page).toEqual({ nextCursor: null, count: 2 });
    // A total over a growing table is a second scan and is wrong by the time it is read.
    expect(JSON.stringify(page.body)).not.toContain("total");
  });

  it("issues a signed cursor that verifies to the last row of the page it came from", async () => {
    const w = await build("Café Shape", 3);
    const page = await listEvents(w.apiKey, "?limit=2");
    const issued = nextCursor(page);

    // Verified with the business the key belongs to — the same binding the route re-derives.
    const decoded = verifyCursor(issued, { businessId: w.cafe.businessId });
    expect(decoded).not.toBeNull();
    expect(decoded!.id).toBe(items(page)[1].id);
    expect(decoded!.at).toBe(items(page)[1].occurredAt);

    // And it is the signed shape, not the bare payload.
    expect(issued).toMatch(/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/);
  });
});

// ── the single read ──────────────────────────────────────────────────────────────────────────

describe("reading one event", () => {
  it("returns the same shape as a list row, with no page block", async () => {
    const w = await build("Café One", 2);
    const listed = items(await listEvents(w.apiKey))[0];
    const single = await readEvent(w.apiKey, listed.id);

    expect(single.status).toBe(200);
    expect(single.body.data).toEqual(listed);
    expect(single.body).not.toHaveProperty("page");
    expect(single.body.apiVersion).toBe("v1");
  });

  it("gives one 404 for an unknown id, a malformed id and another tenant's id", async () => {
    const a = await build("Café A", 1);
    const b = await build("Café B", 1);

    const answers = await Promise.all([
      readEvent(a.apiKey, randomUUID()),
      readEvent(a.apiKey, "not-a-uuid"),
      readEvent(a.apiKey, "x".repeat(500)),
      readEvent(a.apiKey, b.eventIds[0]),
    ]);
    for (const r of answers) expect(r.status).toBe(404);
    expect(new Set(answers.map((r) => JSON.stringify(r.body))).size).toBe(1);
  });

  it("refuses without a key, before looking anything up", async () => {
    const w = await build("Café Guard", 1);
    const r = await readEvent(null, w.eventIds[0]);
    expect(r.status).toBe(401);
    expect(JSON.stringify(r.body)).not.toContain(w.eventIds[0]);
  });
});

// ── headers ──────────────────────────────────────────────────────────────────────────────────

describe("every response, whatever its status", () => {
  it("is uncacheable and carries no CORS header", async () => {
    const w = await build("Café Head", 1);

    const answers: Answer[] = [
      await listEvents(w.apiKey), // 200
      await listEvents(null), // 401
      await listEvents(w.apiKey, "?cursor=rubbish"), // 400
      await readEvent(w.apiKey, randomUUID()), // 404
      await listEvents(w.apiKey, "?api_key=x"), // 400, the credential refusal
    ];

    for (const a of answers) {
      expect(a.headers.get("cache-control")).toBe("no-store");
      expect(a.headers.get("vary")).toBe("X-API-Key");
      // Server-to-server. A key in a browser is a key published.
      expect(a.headers.get("access-control-allow-origin")).toBeNull();
      expect(a.headers.get("access-control-allow-credentials")).toBeNull();
      expect(a.headers.get("access-control-allow-headers")).toBeNull();
    }
  });

  it("exports no handler for any verb but GET", async () => {
    const list = await import("@/app/api/v1/events/route");
    const single = await import("@/app/api/v1/events/[eventId]/route");
    for (const mod of [list, single]) {
      expect(Object.keys(mod).sort()).toEqual(["GET", "dynamic"]);
    }
  });
});

// ── rate limiting, last use, and what a read does not write ──────────────────────────────────

describe("what a request costs", () => {
  it("writes nothing at all for a key that was never issued", async () => {
    await build("Café Cost", 1);
    const before = await migratorPrisma().authRateLimit.count();
    for (let i = 0; i < 20; i += 1) expect((await listEvents(strangerKey())).status).toBe(401);
    // Twenty guesses, zero rows. The window is consumed only after the key is found.
    expect(await migratorPrisma().authRateLimit.count()).toBe(before);
  });

  it("opens one window per key and refuses with a retry hint at the cap", async () => {
    const w = await build("Café Burst", 1);
    expect((await listEvents(w.apiKey)).status).toBe(200);

    const row = await migratorPrisma().authRateLimit.findFirstOrThrow({ where: { scope: "api.key" } });
    // Drive the window to its cap directly rather than sending six hundred requests.
    await migratorPrisma().authRateLimit.update({
      where: { id: row.id },
      data: { attempts: API_RATE_LIMIT_MAX },
    });

    const refused = await listEvents(w.apiKey);
    expect(refused.status).toBe(429);
    expect(String((refused.body.error as { code: string }).code)).toBe("RATE_LIMITED");
    expect(Number(refused.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(refused.headers.get("cache-control")).toBe("no-store");

    // One window for the key, not one per request.
    expect(await migratorPrisma().authRateLimit.count({ where: { scope: "api.key" } })).toBe(1);
  });

  it("records that the key was used, and only moves it forward", async () => {
    const w = await build("Café Used", 1);
    const keyRow = () =>
      migratorPrisma().apiKey.findFirstOrThrow({
        where: { businessId: w.cafe.businessId, state: "ACTIVE" },
        select: { id: true, lastUsedAt: true },
      });

    expect((await keyRow()).lastUsedAt).toBeNull();
    await listEvents(w.apiKey);
    const first = (await keyRow()).lastUsedAt;
    expect(first).not.toBeNull();

    await listEvents(w.apiKey);
    const second = (await keyRow()).lastUsedAt;
    expect(second!.getTime()).toBeGreaterThanOrEqual(first!.getTime());
  });

  it("writes no audit row for a read", async () => {
    const w = await build("Café Quiet", 2);
    const before = await migratorPrisma().auditLog.count({ where: { businessId: w.cafe.businessId } });
    for (let i = 0; i < 10; i += 1) {
      await listEvents(w.apiKey);
      await readEvent(w.apiKey, w.eventIds[0]);
    }
    /*
     * Twenty reads, zero rows.
     *
     * One audit row per read would let a key holder turn their own rate limit into unbounded writes
     * to a table nobody prunes. `lastUsedAt` is the record of use, and it is one UPDATE of one row.
     */
    expect(await migratorPrisma().auditLog.count({ where: { businessId: w.cafe.businessId } })).toBe(before);
  });
});

// ── the revocation boundary, stated as it actually is ────────────────────────────────────────

describe("a key that stops being valid mid-flight", () => {
  it("refuses the next request, and does not pretend the in-flight one was serialized", async () => {
    /*
     * Authentication and the event query are TWO statements, not one transaction. So a key revoked
     * between them serves that one request, and this test says so rather than claiming otherwise.
     *
     * Closing the window would mean holding a row lock on the key for the duration of every read,
     * to narrow something a lock cannot eliminate either — a revocation committing one microsecond
     * later is still a revocation the in-flight request did not see.
     *
     * What matters is that the failure is SAFE, and that is what is asserted here: the in-flight
     * request can only ever return this tenant's own events, which the key was entitled to a moment
     * earlier, and the very next request is refused.
     */
    const w = await build("Café Race", 2);

    const before = await listEvents(w.apiKey);
    expect(before.status).toBe(200);

    const key = await migratorPrisma().apiKey.findFirstOrThrow({
      where: { businessId: w.cafe.businessId, state: "ACTIVE" },
      select: { id: true },
    });
    await revokeKey(w.cafe.ctx, key.id);

    const after = await listEvents(w.apiKey);
    expect(after.status).toBe(401);
    expect(after.headers.get("cache-control")).toBe("no-store");
  });

  it("refuses a key whose expiry has passed, whatever its bookkeeping state says", async () => {
    const w = await build("Café Lapse", 1);
    const key = await migratorPrisma().apiKey.findFirstOrThrow({
      where: { businessId: w.cafe.businessId, state: "ACTIVE" },
      select: { id: true, state: true },
    });
    await lapse(key.id);

    // Still ACTIVE on the row — the sweep is lazy — and refused anyway, because `expiresAt` is the
    // authority and a security decision does not wait on housekeeping.
    const still = await migratorPrisma().apiKey.findFirstOrThrow({ where: { id: key.id }, select: { state: true } });
    expect(still.state).toBe("ACTIVE");
    expect((await listEvents(w.apiKey)).status).toBe(401);
  });
});

/**
 * Move a key's dates into the past, leaving `state` alone.
 *
 * `api_key_guard` refuses a change to `issuedAt` or `expiresAt` from anybody, which is the point of
 * it, so ageing one is a migrator act with the trigger off. Both timestamps move together because
 * `ApiKey_expires_after_issue` is a table CHECK and stays on.
 */
async function lapse(id: string): Promise<void> {
  await migratorPrisma().$executeRawUnsafe('ALTER TABLE "ApiKey" DISABLE TRIGGER api_key_guard');
  try {
    await migratorPrisma().$executeRawUnsafe(
      `UPDATE "ApiKey" SET "issuedAt" = now() - interval '100 days', "expiresAt" = now() - interval '1 day'
        WHERE "id" = $1::text`,
      id,
    );
  } finally {
    await migratorPrisma().$executeRawUnsafe('ALTER TABLE "ApiKey" ENABLE TRIGGER api_key_guard');
  }
}
