import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The two reverse-proxy configurations, and the staging environment template.
 *
 * `deploy/Caddyfile` is the local `--profile app` form: plain HTTP, `auto_https off`, because a
 * developer machine has no domain. `deploy/Caddyfile.staging` terminates TLS for a real hostname.
 * The failure worth guarding against is not a typo — it is the two files being swapped, or the
 * staging one quietly acquiring the local one's `auto_https off` during a debugging session and
 * keeping it. A staging deployment serving plain HTTP looks fine in a browser and silently makes
 * the entire PWA unverifiable: service workers and installability refuse to run without TLS.
 *
 * The forwarding-header rules are asserted in both files because they are the reason
 * TRUST_PROXY_HEADERS may be true at all. If the proxy ever APPENDS X-Forwarded-For instead of
 * SETTING it, the client's forged prefix reaches the rate limiter and every per-address limit in
 * the product becomes decoration — with no visible symptom.
 *
 * Every assertion runs against DIRECTIVE lines, never the raw file. Both files discuss the rules
 * they implement in comments — including naming the things they must not do — and a test that
 * reads comments fails on an explanation.
 */

const ROOT = path.resolve(import.meta.dirname, "../..");
const local = readFileSync(path.join(ROOT, "deploy/Caddyfile"), "utf8");
const staging = readFileSync(path.join(ROOT, "deploy/Caddyfile.staging"), "utf8");
const stagingEnvTemplate = readFileSync(path.join(ROOT, ".env.staging.example"), "utf8");
const runbook = readFileSync(path.join(ROOT, "docs/STAGING-RUNBOOK.md"), "utf8");
const cohostSnippet = readFileSync(path.join(ROOT, "deploy/Caddyfile.walaaplus-staging.caddy"), "utf8");

const NEWLINE = String.fromCharCode(10);

/** Directive lines only, comments and blanks removed. */
function directives(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
}

const SET_HEADERS = [
  "header_up X-Forwarded-For {remote_host}",
  "header_up X-Real-IP {remote_host}",
  "header_up X-Forwarded-Proto {scheme}",
  "header_up X-Forwarded-Host {host}",
];

const STRIPPED_HEADERS = [
  "header_up -Forwarded",
  "header_up -X-Forwarded-Server",
  "header_up -X-Client-IP",
  "header_up -CF-Connecting-IP",
  "header_up -True-Client-IP",
];

/** A hostname that looks real, e.g. `staging.walaaplus.com`. Owner decision B2 is still open. */
const REAL_LOOKING_DOMAIN = /(?:staging|www)\.[a-z0-9-]+\.(?:com|net|org|io|dev|sy)/i;

describe.each([
  ["deploy/Caddyfile", local],
  ["deploy/Caddyfile.staging", staging],
])("%s", (name, text) => {
  const lines = directives(text);
  const body = lines.join("\n");

  it("SETS every forwarding header from the connection it received", () => {
    for (const header of SET_HEADERS) {
      expect(lines, `${name} must set: ${header}`).toContain(header);
    }
  });

  it("strips the other headers a client might pass off as proxy state", () => {
    for (const header of STRIPPED_HEADERS) {
      expect(lines, `${name} must remove: ${header}`).toContain(header);
    }
  });

  it("never carries an inbound forwarding value through", () => {
    // Caddy's placeholder for the header the CLIENT sent. Using it in a header_up is how an
    // append gets written by accident. Both files name it in a comment, to say not to.
    expect(body).not.toContain("{http.request.header.X-Forwarded-For}");
  });

  it("answers its own health path instead of proxying it", () => {
    expect(lines).toContain("handle /healthz {");
    expect(lines).toContain('respond "ok" 200');
  });

  it("probes the application at an endpoint that proves the database is reachable", () => {
    expect(lines).toContain("health_uri /api/health");
  });

  it("keeps the admin API off", () => {
    expect(lines).toContain("admin off");
  });
});

