/**
 * WalaaPlus background worker — a SEPARATE process from the Next.js server.
 *
 *   npm run worker        production-style start (tsx)
 *   npm run worker:dev    restart on change
 *
 * Startup order: validate environment → connect pg-boss → register jobs → expose /health.
 * Shutdown: SIGINT/SIGTERM stop accepting work, let in-flight jobs finish, close cleanly.
 *
 * Jobs: src/worker/jobs/smoke.ts proves the pipe works; src/worker/jobs/webhook-delivery.ts is the
 * one place this product sends an outbound request.
 */
import { env, EnvValidationError } from "../server/env";
import { createBoss } from "./boss";
import { startHealthServer, type HealthServer } from "./health";
import { registerSmokeJob } from "./jobs/smoke";
import { registerWebhookDeliveryJob, WEBHOOK_DELIVERY_QUEUE } from "./jobs/webhook-delivery";

function log(msg: string, extra: Record<string, unknown> = {}): void {
  // Never log connection strings, secrets or job payloads.
  process.stdout.write(JSON.stringify({ ts: new Date().toISOString(), service: "worker", msg, ...extra }) + "\n");
}

async function main(): Promise<void> {
  let e;
  try {
    e = env();
  } catch (err) {
    if (err instanceof EnvValidationError) {
      process.stderr.write(`worker: ${err.message}\n`);
      process.exit(2);
    }
    throw err;
  }

  const boss = createBoss(e.DATABASE_URL);
  let started = false;

  boss.on("error", (err: Error) => log("pg-boss error", { error: err.message }));

  // Health first: orchestrators can probe /health (503) while pg-boss connects.
  const health: HealthServer = await startHealthServer(boss, e.WORKER_HEALTH_PORT, () => started);
  log("health endpoint listening", { port: health.port });

  const shutdown = async (signal: string) => {
    log("shutting down", { signal });
    try {
      await boss.stop({ graceful: true, timeout: 10_000 });
      await health.close();
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  await boss.start();
  await registerSmokeJob(boss);
  /*
   * The only outbound HTTP in the product, and it is here rather than in a request handler: a
   * webhook is a request to somebody else's server, and a till must never wait on one.
   */
  await registerWebhookDeliveryJob(boss);
  started = true;
  log("worker started", { queues: ["system.smoke", WEBHOOK_DELIVERY_QUEUE] });
}

main().catch((err: unknown) => {
  log("worker failed to start", { error: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
