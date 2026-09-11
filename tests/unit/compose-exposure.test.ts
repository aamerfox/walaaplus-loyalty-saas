import { readFileSync } from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { describe, expect, it } from "vitest";

/**
 * Network exposure and credential reach of the Compose stacks.
 *
 * Two files are held to this policy, for different reasons.
 *
 * **docker-compose.yml** is the local stack. Its claim — that the reverse proxy is the only
 * publicly reachable service — was once false: PostgreSQL was published as `5433:5432` and the
 * worker's health endpoint as `8081:8081`, and a short-form Compose mapping without a host IP
 * binds **0.0.0.0**, which on a VPS is every interface including the public one.
 *
 * **docker-compose.staging.yml** is a real deployment that faces the internet, so it is held to
 * a stricter rule than the local file: the database publishes nothing at all, not even a loopback
 * port, and lives on a network with `internal: true` — no gateway, no route out, no route in.
 *
 * Both files are also checked for CREDENTIAL REACH. `env_file: .env` on `web` used to hand the
 * application container every variable in the file, including the migrator password, both test
 * database URLs and some leftover prototype API keys, while the comment beside it claimed the
 * opposite. A service may only receive variables named on its own `environment:` block.
 *
 * The files are parsed as YAML rather than run through `docker compose config`, so these tests
 * need no Docker daemon and run in the unit project, inside the gate, on every commit.
 */

const ROOT = path.resolve(import.meta.dirname, "../..");
const LOCAL = path.join(ROOT, "docker-compose.yml");
const STAGING = path.join(ROOT, "docker-compose.staging.yml");

