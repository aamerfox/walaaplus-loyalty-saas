import type { Job, PgBoss } from "pg-boss";
import { runDueDeliveries } from "../../server/integrations/webhooks/delivery";

/**
 * The only thing in this product that sends an outbound request, and it lives in the worker.
 *
 * A webhook is a request to somebody else's server. Making one from a route handler would mean a
 * cashier's till waiting on a receiver's timeout — so the request handler writes an outbox row and
 * stops, and this picks it up.
 *
 * ## Why a schedule rather than a message
 *
 * The outbox row is written in the same transaction as the `IntegrationEvent` it carries. Sending a
 * pg-boss message instead would be a second write that could succeed when the first rolled back, or
 * fail when it committed, and reconciling those two is a distributed-transaction problem nobody
 * needs to have. A scan every minute over a partial index is the cheaper correct answer.
 *
 * The cost is latency: a webhook arrives within about a minute rather than instantly. That is
 * written on the owner's screen rather than left to be discovered.
 */
export const WEBHOOK_DELIVERY_QUEUE = "integrations.webhook.deliver";

/** Every minute. pg-boss's finest cron granularity, and finer than this feature needs. */
export const WEBHOOK_DELIVERY_CRON = "* * * * *";

export interface WebhookDeliveryResult {
  /** How many due rows this pass CLAIMED. Renamed with the lease: a claim is what is countable. */
  claimed: number;
  delivered: number;
  retrying: number;
  refused: number;
  failed: number;
}

export async function registerWebhookDeliveryJob(boss: PgBoss): Promise<void> {
  await boss.createQueue(WEBHOOK_DELIVERY_QUEUE);

  await boss.work(WEBHOOK_DELIVERY_QUEUE, async (jobs: Job<unknown>[]) => {
    for (const job of jobs) {
      /*
       * Counts, and nothing else.
       *
       * `runDueDeliveries` returns a summary with no id, no host, no URL, no status line and no
       * error text in it, so there is nothing here that a log could leak even if somebody added
       * one. It is also why the result stored against the job is safe: pg-boss keeps it in a table.
       */
      const summary = await runDueDeliveries();
      const result: WebhookDeliveryResult = summary;
      await boss.complete(WEBHOOK_DELIVERY_QUEUE, job.id, result);
    }
  });

  // One scheduled tick. `singletonKey` is pg-boss's own guard against two ticks overlapping if a
  // pass runs long.
  await boss.schedule(WEBHOOK_DELIVERY_QUEUE, WEBHOOK_DELIVERY_CRON, {}, { singletonKey: WEBHOOK_DELIVERY_QUEUE });
}