describe("deploy/Caddyfile — local only", () => {
  const lines = directives(local);

  it("serves plain HTTP on :80 with automatic certificates disabled", () => {
    expect(lines).toContain("auto_https off");
    expect(lines.some((l) => l.startsWith(":80 {"))).toBe(true);
  });

  it("names no domain and no ACME account", () => {
    expect(lines.join("\n")).not.toContain("{$WALAAPLUS_DOMAIN}");
    expect(lines.some((l) => l.startsWith("email "))).toBe(false);
  });
});

describe("deploy/Caddyfile.staging — the deployed proxy", () => {
  const lines = directives(staging);

  it("leaves automatic HTTPS ON", () => {
    // The single most damaging line that could be copied over from the local file.
    expect(lines).not.toContain("auto_https off");
    expect(lines.join("\n")).not.toContain("auto_https");
  });

  it("takes its hostname and ACME contact from the environment, hardcoding neither", () => {
    expect(lines.some((l) => l.startsWith("{$WALAAPLUS_DOMAIN} {"))).toBe(true);
    expect(lines).toContain("email {$ACME_EMAIL}");
    // No real domain may be committed: the owner has not chosen one. A comment may use an
    // example hostname; a DIRECTIVE naming one would be a deployment pointing at it.
    expect(lines.join("\n")).not.toMatch(REAL_LOOKING_DOMAIN);
  });

  it("redirects plain HTTP to HTTPS rather than serving it", () => {
    expect(lines.some((l) => l.startsWith("http://{$WALAAPLUS_DOMAIN} {"))).toBe(true);
    expect(lines).toContain("redir https://{host}{uri} permanent");
  });

  it("keeps staging out of search results", () => {
    // Staging serves real-looking loyalty cards. It must never be indexed.
    expect(lines.some((l) => l.startsWith('X-Robots-Tag "noindex'))).toBe(true);
  });

  it("sets transport security without reaching beyond this subdomain", () => {
    const hsts = lines.find((l) => l.startsWith("Strict-Transport-Security"));
    expect(hsts).toBeDefined();
    // includeSubDomains/preload on a staging host would apply to the owner's other subdomains
    // and cannot be taken back quickly.
    expect(hsts).not.toContain("includeSubDomains");
    expect(hsts).not.toContain("preload");
  });

  it("refuses to be framed", () => {
    expect(lines).toContain("Content-Security-Policy \"frame-ancestors 'none'\"");
    expect(lines).toContain('X-Frame-Options "DENY"');
  });
});

