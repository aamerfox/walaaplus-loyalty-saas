import { randomUUID } from "node:crypto";
import {
  Prisma,
  WebhookAttemptOutcome,
  WebhookDeliveryStatus,
  WebhookDestinationState,
  WebhookErrorClass,
} from "@prisma/client";
import { prisma } from "../../db";
import { DecryptionFailedError, decryptSecret, EncryptionUnavailableError } from "./crypto";
import { canonicalBody, testEnvelope, WEBHOOK_ENVELOPE_VERSION } from "./envelope";
import { sendWebhook, type SendWebhookResult } from "./transport";
import type { AddressPolicy, LookupFn } from "./address";

/**
 * The worker's side of a webhook: **claim** what is due, try it, record what happened.
 *
 * ## Why this is a poller over an outbox, not a queue message
 *
 * A `WebhookDelivery` row is written in the **same transaction** as the `IntegrationEvent` it
 * carries. If the redemption rolls back, so does the event, and so does the obligation to tell
 * anybody. There is no second write to a queue that could succeed when the first failed.
 *
 * ## The lease, and why a read was not enough
 *
 * The first version of this read due rows with `findMany`, sent them, and only then wrote the
 * attempt. Two workers — or two overlapping passes of one worker, which a slow batch makes likely —
 * could read the same row before either wrote, and both would send. The receiver saw the webhook
 * twice and the attempt history disagreed with itself.
 *
 * So a delivery is now **claimed**, atomically:
 *
 *   UPDATE … SET claimedAt, leaseExpiresAt, claimToken
 *    WHERE id IN (SELECT id … FOR UPDATE SKIP LOCKED LIMIT n)
 *   RETURNING id
 *
 * One statement. `SKIP LOCKED` means a second pass steps over rows the first is taking rather than
 * blocking on them, and the `leaseExpiresAt` predicate means a **crashed** worker does not strand
 * its claims — once the lease passes, the row is due again.
 *
 * Every write afterwards carries `AND "claimToken" = $token`, so a worker whose lease expired while
 * it was slow cannot overwrite the state of whoever took the row next.
 *
 * ## At-least-once, unchanged and unavoidable
 *
 * A process that dies **after** the request reached the receiver but **before** the outcome was
 * written will retry when the lease expires. Nothing in a lease can prevent that — the socket and
 * the database cannot commit together — so the receiver must de-duplicate by event id, which is
 * what `X-Walaaplus-Event-Id` is for and what the screen says in both languages.
 *
 * ## Called only by the worker
 *
 * `src/worker/jobs/webhook-delivery.ts` is the only caller, and a source scan asserts nothing under
 * `src/app/` imports this module.
 */

/**
 * How many deliveries one pass claims.
 *
 * Ten rather than twenty-five, because the lease has to cover the worst case: ten requests at the
 * transport's five-second timeout is under a minute, comfortably inside the lease below.
 */
export const BATCH_SIZE = 10;

/** After this many attempts a delivery rests at FAILED. The database carries the same ceiling. */
export const MAX_ATTEMPTS = 5;

/**
 * How long a claim is good for.
 *
 * Long enough that a healthy pass never loses its lease mid-batch, short enough that a crashed
 * worker's rows are picked up again within a few minutes rather than at the next restart.
 */
export const LEASE_SECONDS = 300;

/**
 * Backoff, in seconds: 1 min, 5 min, 25 min, ~2 h.
 *
 * Deterministic rather than jittered because there is one sender and a handful of destinations;
 * jitter solves a thundering-herd problem this product does not have.
 */
export function backoffSeconds(attemptNumber: number): number {
  return 60 * 5 ** (attemptNumber - 1);
}

export interface DeliveryRunOptions {
  now?: Date;
  limit?: number;
  /** Injectable for tests; **production passes none of these** — see `AddressPolicy` in `address.ts`. */
  lookup?: LookupFn;
  addressPolicy?: AddressPolicy;
  ca?: string | Buffer;
  send?: typeof sendWebhook;
}

export interface DeliveryRunSummary {
  claimed: number;
  delivered: number;
  retrying: number;
  refused: number;
  failed: number;
}

/** A claimed delivery, with everything it needs and nothing it does not. */
interface ClaimedDelivery {
  id: string;
  businessId: string;
  attemptCount: number;
  isTest: boolean;
  createdAt: Date;
  destinationState: WebhookDestinationState;
  endpointCipher: string;
  signingSecretCipher: string;
  eventId: string | null;
  eventEnvelopeVersion: number | null;
  eventType: string | null;
  entityType: string | null;
  entityId: string | null;
  occurredAt: Date | null;
}

/**
 * Take up to `limit` due deliveries, atomically.
 *
 * The `SELECT` inside picks candidates; `FOR UPDATE SKIP LOCKED` stops two passes contending for
 * the same ones; the outer `UPDATE … RETURNING` stamps the lease. Because it is one statement,
 * there is no window in which a row is "chosen" but not yet claimed.
 *
 * A row is a candidate when it is PENDING, due, and **not currently leased** — the third clause is
 * what turns a crashed worker's abandoned claim back into work.
 */
