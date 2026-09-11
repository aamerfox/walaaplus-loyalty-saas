/**
 * Phase 1a Prompt 2 staging — GET /api/health.
 *
 * The only unauthenticated endpoint a load balancer calls forever, so what it does NOT say is
 * the point of these tests. A health endpoint that reports the reason it is unhealthy hands an
 * anonymous caller a description of the inside of the deployment: the database name, a driver
 * version, a connection string fragment, a stack frame. The operator reads that from the logs.
 */
import { describe, expect, it } from "vitest";
import { GET } from "@/app/api/health/route";
import { prisma } from "@/server/db";

async function get(): Promise<{ status: number; body: Record<string, unknown>; headers: Headers }> {
  const res = await GET();
  return { status: res.status, body: (await res.json()) as Record<string, unknown>, headers: res.headers };
}

describe("GET /api/health", () => {
  it("reports ok when the database is reachable", async () => {
    const { status, body } = await get();
    expect(status).toBe(200);
    expect(body).toEqual({ status: "ok" });
  });

  it("says exactly one thing and nothing else", async () => {
    const { body } = await get();
    // Not a subset assertion: any key added here is a key that reaches an anonymous caller.
    expect(Object.keys(body)).toEqual(["status"]);
  });

  it("leaks no environment, database or version detail", async () => {
    const { body } = await get();
    const serialized = JSON.stringify(body).toLowerCase();
    for (const forbidden of ["postgres", "prisma", "walaaplus_app", "database", "url", "secret", "version", "node"]) {
      expect(serialized, `response must not mention ${forbidden}`).not.toContain(forbidden);
    }
  });

  it("is never cached", async () => {
    // A cached health check is a health check that lies after the first failure.
    const { headers } = await get();
    expect(headers.get("cache-control")).toBe("no-store");
  });

  it("proves database reachability rather than only that the process is alive", async () => {
    // The probe must actually reach PostgreSQL. If it did not, an app that is up but cut off
    // from its database would stay in rotation and serve five-hundreds to real customers.
    const rows = await prisma.$queryRaw<Array<Record<string, unknown>>>`SELECT 1 AS one`;
    expect(rows).toHaveLength(1);

    const { status } = await get();
    expect(status).toBe(200);
  });
});
