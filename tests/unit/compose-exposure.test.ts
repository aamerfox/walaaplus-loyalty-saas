import { readFileSync } from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { describe, expect, it } from "vitest";

/**
 * Phase 0.3 security remediation — network exposure of the Compose stack.
 *
 * The documentation claims the reverse proxy is the only publicly reachable service. That claim
 * was once false: PostgreSQL was published as `5433:5432` and the worker's health endpoint as
 * `8081:8081`, and a short-form Compose mapping without a host IP binds **0.0.0.0** — on a VPS
 * that is every interface, including the public one.
 *
 * This test reads docker-compose.yml and holds the policy:
 *
 *   - exactly one service may bind a public interface, and it is `proxy`;
 *   - any other published port must be bound to 127.0.0.1, and exists only so host tooling
 *     (prisma, psql, the integration suite) can reach a local database;
 *   - application services publish nothing at all.
 *
 * It parses the file rather than `docker compose config` so it needs no Docker daemon and runs
 * in the unit project, inside the gate, on every commit.
 */

const COMPOSE = path.resolve(import.meta.dirname, "../../docker-compose.yml");

/** Services allowed to bind a public interface. */
const PUBLIC_SERVICES = new Set(["proxy"]);
/** Services allowed a loopback-only binding, and why. */
const LOOPBACK_SERVICES = new Map([
  ["db", "host tooling: prisma migrate, psql, npm run db:seed"],
  ["test-db", "the integration suite runs on the host"],
]);

interface ComposeFile {
  services: Record<string, { ports?: unknown[]; expose?: unknown[] }>;
}

interface Binding {
  service: string;
  entry: string;
  hostIp: string | null;
  published: boolean;
}

/**
 * Host IP of one short- or long-form port entry.
 *
 * `${VAR:-default}` contains a colon, so the interpolation is masked before splitting; otherwise
 * `"${POSTGRES_PORT:-5433}:5432"` looks like a three-part `ip:host:container` mapping and a
 * missing host IP would go unnoticed — exactly the bug this test exists to catch.
 */
function bindingOf(service: string, entry: unknown): Binding {
  if (entry !== null && typeof entry === "object") {
    const long = entry as { host_ip?: string; published?: unknown };
    return {
      service,
      entry: JSON.stringify(entry),
      hostIp: long.host_ip ?? null,
      published: long.published !== undefined,
    };
  }
  const text = String(entry);
  const masked = text.replace(/\$\{[^}]*\}/g, "VAR");
  const parts = masked.split(":");
  // 3 parts = ip:host:container, 2 parts = host:container (binds every interface), 1 = container only.
  const hostIp = parts.length >= 3 ? text.slice(0, text.indexOf(":")) : null;
  return { service, entry: text, hostIp, published: parts.length >= 2 };
}

function loadCompose(): ComposeFile {
  return yaml.load(readFileSync(COMPOSE, "utf8")) as ComposeFile;
}

function allBindings(): Binding[] {
  const compose = loadCompose();
  return Object.entries(compose.services).flatMap(([service, def]) =>
    (def.ports ?? []).map((entry) => bindingOf(service, entry)),
  );
}

describe("docker-compose network exposure", () => {
  it("parses, and every service is accounted for by this policy", () => {
    const compose = loadCompose();
    const services = Object.keys(compose.services).sort();
    expect(services).toEqual(["db", "migrate", "proxy", "test-db", "web", "worker"]);
  });

  it("publishes exactly one public binding, and it is the proxy", () => {
    const publicBindings = allBindings().filter((b) => b.published && b.hostIp === null);
    expect(publicBindings.map((b) => b.service)).toEqual(["proxy"]);
    expect(publicBindings).toHaveLength(1);
  });

  it("binds every other published port to 127.0.0.1 only", () => {
    for (const b of allBindings()) {
      if (PUBLIC_SERVICES.has(b.service)) continue;
      expect(LOOPBACK_SERVICES.has(b.service), `${b.service} may not publish a port at all: ${b.entry}`).toBe(true);
      expect(b.hostIp, `${b.service} must bind 127.0.0.1, got: ${b.entry}`).toBe("127.0.0.1");
    }
  });

  it("publishes nothing from the application services", () => {
    const compose = loadCompose();
    for (const service of ["web", "worker", "migrate"]) {
      expect(compose.services[service].ports, `${service} must not publish any port`).toBeUndefined();
    }
  });

  it("keeps web and worker reachable inside the network via expose", () => {
    const compose = loadCompose();
    expect(compose.services.web.expose?.map(String)).toEqual(["3000"]);
    expect(compose.services.worker.expose?.map(String)).toEqual(["8081"]);
  });

  it("catches a public binding that hides behind a variable default", () => {
    // The regression this test is named for: a colon inside ${VAR:-default} must not be mistaken
    // for the ip:host:container separator.
    expect(bindingOf("db", "${POSTGRES_PORT:-5433}:5432").hostIp).toBeNull();
    expect(bindingOf("db", "127.0.0.1:${POSTGRES_PORT:-5433}:5432").hostIp).toBe("127.0.0.1");
    expect(bindingOf("proxy", "${WEB_PORT:-8080}:80").published).toBe(true);
    expect(bindingOf("x", "8081").published).toBe(false);
  });
});