async function claimDue(now: Date, limit: number, token: string): Promise<string[]> {
  const expires = new Date(now.getTime() + LEASE_SECONDS * 1000);
  const rows = await prisma.$queryRaw<{ id: string }[]>(Prisma.sql`
    UPDATE "WebhookDelivery" AS d
       SET "claimedAt" = ${now},
           "leaseExpiresAt" = ${expires},
           "claimToken" = ${token}
     WHERE d."id" IN (
       SELECT c."id"
         FROM "WebhookDelivery" c
        WHERE c."status" = 'PENDING'
          AND c."nextAttemptAt" <= ${now}
          AND (c."leaseExpiresAt" IS NULL OR c."leaseExpiresAt" <= ${now})
        ORDER BY c."nextAttemptAt" ASC
        FOR UPDATE SKIP LOCKED
        LIMIT ${limit}
     )
    RETURNING d."id"
  `);
  return rows.map((r) => r.id);
}

/** Read what a claimed delivery needs. The destination state here is the **cutover boundary**. */
async function loadClaimed(ids: string[], token: string): Promise<ClaimedDelivery[]> {
  if (ids.length === 0) return [];
  const rows = await prisma.webhookDelivery.findMany({
    // The token, so a row re-claimed by somebody else between the two statements is not processed.
    where: { id: { in: ids }, claimToken: token },
    select: {
      id: true,
      businessId: true,
      attemptCount: true,
      isTest: true,
      createdAt: true,
      destination: { select: { state: true, endpointCipher: true, signingSecretCipher: true } },
      integrationEvent: {
        select: { id: true, envelopeVersion: true, eventType: true, entityType: true, entityId: true, occurredAt: true },
      },
    },
  });

  return rows.map((row) => ({
    id: row.id,
    businessId: row.businessId,
    attemptCount: row.attemptCount,
    isTest: row.isTest,
    createdAt: row.createdAt,
    destinationState: row.destination.state,
    endpointCipher: row.destination.endpointCipher,
    signingSecretCipher: row.destination.signingSecretCipher,
    eventId: row.integrationEvent?.id ?? null,
    eventEnvelopeVersion: row.integrationEvent?.envelopeVersion ?? null,
    eventType: row.integrationEvent?.eventType ?? null,
    entityType: row.integrationEvent?.entityType ?? null,
    entityId: row.integrationEvent?.entityId ?? null,
    occurredAt: row.integrationEvent?.occurredAt ?? null,
  }));
}

/**
 * Write the attempt, move the delivery, and release the lease — in one transaction.
 *
 * The two rows have to agree: an attempt numbered *n* only makes sense against a delivery that has
 * made *n* attempts, and `walaaplus_validate_webhook_attempt` refuses the pair otherwise. So the
 * counter moves first and the attempt is written against the moved value.
 *
 * The update is conditional on the claim token. A worker that was slow enough to lose its lease
 * finds zero rows affected and writes no attempt, rather than trampling the state of whoever took
 * the row next.
 */
async function recordAttempt(delivery: ClaimedDelivery, result: SendWebhookResult, now: Date, token: string): Promise<boolean> {
  const attemptNumber = delivery.attemptCount + 1;

  const settled =
    result.outcome === WebhookAttemptOutcome.DELIVERED
      ? WebhookDeliveryStatus.DELIVERED
      : result.outcome === WebhookAttemptOutcome.PERMANENT
        ? WebhookDeliveryStatus.REFUSED
        : attemptNumber >= MAX_ATTEMPTS
          ? WebhookDeliveryStatus.FAILED
          : null;

  return prisma.$transaction(async (tx) => {
    const moved = await tx.webhookDelivery.updateMany({
      where: { id: delivery.id, claimToken: token },
      data: {
        attemptCount: attemptNumber,
        lastAttemptAt: now,
        lastOutcome: result.outcome,
        lastErrorClass: result.errorClass,
        lastHttpStatus: result.httpStatus,
        // The lease is released either way: settled rows hold none, and a retry has to be claimable.
        claimedAt: null,
        leaseExpiresAt: null,
        claimToken: null,
        ...(settled
          ? { status: settled, settledAt: now, nextAttemptAt: null }
          : { nextAttemptAt: new Date(now.getTime() + backoffSeconds(attemptNumber) * 1000) }),
      },
    });
    if (moved.count === 0) return false;

    await tx.webhookDeliveryAttempt.create({
      data: {
        businessId: delivery.businessId,
        deliveryId: delivery.id,
        attemptNumber,
        outcome: result.outcome,
        errorClass: result.errorClass,
        httpStatus: result.httpStatus,
      },
      select: { id: true },
    });
    return true;
  });
}

/**
 * One pass over what is due.
 *
 * Returns counts and nothing identifying: no id, host, URL, status line or error text, so there is
 * nothing here a log could leak even if somebody added one.
 */
