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
});
