import http from "node:http";
import type { AddressInfo } from "node:net";
import type { PgBoss } from "pg-boss";

/**
 * Minimal health endpoint for the worker container.
 *   GET /health  → 200 {"status":"ok"} once pg-boss has started, else 503
 *   GET /ready   → same semantics
 * Anything else → 404. No secrets, no environment values, no job payloads are exposed.
 */
export interface HealthServer {
  port: number;
  close: () => Promise<void>;
}

export function startHealthServer(boss: PgBoss, port: number, isStarted: () => boolean): Promise<HealthServer> {
  const server = http.createServer((req, res) => {
    if (req.method === "GET" && (req.url === "/health" || req.url === "/ready")) {
      const ok = isStarted();
      res.writeHead(ok ? 200 : 503, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: ok ? "ok" : "starting", service: "walaaplus-worker", schema: boss ? "pgboss" : null }));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, () => {
      const address = server.address() as AddressInfo;
      resolve({
        port: address.port,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}
