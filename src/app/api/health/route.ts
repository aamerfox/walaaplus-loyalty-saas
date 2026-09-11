import { NextResponse } from "next/server";
import { prisma } from "@/server/db";

/**
 * GET /api/health — liveness and database readiness for the container orchestrator.
 *
 * Deliberately the smallest endpoint in the product, because it is the only unauthenticated one
 * that a load balancer will call forever:
 *
 *  - **It says `ok` or `degraded`, and nothing else.** No version, no environment, no database
 *    name, no error text, no stack. A health endpoint that reports *why* it is unhealthy tells an
 *    anonymous caller about the inside of the deployment; the operator reads that from the logs,
 *    which are not public.
 *  - **`SELECT 1` and no more.** The probe proves the process is alive and its connection pool
 *    can reach PostgreSQL as the runtime role. It does not count rows, touch tenant data, or run
 *    anything a burst of requests could turn into load.
 *  - **Never cached.** A cached health check is a health check that lies after the first failure.
 *
 * The proxy probes this from inside the private network (deploy/Caddyfile.staging). It is also
 * reachable publicly, which is normal for a health path and safe given the above.
 */
export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET() {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return NextResponse.json({ status: "ok" }, { status: 200, headers: { "cache-control": "no-store" } });
  } catch {
    // The reason is logged by the caller of the failing query, not returned to an anonymous client.
    return NextResponse.json({ status: "degraded" }, { status: 503, headers: { "cache-control": "no-store" } });
  }
}