export async function runDueDeliveries(options: DeliveryRunOptions = {}): Promise<DeliveryRunSummary> {
  const now = options.now ?? new Date();
  const send = options.send ?? sendWebhook;
  const token = randomUUID();
  const summary: DeliveryRunSummary = { claimed: 0, delivered: 0, retrying: 0, refused: 0, failed: 0 };

  const ids = await claimDue(now, options.limit ?? BATCH_SIZE, token);
  const claimed = await loadClaimed(ids, token);
  summary.claimed = claimed.length;

  for (const delivery of claimed) {
    const result = await attemptOne(delivery, send, options, now);
    const written = await recordAttempt(delivery, result, now, token);
    if (!written) continue;

    if (result.outcome === WebhookAttemptOutcome.DELIVERED) summary.delivered += 1;
    else if (result.outcome === WebhookAttemptOutcome.PERMANENT) summary.refused += 1;
    else if (delivery.attemptCount + 1 >= MAX_ATTEMPTS) summary.failed += 1;
    else summary.retrying += 1;
  }

  return summary;
}

/** A refusal shaped like a send result, so every path returns the same thing. */
function refuse(errorClass: WebhookErrorClass): SendWebhookResult {
  return { outcome: WebhookAttemptOutcome.PERMANENT, errorClass, httpStatus: null };
}

/**
 * Decrypt, build the body, send. Every failure becomes a classification rather than an exception.
 *
 * ## The cutover, and the boundary it cannot cross
 *
 * The destination's state is re-read under the claim, immediately before dispatch — so a
 * destination disabled or revoked while a delivery sat in the queue sends nothing.
 *
 * What that cannot do is unsend a request already on the wire. If the owner's disable commits after
 * this function has handed the body to the socket, the receiver gets it. The window is milliseconds
 * and it is unavoidable: a TCP connection and a database transaction do not commit together. It is
 * written down in `docs/INTEGRATIONS-CAPABILITY-MATRIX.md` §7a rather than promised away.
 */
async function attemptOne(
  delivery: ClaimedDelivery,
  send: typeof sendWebhook,
  options: DeliveryRunOptions,
  now: Date,
): Promise<SendWebhookResult> {
  /*
   * Who may receive what, in one place, agreeing with the trigger and with the screen:
   *
   *   REVOKED   nothing, ever. Not a real event, not a test.
   *   DISABLED  a synthetic TEST the owner asked for, and nothing else. That is the whole point of
   *             a test: checking an address BEFORE turning it on. It carries no customer data.
   *   ENABLED   everything.
   *
   * The previous version refused every non-ENABLED dispatch, which silently broke the test button
   * the screen offers on a disabled destination.
   */
  if (delivery.destinationState === WebhookDestinationState.REVOKED) {
    return refuse(WebhookErrorClass.DESTINATION_NOT_ELIGIBLE);
  }
  if (delivery.destinationState !== WebhookDestinationState.ENABLED && !delivery.isTest) {
    return refuse(WebhookErrorClass.DESTINATION_NOT_ELIGIBLE);
  }

  let url: string;
  let secret: string;
  try {
    url = decryptSecret(delivery.endpointCipher);
    secret = decryptSecret(delivery.signingSecretCipher);
  } catch (err) {
    /*
     * Two failures that look alike and are not.
     *
     * The KEY being absent or malformed is a deployment condition an operator corrects in minutes.
     * Refusing every queued delivery permanently because a variable was briefly unset would turn a
     * short outage into lost webhooks, so it is **retryable** and bounded by the normal cap.
     *
     * A ciphertext that will not decrypt under a key that IS present is tampered, or was written
     * under a key that no longer exists. No amount of waiting fixes that, and retrying would hide a
     * corrupted destination behind five quiet failures. **Permanent.**
     *
     * Neither sends anything.
     */
    if (err instanceof EncryptionUnavailableError) {
      return {
        outcome: WebhookAttemptOutcome.RETRYABLE,
        errorClass: WebhookErrorClass.ENCRYPTION_UNAVAILABLE,
        httpStatus: null,
      };
    }
    if (err instanceof DecryptionFailedError) return refuse(WebhookErrorClass.CIPHERTEXT_INVALID);
    throw err;
  }

  const envelope = delivery.isTest
    ? testEnvelope(delivery.id, delivery.businessId, delivery.createdAt)
    : {
        eventId: delivery.eventId ?? "",
        envelopeVersion: delivery.eventEnvelopeVersion ?? WEBHOOK_ENVELOPE_VERSION,
        eventType: delivery.eventType as never,
        entityType: delivery.entityType as never,
        entityId: delivery.entityId ?? "",
        occurredAt: delivery.occurredAt ?? now,
        businessId: delivery.businessId,
      };

  return send({
    url,
    signingSecret: secret,
    body: canonicalBody(envelope),
    eventId: envelope.eventId,
    deliveryId: delivery.id,
    attemptNumber: delivery.attemptCount + 1,
    lookup: options.lookup,
    addressPolicy: options.addressPolicy,
    ca: options.ca,
  });
}