describe(".env.staging.example", () => {
  it("names every variable the staging stack requires", () => {
    for (const name of [
      "WALAAPLUS_DOMAIN",
      "ACME_EMAIL",
      "POSTGRES_USER",
      "POSTGRES_PASSWORD",
      "APP_DB_PASSWORD",
      "NEXTAUTH_SECRET",
    ]) {
      expect(stagingEnvTemplate, `template must name ${name}`).toMatch(new RegExp(`^${name}=`, "m"));
    }
  });

  it("assigns no value to anything", () => {
    // A template with a value in it is a template someone will deploy unchanged.
    const assignments = stagingEnvTemplate
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => /^[A-Z][A-Z0-9_]*=/.test(line))
      .filter((line) => line.split("=").slice(1).join("=").trim().length > 0);
    expect(assignments).toEqual([]);
  });

  it("names no real domain either", () => {
    expect(stagingEnvTemplate).not.toMatch(REAL_LOOKING_DOMAIN);
  });

  it("documents the webhook encryption key, and says both processes need the same value", () => {
    /*
     * The variable a staging deployment was blocked on. It is OPTIONAL — a stack that configures
     * no webhooks starts fine without it — so it is not in the required list above. But an
     * operator who cannot find its name in the template will not set it at all, and the failure
     * that follows is silent from the outside: the application runs, and only webhooks refuse.
     *
     * The template must therefore name it, must say the generation command, and must say that web
     * AND worker receive the same value. Half a stack holding the key is worse than neither half
     * holding it: destinations save and never deliver.
     */
    expect(stagingEnvTemplate).toMatch(/^INTEGRATION_ENCRYPTION_KEY=$/m);
    expect(stagingEnvTemplate).toContain("openssl rand -hex 32      # INTEGRATION_ENCRYPTION_KEY");
    expect(stagingEnvTemplate).toMatch(/BOTH web and worker/);
    expect(stagingEnvTemplate).toMatch(/PER ENVIRONMENT/);
    // And it must still be true that leaving it blank is a supported state, not a broken one.
    expect(stagingEnvTemplate).toMatch(/LEAVING IT BLANK IS SUPPORTED/);
  });

  it("documents the egress gateway secret as a SEPARATE optional value", () => {
    /*
     * The failure this guards against is not a missing variable, it is a REUSED one. An operator
     * who sees two 32-byte hex secrets in the same file and pastes the same value into both has
     * made a single compromise open two doors: the encryption key protects destination URLs and
     * signing secrets at rest, the gateway secret authenticates a caller on an internal hop.
     *
     * So the template must name it, must give its own generation command, and must say in words
     * that it is a different value from the other one.
     */
    expect(stagingEnvTemplate).toMatch(/^WEBHOOK_GATEWAY_SECRET=$/m);
    expect(stagingEnvTemplate).toContain("openssl rand -hex 32      # WEBHOOK_GATEWAY_SECRET");
    expect(stagingEnvTemplate).toMatch(/DIFFERENT values, never one reused|A DISTINCT secret/);
    expect(stagingEnvTemplate).toMatch(/never be the same value as INTEGRATION_ENCRYPTION_KEY/);
    // Both processes that need it, named; and blank stated as supported rather than broken.
    expect(stagingEnvTemplate).toMatch(/BOTH the worker and the webhook-egress service/);
    expect(stagingEnvTemplate).toMatch(/LEAVING IT BLANK IS SUPPORTED[\s\S]*GATEWAY_UNAVAILABLE/);
  });

  it("does not turn the gateway's address into a secret", () => {
    // WEBHOOK_GATEWAY_URL is a service name and a port. It belongs in the "set by compose" list,
    // not in the secret list, and the template must not invite anyone to generate one.
    expect(stagingEnvTemplate).toMatch(/WEBHOOK_GATEWAY_URL\s+http:\/\/webhook-egress:8082/);
    expect(stagingEnvTemplate).not.toMatch(/^WEBHOOK_GATEWAY_URL=/m);
  });
});

