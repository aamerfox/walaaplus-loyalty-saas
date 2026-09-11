import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PgBoss } from "pg-boss";
import { createBoss } from "@/worker/boss";
import { startHealthServer, type HealthServer } from "@/worker/health";
import { registerSmokeJob, SMOKE_QUEUE, type SmokeResult } from "@/worker/jobs/smoke";

/**
 * Proves the worker foundation against the REAL test database: pg-boss connects, creates its
 * schema, accepts a job, a worker processes it, and the health endpoint reflects lifecycle.
 */
describe("worker foundation", () => {
  let boss: PgBoss;
  let health: HealthServer;
  let started = false;

  beforeAll(async () => {
    boss = createBoss(process.env.DATABASE_URL!);
    health = await startHealthServer(boss, 0, () => started);
  });

  afterAll(async () => {
    await boss.stop({ graceful: false, close: true, timeout: 5_000 });
    await health.close();
  });

  it("reports 503 before the boss has started", async () => {
    const res = await fetch(`http://127.0.0.1:${health.port}/health`);
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ status: "starting" });
  });

  it("starts, registers the smoke queue, processes a job and stores its result", async () => {
    await boss.start();
    await registerSmokeJob(boss);
    started = true;

    const jobId = await boss.send(SMOKE_QUEUE, { echo: "salam" });
    expect(jobId).toBeTruthy();

    const deadline = Date.now() + 15_000;
    let job = await boss.getJobById<SmokeResult>(SMOKE_QUEUE, jobId!);
    while (job && job.state !== "completed" && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 250));
      job = await boss.getJobById<SmokeResult>(SMOKE_QUEUE, jobId!);
    }
    expect(job?.state).toBe("completed");
    expect(job?.output).toMatchObject({ pong: true, echo: "salam" });
  });

  it("reports 200 once started and 404 for unknown paths", async () => {
    const ok = await fetch(`http://127.0.0.1:${health.port}/health`);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ status: "ok", service: "walaaplus-worker" });

    const ready = await fetch(`http://127.0.0.1:${health.port}/ready`);
    expect(ready.status).toBe(200);

    const nope = await fetch(`http://127.0.0.1:${health.port}/nope`);
    expect(nope.status).toBe(404);
  });
});
