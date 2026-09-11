import type { Job, PgBoss } from "pg-boss";

/**
 * Harmless smoke job proving the worker can connect, create a queue, receive work and complete it.
 * No business logic. Real scheduled jobs (birthday, expiry, reconciliation, push) arrive in
 * Phase 1.5 and Phase 2, each in its own module under src/worker/jobs/.
 */
export const SMOKE_QUEUE = "system.smoke";

export interface SmokePayload {
  echo: string;
}
export interface SmokeResult {
  pong: true;
  echo: string;
  processedAt: string;
}

export async function registerSmokeJob(boss: PgBoss): Promise<void> {
  await boss.createQueue(SMOKE_QUEUE);
  await boss.work<SmokePayload>(SMOKE_QUEUE, async (jobs: Job<SmokePayload>[]) => {
    // pg-boss ≥ 10 delivers batches; the result of the handler is stored per job.
    for (const job of jobs) {
      const result: SmokeResult = { pong: true, echo: job.data.echo, processedAt: new Date().toISOString() };
      await boss.complete(SMOKE_QUEUE, job.id, result);
    }
  });
}