describe("database password guidance", () => {
  /*
   * Both database passwords are interpolated into a connection string by Compose, which
   * substitutes them verbatim and cannot percent-encode. `openssl rand -base64 24` produces a
   * `/` in roughly a third of its output, and
   *
   *   postgresql://walaaplus:ab/cd@db:5432/loyalty
   *
   * is not a URL: the authority ends at the slash. The instructions therefore worked or failed
   * depending on which bytes openssl happened to draw, which is the worst way for a deployment
   * step to be wrong - it looks like an intermittent infrastructure problem rather than a
   * documentation bug. Hex is [0-9a-f] and removes the class of failure entirely.
   */
  const sources: Array<[string, string]> = [
    [".env.staging.example", stagingEnvTemplate],
    ["docs/STAGING-RUNBOOK.md", runbook],
  ];

  it.each(sources)("%s generates both database passwords as hex", (_name, text) => {
    const generation = text.split("\n").filter((line) => line.includes("openssl rand"));
    const forDatabase = generation.filter(
      (line) => line.includes("POSTGRES_PASSWORD") || line.includes("APP_DB_PASSWORD"),
    );
    // One command per database password, and no more than the two roles that exist.
    expect(forDatabase.length).toBeGreaterThanOrEqual(2);
    for (const line of forDatabase) {
      expect(line, "a database password must be generated as hex").toContain("openssl rand -hex");
      expect(line, "base64 uses / and + and breaks the connection string").not.toContain("-base64");
    }
  });

  it.each(sources)("%s still generates the session secret as base64", (_name, text) => {
    // NEXTAUTH_SECRET never goes into a URL, so it keeps the denser alphabet.
    const line = text.split("\n").find((l) => l.includes("openssl rand") && l.includes("NEXTAUTH_SECRET"));
    expect(line).toBeDefined();
    expect(line).toContain("-base64");
  });

  it("explains why, so the next person does not switch it back", () => {
    for (const [name, text] of sources) {
      expect(text, `${name} must say why hex`).toMatch(/not a URL|breaks|ends the (?:URL's )?authority/i);
    }
  });
});

describe("deploy/Caddyfile.walaaplus-staging.caddy — a fragment for an existing host Caddy", () => {
  /*
   * This file is inserted by hand into a host /etc/caddy/Caddyfile that already serves
   * OpenClaw/OpenBot. Two failure modes matter more than anything else it could get wrong.
   *
   * A global options block. A Caddyfile may contain exactly one `{ ... }` block at the top, and
   * the host already has it. A second one is a parse error, and a parse error in that file takes
   * the EXISTING sites down — this fragment would break the neighbours, not just itself.
   *
   * An upstream that is not 127.0.0.1:3100. Ports 3456, 5432 and 18789 on that host belong to
   * OpenBot; proxying a public hostname at one of them would expose someone else's service under
   * a WalaaPlus name.
   */
  const lines = directives(cohostSnippet);
  const body = lines.join(NEWLINE);

  it("declares one site, and it is the staging hostname", () => {
    const siteLines = lines.filter((l) => l.endsWith("{") && !l.startsWith("header") && !l.startsWith("handle") && !l.startsWith("reverse_proxy"));
    expect(siteLines).toEqual(["staging.truebiznes.com {"]);
  });

  it("contains no global options block", () => {
    // A global block is a bare `{` on its own line, before any site address.
    expect(lines, "a second global options block breaks the whole host Caddyfile").not.toContain("{");
    for (const global of ["auto_https", "admin ", "email ", "debug", "storage "]) {
      expect(body, `a fragment must not set the global option: ${global}`).not.toContain(global);
    }
  });

  it("binds no port and names no listener", () => {
    // `:80 {` or `:443 {` would make this fragment try to own a port the host Caddy already has.
    expect(lines.some((l) => /^:\d+/.test(l)), "a fragment must not declare a listener").toBe(false);
    expect(body).not.toContain("bind ");
  });

  it("proxies to loopback 3100 and to nothing else", () => {
    const upstreams = lines.filter((l) => l.startsWith("reverse_proxy"));
    expect(upstreams).toHaveLength(1);
    expect(upstreams[0]).toBe("reverse_proxy 127.0.0.1:3100 {");
  });

  it("never points at a port that belongs to the neighbours", () => {
    for (const port of ["3456", "5432", "18789"]) {
      expect(body, `${port} belongs to another service on that host`).not.toContain(port);
    }
  });

  it("SETS every forwarding header from the connection it received", () => {
    for (const header of SET_HEADERS) {
      expect(lines, `the fragment must set: ${header}`).toContain(header);
    }
  });

  it("strips the other headers a client might pass off as proxy state", () => {
    for (const header of STRIPPED_HEADERS) {
      expect(lines, `the fragment must remove: ${header}`).toContain(header);
    }
  });

  it("never carries an inbound forwarding value through", () => {
    // An APPENDED X-Forwarded-For carries the client's forged prefix to the rate limiter, and
    // the application is configured to believe it.
    expect(body).not.toContain("{http.request.header.X-Forwarded-For}");
  });

  it("answers its own health path instead of proxying it", () => {
    expect(lines).toContain("handle /healthz {");
    expect(lines).toContain('respond "ok" 200');
  });

  it("probes the application where a database outage is visible", () => {
    expect(lines).toContain("health_uri /api/health");
  });

  it("carries the same staging security headers as the dedicated stack", () => {
    expect(lines.some((l) => l.startsWith('X-Robots-Tag "noindex'))).toBe(true);
    expect(lines).toContain('X-Content-Type-Options "nosniff"');
    expect(lines).toContain("Content-Security-Policy \"frame-ancestors 'none'\"");
    expect(lines).toContain('X-Frame-Options "DENY"');
    expect(lines).toContain("-Server");

    const hsts = lines.find((l) => l.startsWith("Strict-Transport-Security"));
    expect(hsts).toBeDefined();
    // This is one subdomain of a domain used for other things; those two directives would reach
    // every other name under it and could not be taken back quickly.
    expect(hsts).not.toContain("includeSubDomains");
    expect(hsts).not.toContain("preload");
  });
});
