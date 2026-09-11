import { readFileSync } from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { describe, expect, it } from "vitest";

/**
 * Network exposure and credential reach of the Compose stacks.
 *
 * Three files are held to this policy, for different reasons.
 *
 * **docker-compose.yml** is the local stack. Its claim — that the reverse proxy is the only
 * publicly reachable service — was once false: PostgreSQL was published as `5433:5432` and the
 * worker's health endpoint as `8081:8081`, and a short-form Compose mapping without a host IP
 * binds **0.0.0.0**, which on a VPS is every interface including the public one.
 *
 * **docker-compose.staging.yml** is a deployment that faces the internet on a DEDICATED server,
 * so it is stricter: the database publishes nothing at all, not even a loopback port, and lives
 * on a network with `internal: true` — no gateway, no route out, no route in.
 *
 * **docker-compose.staging-cohost.yml** is the same application on a SHARED server whose ports 80
 * and 443 already belong to another service. It ships no proxy at all and publishes exactly one
 * port, on loopback. The thing that must never regress here is the host IP: a mapping that lost
 * its `127.0.0.1:` prefix would put the application straight onto the public internet, beside the
 * proxy that is supposed to be in front of it, with `TRUST_PROXY_HEADERS` already true.
 *
 * All three are also checked for CREDENTIAL REACH. `env_file: .env` on `web` used to hand the
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
const COHOST = path.join(ROOT, "docker-compose.staging-cohost.yml");

interface ComposeService {
  ports?: unknown[];
  expose?: unknown[];
  env_file?: unknown;
  environment?: Record<string, unknown> | string[];
  networks?: unknown;
  image?: string;
  build?: unknown;
}
interface ComposeFile {
  name?: string;
  services: Record<string, ComposeService>;
  networks?: Record<string, { internal?: boolean; external?: boolean } | null>;
  volumes?: Record<string, { external?: boolean } | null>;
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

describe("docker-compose.staging.yml — the dedicated server", () => {
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

describe("docker-compose.staging-cohost.yml — a shared server", () => {
  /*
   * The target host already runs OpenClaw/OpenBot behind a system-managed Caddy that owns 80 and
   * 443. This stack adds one site to that Caddy rather than a second proxy, so it publishes one
   * loopback port and nothing else. Ports 3456, 5432 and 18789 belong to the neighbours.
   */
  const FORBIDDEN_HOST_PORTS = ["80", "443", "3456", "5432", "18789"];

  it("contains only the four application services", () => {
    expect(Object.keys(load(COHOST).services).sort()).toEqual(["db", "migrate", "web", "worker"]);
  });

  it("ships no proxy of its own", () => {
    const compose = load(COHOST);
    // By name...
    for (const forbidden of ["proxy", "caddy", "nginx", "traefik"]) {
      expect(compose.services[forbidden], `${forbidden} must not exist in the co-hosted stack`).toBeUndefined();
    }
    // ...and by image, so renaming the service does not sneak one back in.
    for (const [name, service] of Object.entries(compose.services)) {
      expect(service.image ?? "", `${name} must not be a proxy image`).not.toMatch(/caddy|nginx|traefik|haproxy/i);
    }
  });

  it("publishes exactly one port, from web, bound to loopback", () => {
    const all = bindings(COHOST);
    expect(all).toHaveLength(1);
    expect(all[0].service).toBe("web");
    // The exact string, not a parsed approximation: this is the line that must never drift.
    expect(all[0].entry).toBe("127.0.0.1:3100:3000");
    expect(all[0].hostIp).toBe("127.0.0.1");
  });

  it("never binds a port that belongs to the host or its neighbours", () => {
    const published = bindings(COHOST).map((b) => b.entry);
    for (const port of FORBIDDEN_HOST_PORTS) {
      for (const entry of published) {
        const host = entry.split(":").at(-2);
        expect(host, `${entry} must not publish host port ${port}`).not.toBe(port);
      }
    }
  });

  it("publishes nothing from the database, the worker or the migrator", () => {
    const compose = load(COHOST);
    for (const service of ["db", "worker", "migrate"]) {
      expect(compose.services[service].ports, `${service} must not publish any port`).toBeUndefined();
    }
  });

  it("keeps the database on an internal network with the worker and the migrator", () => {
    const compose = load(COHOST);
    expect(compose.networks?.backend?.internal).toBe(true);
    expect(compose.services.db.networks).toEqual(["backend"]);
    expect(compose.services.worker.networks).toEqual(["backend"]);
    expect(compose.services.migrate.networks).toEqual(["backend"]);
    // `web` needs a routed network for its published port to be reachable from loopback.
    expect(compose.services.web.networks).toEqual(["backend", "edge"]);
  });

  it("joins nothing that already exists on the host", () => {
    const compose = load(COHOST);
    // `external: true` would attach this stack to a network or volume created by something else
    // — which, on this host, means OpenBot's.
    for (const [name, net] of Object.entries(compose.networks ?? {})) {
      expect(net?.external, `network ${name} must not be external`).toBeFalsy();
    }
    for (const [name, vol] of Object.entries(compose.volumes ?? {})) {
      expect(vol?.external, `volume ${name} must not be external`).toBeFalsy();
    }
    // Its own database volume, not a shared one.
    expect(Object.keys(compose.volumes ?? {})).toEqual(["db-data"]);
  });

  it("carries its own project name, so its networks and volumes cannot collide", () => {
    const compose = load(COHOST);
    expect(compose.name).toBe("walaaplus-staging-cohost");
    expect(compose.name).not.toBe(load(STAGING).name);
  });

  it("still orders the database, then the migration, then the application", () => {
    const compose = load(COHOST) as unknown as {
      services: Record<string, { depends_on?: Record<string, { condition?: string }> }>;
    };
    for (const service of ["web", "worker"]) {
      expect(compose.services[service].depends_on?.db?.condition).toBe("service_healthy");
      expect(compose.services[service].depends_on?.migrate?.condition).toBe("service_completed_successfully");
    }
    expect(compose.services.migrate.depends_on?.db?.condition).toBe("service_healthy");
  });
});

describe.each([
  ["docker-compose.yml", LOCAL],
  ["docker-compose.staging.yml", STAGING],
  ["docker-compose.staging-cohost.yml", COHOST],
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