interface ComposeService {
  ports?: unknown[];
  expose?: unknown[];
  env_file?: unknown;
  environment?: Record<string, unknown> | string[];
  networks?: unknown;
}
interface ComposeFile {
  services: Record<string, ComposeService>;
  networks?: Record<string, { internal?: boolean } | null>;
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

function load(file: string): ComposeFile {
  return yaml.load(readFileSync(file, "utf8")) as ComposeFile;
}

function bindings(file: string): Binding[] {
  const compose = load(file);
  return Object.entries(compose.services).flatMap(([service, def]) =>
    (def.ports ?? []).map((entry) => bindingOf(service, entry)),
  );
}

/** Variable NAMES a service receives. Values are never read, printed or asserted on. */
function envNames(service: ComposeService): string[] {
  const env = service.environment;
  if (Array.isArray(env)) return env.map((e) => String(e).split("=")[0]);
  return Object.keys(env ?? {});
}

/** Names that carry, or build, the owner/migrator credential. */
const MIGRATOR_VARIABLES = /^(MIGRATE_DATABASE_URL|POSTGRES_PASSWORD|POSTGRES_USER)$/;

describe("docker-compose.yml — the local stack", () => {
  const PUBLIC_SERVICES = new Set(["proxy"]);
  const LOOPBACK_SERVICES = new Map([
    ["db", "host tooling: prisma migrate, psql, npm run db:seed"],
    ["test-db", "the integration suite runs on the host"],
  ]);

  it("parses, and every service is accounted for by this policy", () => {
    expect(Object.keys(load(LOCAL).services).sort()).toEqual(["db", "migrate", "proxy", "test-db", "web", "worker"]);
  });

  it("publishes exactly one public binding, and it is the proxy", () => {
    const publicBindings = bindings(LOCAL).filter((b) => b.published && b.hostIp === null);
    expect(publicBindings.map((b) => b.service)).toEqual(["proxy"]);
    expect(publicBindings).toHaveLength(1);
  });

  it("binds every other published port to 127.0.0.1 only", () => {
    for (const b of bindings(LOCAL)) {
      if (PUBLIC_SERVICES.has(b.service)) continue;
      expect(LOOPBACK_SERVICES.has(b.service), `${b.service} may not publish a port at all: ${b.entry}`).toBe(true);
      expect(b.hostIp, `${b.service} must bind 127.0.0.1, got: ${b.entry}`).toBe("127.0.0.1");
    }
  });

  it("publishes nothing from the application services", () => {
    const compose = load(LOCAL);
    for (const service of ["web", "worker", "migrate"]) {
      expect(compose.services[service].ports, `${service} must not publish any port`).toBeUndefined();
    }
  });

  it("keeps web and worker reachable inside the network via expose", () => {
    const compose = load(LOCAL);
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

describe("docker-compose.staging.yml — the deployed stack", () => {
  it("parses, and defines no test database", () => {
    const services = Object.keys(load(STAGING).services).sort();
    expect(services).toEqual(["db", "migrate", "proxy", "web", "worker"]);
    // A throwaway database holding the migrator credentials, with its data in tmpfs, has no
    // business on a server that faces the internet.
    expect(services).not.toContain("test-db");
  });

  it("publishes 80 and 443 from the proxy, and nothing else from anything else", () => {
    const all = bindings(STAGING);
    expect(all.every((b) => b.service === "proxy"), "only the proxy may publish a port").toBe(true);
    expect(all.map((b) => b.entry).sort()).toEqual(["443:443", "80:80"]);
  });

  it("gives the database no published port at all, not even a loopback one", () => {
    // The local file binds 127.0.0.1 so prisma and psql can reach the database from the host.
    // A server needs no such thing: migrations run in the `migrate` container and a backup runs
    // inside the database container.
    expect(load(STAGING).services.db.ports).toBeUndefined();
  });

  it("puts the database on an internal network, so there is no route rather than a closed port", () => {
    const compose = load(STAGING);
    expect(compose.networks?.backend?.internal).toBe(true);
    expect(compose.services.db.networks).toEqual(["backend"]);
    expect(compose.services.worker.networks).toEqual(["backend"]);
    expect(compose.services.migrate.networks).toEqual(["backend"]);
    // Only the proxy touches the network that has a way out.
    expect(compose.services.proxy.networks).toEqual(["edge"]);
    expect(compose.services.web.networks).toEqual(["backend", "edge"]);
  });

  it("exposes the app and worker inside the network only", () => {
    const compose = load(STAGING);
    expect(compose.services.web.expose?.map(String)).toEqual(["3000"]);
    expect(compose.services.worker.expose?.map(String)).toEqual(["8081"]);
  });

  it("mounts the TLS-terminating proxy configuration, not the plain-HTTP local one", () => {
    const volumes = (load(STAGING).services.proxy as { volumes?: string[] }).volumes ?? [];
    expect(volumes.some((v) => v.startsWith("./deploy/Caddyfile.staging:"))).toBe(true);
    expect(volumes.some((v) => v.startsWith("./deploy/Caddyfile:"))).toBe(false);
  });
});

describe.each([
  ["docker-compose.yml", LOCAL],
  ["docker-compose.staging.yml", STAGING],
])("%s — credential reach", (_name, file) => {
  it("hands no service a whole env file", () => {
    // `env_file:` passes EVERY variable in the file to the container. Naming variables one by
    // one is the only way the next two assertions can be true by construction.
    for (const [service, def] of Object.entries(load(file).services)) {
      expect(def.env_file, `${service} must not use env_file`).toBeUndefined();
    }
  });

  it("gives the migrator credential to the migrate service and to nothing else", () => {
    const compose = load(file);
    expect(envNames(compose.services.migrate).some((n) => MIGRATOR_VARIABLES.test(n))).toBe(true);
    for (const service of ["web", "worker"]) {
      const leaked = envNames(compose.services[service]).filter((n) => MIGRATOR_VARIABLES.test(n));
      expect(leaked, `${service} must never receive the migrator credential`).toEqual([]);
    }
  });

  it("gives the application only variables it needs, and no test-database URLs", () => {
    const compose = load(file);
    for (const service of ["web", "worker"]) {
      const names = envNames(compose.services[service]);
      expect(names).toContain("DATABASE_URL");
      expect(names.filter((n) => n.startsWith("TEST_")), `${service} must not see test variables`).toEqual([]);
    }
  });
});
