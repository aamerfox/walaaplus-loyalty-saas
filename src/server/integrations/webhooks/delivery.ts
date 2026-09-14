import {
  WebhookAttemptOutcome,
  WebhookDeliveryStatus,
  WebhookErrorClass,
  WebhookDestinationState,
} from "@prisma/client";
import { prisma } from "../../db";
import { DecryptionFailedError, decryptSecret, EncryptionUnavailableError } from "./crypto";
import { canonicalBody, testEnvelope, WEBHOOK_ENVELOPE_VERSION } from "./envelope";
import { sendWebhook, type SendWebhookResult } from "./transport";
import type { AddressPolicy, LookupFn } from "./address";

/**
 * The worker's side of a webhook: take what is due, try it, record what happened.
 *
 * ## Why this is a poller over an outbox, not a queue message
 *
 * A `WebhookDelivery` row is written in the **same transaction** as the `IntegrationEvent` it
 * carries. That is the whole transactionality story: if the redemption rolls back, so does the
 * event, and so does the obligation to tell anybody about it. There is no second write to a queue
 * that could succeed when the first failed, or fail when the first succeeded.
 *
 * The cost is that the worker has to look for work rather than being handed it. That cost is a
 * `WHERE status = 'PENDING' AND nextAttemptAt <= now()` against a partial index, once a minute.
 *
 * ## Called only by the worker
 *
 * `src/worker/jobs/webhook-delivery.ts` is the only caller. Nothing under `src/app/` imports this
 * module, and a source scan asserts it — because an HTTP request made from a request handler is a
 * request a customer's till is waiting on.
 */

/** How many deliveries one pass takes. Bounded so a backlog cannot monopolise the worker. */
export const BATCH_SIZE = 25;

/** After this many attempts a delivery rests at FAILED and the owner can see it. */
export const MAX_ATTEMPTS = 5;

/**
 * Backoff, in seconds: 1 min, 5 min, 25 min, ~2 h.
 *
 * Deterministic rather than jittered because there is one sender and a handful of destinations;
 * jitter solves a thundering-herd problem this product does not have, and it would make the tests
 * assert a range instead of a value.
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
  attempted: number;
  delivered: number;
  retrying: number;
  refused: number;
  failed: number;
}

/** A delivery the worker may pick up, with everything it needs and nothing it does not. */
interface DueDelivery {
  id: string;
  businessId: string;
  attemptCount: number;
  isTest: boolean;
  createdAt: Date;
  destinationId: string;
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

async function claimDue(now: Date, limit: number): Promise<DueDelivery[]> {
  const rows = await prisma.webhookDelivery.findMany({
    where: {
      status: WebhookDeliveryStatus.PENDING,
      nextAttemptAt: { lte: now },
      // A destination revoked or disabled after the delivery was created stops receiving. The
      // delivery is settled below rather than left pending forever.
    },
    orderBy: { nextAttemptAt: "asc" },
    take: limit,
    select: {
      id: true,
      businessId: true,
      attemptCount: true,
      isTest: true,
      createdAt: true,
      destination: {
        select: { id: true, state: true, endpointCipher: true, signingSecretCipher: true },
      },
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
    destinationId: row.destination.id,
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
 * Write the attempt and move the delivery, in one transaction.
 *
 * The two have to agree: an attempt row numbered *n* only makes sense against a delivery that has
 * made *n* attempts, and `walaaplus_validate_webhook_attempt` refuses the pair if they do not. So
 * the counter moves first and the attempt is written against the moved value.
 */
async function recordAttempt(delivery: DueDelivery, result: SendWebhookResult, now: Date): Promise<void> {
  const attemptNumber = delivery.attemptCount + 1;

  const settled =
    result.outcome === WebhookAttemptOutcome.DELIVERED
      ? WebhookDeliveryStatus.DELIVERED
      : result.outcome === WebhookAttemptOutcome.PERMANENT
        ? WebhookDeliveryStatus.REFUSED
        : attemptNumber >= MAX_ATTEMPTS
          ? WebhookDeliveryStatus.FAILED
          : null;

  await prisma.$transaction(async (tx) => {
    await tx.webhookDelivery.update({
      where: { id: delivery.id },
      data: {
        attemptCount: attemptNumber,
        lastAttemptAt: now,
        lastOutcome: result.outcome,
        lastErrorClass: result.errorClass,
        lastHttpStatus: result.httpStatus,
        ...(settled
          ? { status: settled, settledAt: now, nextAttemptAt: null }
          : { nextAttemptAt: new Date(now.getTime() + backoffSeconds(attemptNumber) * 1000) }),
      },
    });

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
  });
}

/**
 * One pass over what is due.
 *
 * Returns a count summary and nothing identifying. The worker logs the summary; there is no path by
 * which a URL, a body, a status line or an error message reaches a log from here.
 */
export async function runDueDeliveries(options: DeliveryRunOptions = {}): Promise<DeliveryRunSummary> {
  const now = options.now ?? new Date();
  const send = options.send ?? sendWebhook;
  const summary: DeliveryRunSummary = { attempted: 0, delivered: 0, retrying: 0, refused: 0, failed: 0 };

  for (const delivery of await claimDue(now, options.limit ?? BATCH_SIZE)) {
    summary.attempted += 1;

    const result = await attemptOne(delivery, send, options, now);
    await recordAttempt(delivery, result, now);

    if (result.outcome === WebhookAttemptOutcome.DELIVERED) summary.delivered += 1;
    else if (result.outcome === WebhookAttemptOutcome.PERMANENT) summary.refused += 1;
    else if (delivery.attemptCount + 1 >= MAX_ATTEMPTS) summary.failed += 1;
    else summary.retrying += 1;
  }

  return summary;
}

/** Decrypt, build the body, send. Every failure becomes a classification rather than an exception. */
async function attemptOne(
  delivery: DueDelivery,
  send: typeof sendWebhook,
  options: DeliveryRunOptions,
  now: Date,
): Promise<SendWebhookResult> {
  // A destination switched off after the delivery was queued receives nothing. Permanent, because
  // the owner's decision is not a transient condition.
  if (delivery.destinationState !== WebhookDestinationState.ENABLED) {
    return {
      outcome: WebhookAttemptOutcome.PERMANENT,
      errorClass: WebhookErrorClass.UNSAFE_ADDRESS,
      httpStatus: null,
    };
  }

  let url: string;
  let secret: string;
  try {
    url = decryptSecret(delivery.endpointCipher);
    secret = decryptSecret(delivery.signingSecretCipher);
  } catch (err) {
    /*
     * Fail closed. A missing key is a deployment problem a retry cannot fix, and a failed
     * decryption is a row that is not what it says it is — neither is something to guess around.
     */
    if (err instanceof EncryptionUnavailableError || err instanceof DecryptionFailedError) {
      return {
        outcome: WebhookAttemptOutcome.PERMANENT,
        errorClass: WebhookErrorClass.ENCRYPTION_UNAVAILABLE,
        httpStatus: null,
      };
    }
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
