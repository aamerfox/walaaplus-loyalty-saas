import { IntegrationEntityType, IntegrationEventType } from "@prisma/client";
import { prisma } from "../db";
import type { ApiContext } from "./auth";
import { type ApiPage, type Cursor, cursorPage } from "./contract";
import { signCursor } from "./cursor";

/**
 * The only thing `/api/v1` can read.
 *
 * ## Why an event and nothing else
 *
 * `IntegrationEvent` is the one table in this product whose columns were chosen so that a consumer
 * outside the business could be shown all of them. It has no JSON bag, no relation to a person, and
 * no column that could hold a phone number, a code, a capability or an amount — `events.ts` in
 * `src/server/integrations/` explains why it was built that way, a phase before anything could read
 * it. This file is the first caller to benefit from that decision.
 *
 * What an event says is: *a promotion redemption was recorded (or voided) at this moment, and here
 * is its internal id.* It does **not** carry the customer, the card, the promotion, the coupon code,
 * the benefit or any amount. A consumer needing those asks the merchant through an authorised read
 * that does not exist — which keeps the authorisation decision in one place rather than copying a
 * customer's data into a feed nobody re-checks.
 *
 * ## The tenant is never a parameter
 *
 * Every function here takes an `ApiContext` and puts `ctx.businessId` in the `WHERE`. There is no
 * overload that accepts a business, so a future handler cannot pass one in from a request.
 */

/** One event on the wire. Six fields, each decided in `docs/API-KEY-CAPABILITY-MATRIX.md` §11. */
export interface ApiEventView {
  id: string;
  /** `eventType` on the row; `type` on the wire, because `eventType` on an event reads as a stutter. */
  type: IntegrationEventType;
  entityType: IntegrationEntityType;
  /** An internal id belonging to this business. The correlation key between a record and its void. */
  entityId: string;
  /** ISO-8601 UTC. Database-assigned, and the authority the ordering is built on. */
  occurredAt: string;
  envelopeVersion: number;
}

/**
 * Listed literally, and deliberately short of the table.
 *
 * `businessId` is omitted because the key already determines it — a per-row copy is redundant, and
 * a field that looks like a tenant selector is one a client eventually tries to set. `createdAt` is
 * omitted because it duplicates `occurredAt` with no distinct meaning out here, and publishing two
 * near-identical times is an invitation to order by the wrong one. No relation is traversed.
 */
const EVENT_SELECT = {
  id: true,
  eventType: true,
  entityType: true,
  entityId: true,
  occurredAt: true,
  envelopeVersion: true,
} as const;

type EventRow = {
  id: string;
  eventType: IntegrationEventType;
  entityType: IntegrationEntityType;
  entityId: string;
  occurredAt: Date;
  envelopeVersion: number;
};

function toView(row: EventRow): ApiEventView {
  return {
    id: row.id,
    type: row.eventType,
    entityType: row.entityType,
    entityId: row.entityId,
    occurredAt: row.occurredAt.toISOString(),
    envelopeVersion: row.envelopeVersion,
  };
}

/**
 * The shape of an id this product generates. Bounds the work an unauthenticated-shaped path can
 * cause, the same way `KEY_SHAPE` does in `auth.ts`: a 10 KB path segment is refused without a
 * query. It is not a security boundary — the `businessId` filter is — but a lookup on garbage is
 * work somebody else chose for us.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ListApiEventsOptions {
  /** Already clamped by `pageSize`. This function does not re-interpret a caller's number. */
  size: number;
  /** Already decoded and validated by `decodeCursor`. Null means the first page. */
  cursor: Cursor | null;
}

/**
 * One page of this key's business's events, newest first.
 *
 * ## The order is total, and it has to be
 *
 * `ORDER BY "occurredAt" DESC, "id" DESC`.
 *
 * `occurredAt` alone is **not** a total order. The column is `TIMESTAMP(3)` and the trigger sets it
 * from `now()`, which is the transaction's start time — so two transactions beginning in the same
 * millisecond produce two events that compare exactly equal. A sort with ties is a sort the database
 * may return differently on each execution, and that is precisely how a paginating client sees one
 * row twice and another never. `id` breaks every tie.
 *
 * ## The cursor is authenticated
 *
 * `options.cursor` has already been through `verifyCursor`, so by the time it arrives here it is a
 * value this server minted for THIS business. That is why the comparison below can use it directly:
 * it is not caller input any more.
 *
 * ## Keyset, not offset
 *
 * `OFFSET 10000` makes PostgreSQL walk ten thousand rows in order to discard them, so a small
 * request buys arbitrary server work. It is also wrong under insertion: a row arriving ahead of the
 * window shifts every later page. The cursor instead asks for rows strictly earlier than the last
 * one seen, under the same two-column order — an indexed seek at any depth, stable under insertion.
 *
 * The comparison is the two-column form, not `occurredAt < at`, which would skip every other row
 * sharing that millisecond, and not `occurredAt <= at`, which would repeat them.
 */
export async function listApiEvents(
  ctx: ApiContext,
  options: ListApiEventsOptions,
): Promise<{ items: ApiEventView[]; page: ApiPage }> {
  const cursor = options.cursor;
  const at = cursor ? new Date(cursor.at) : null;

  const rows = await prisma.integrationEvent.findMany({
    where: {
      // From the key. Top-level keys are AND-ed, so this holds whatever the cursor says.
      businessId: ctx.businessId,
      ...(at && cursor
        ? { OR: [{ occurredAt: { lt: at } }, { occurredAt: at, id: { lt: cursor.id } }] }
        : {}),
    },
    orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
    // One more than asked for, so the next cursor is decided without a second query and without a
    // COUNT. `cursorPage` trims it.
    take: options.size + 1,
    select: EVENT_SELECT,
  });

  const { items, page } = cursorPage(
    rows,
    options.size,
    (row) => ({ at: row.occurredAt.toISOString(), id: row.id }),
    /*
     * Signed with the business from the KEY, which is the same value that filtered the query above.
     * A cursor and the rows it points at therefore always agree about whose feed this is, and the
     * next request's verification re-derives the binding from its own key rather than from anything
     * the client sent.
     */
    (cursor) => signCursor(cursor, { businessId: ctx.businessId }),
  );
  return { items: items.map(toView), page };
}

/**
 * One event, or nothing.
 *
 * `businessId` is in the `WHERE` beside the id, so another tenant's event **does not exist** for
 * this caller. The route turns null into a `404`, and it is the same `404` a never-existent id
 * gets — a different answer for "not yours" would confirm that somebody else's event is real.
 */
export async function getApiEvent(ctx: ApiContext, eventId: string): Promise<ApiEventView | null> {
  if (!UUID.test(eventId)) return null;
  const row = await prisma.integrationEvent.findFirst({
    where: { id: eventId, businessId: ctx.businessId },
    select: EVENT_SELECT,
  });
  return row ? toView(row) : null;
}
