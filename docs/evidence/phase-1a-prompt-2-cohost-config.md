# Evidence — Co-hosted OCI Staging Configuration

**Date:** 2026-09-11
**Performed by:** development agent (Claude Opus 5)
**Branch:** `rebuild/phase-0-foundation`
**Scope:** repository files only. **No deployment, and no contact of any kind with the OCI host.**

---

## 1. Result

**PASS — the configuration is written, validated locally, and ready for review.** It has not been
deployed, and deploying it is not part of this task.

| Check | Result |
|---|---|
| `npm run gate` on `2e4e17d` | **PASS 13/13 in 304.7 s** |
| unit tests | **188** (12 files), up 23 |
| integration tests | **368** (31 files), unchanged |
| Playwright | **3 passed (45.4 s)** |
| `npm audit`, full tree and production/high+ | **0 vulnerabilities** each |
| `docker compose … config --quiet` on the new file | valid |
| `caddy validate` on the new fragment, alone and combined | **Valid configuration**, both |

**Nothing was deployed. Nothing remote was touched.** See §7.

---

## 2. Commits

On top of `9d3cb67`. `master` untouched at `b9ee686`; the branch still has no upstream and
nothing was pushed.

| # | SHA | Subject |
|---|---|---|
| 1 | `2e4e17d` | feat(ops): a co-hosted staging stack for a server that already owns 80 and 443 |
| 2 | (this commit) | docs: the co-hosted configuration evidence |

Files in commit 1:

```
 .env.staging.example                     |  10 +-
 deploy/Caddyfile.walaaplus-staging.caddy | 105 +++++
 docker-compose.staging-cohost.yml        | 162 ++++++
 docs/STAGING-RUNBOOK.md                  | 175 +++++++
 tests/unit/compose-exposure.test.ts      | 118 ++++--
 tests/unit/deploy-config.test.ts         |  93 +++++
```

`docker-compose.staging.yml` and `deploy/Caddyfile.staging` are **byte-identical** to before this
work: `git diff 9d3cb67..HEAD -- docker-compose.staging.yml deploy/Caddyfile.staging` produces
zero lines. The dedicated-server shape is untouched and remains the target for a future dedicated
box, as required.

---

## 3. The problem this solves

The staging host is not a dedicated machine. It is Oracle Linux 9.8 already running
OpenClaw/OpenBot behind a **system-managed Caddy service that owns ports 80 and 443**, with Docker
Engine and the Compose plugin installed and `127.0.0.1:3100` free.

`docker-compose.staging.yml` cannot run there. Its `proxy` service publishes `80:80` and
`443:443`; on that host it would either fail to start or, worse, take the existing sites down. A
second Caddy is also simply redundant when a working one is already installed and holding a
certificate store.

So this is a third Compose file rather than an edit to the second one. The three are
self-contained and must never be combined:

| File | Server | Publishes |
|---|---|---|
| `docker-compose.yml` | a developer machine | proxy on `${WEB_PORT:-8080}`, two databases on `127.0.0.1` |
| `docker-compose.staging.yml` | a dedicated server | proxy on `80` and `443` |
| **`docker-compose.staging-cohost.yml`** | **a shared server** | **`127.0.0.1:3100` and nothing else** |

---

## 4. What was built

### 4.1 `docker-compose.staging-cohost.yml`

Four services and no proxy: `db`, `migrate`, `web`, `worker`.

Resolved by `docker compose config`, with placeholder values from a scratch env file outside the
repository:

```
project: walaaplus-staging-cohost
networks: backend (internal), edge (routed)
volumes: db-data
db       published=[]                          nets=[backend]      env=[POSTGRES_DB,POSTGRES_PASSWORD,POSTGRES_USER]
migrate  published=[]                          nets=[backend]      env=[DATABASE_URL,MIGRATE_DATABASE_URL]
web      published=[127.0.0.1:3100->3000/tcp]  nets=[backend edge] env=[DATABASE_URL,NEXTAUTH_SECRET,NEXTAUTH_URL,NODE_ENV,TRUST_PROXY_HEADERS]
worker   published=[]                          nets=[backend]      env=[DATABASE_URL,NEXTAUTH_SECRET,NEXTAUTH_URL,NODE_ENV,WORKER_HEALTH_PORT]
```

Point by point against the required design:

| # | Requirement | How it is met |
|---|---|---|
| 1 | No Caddy/proxy container | Four services, none of them a proxy. Asserted by name **and by image pattern**, so renaming a service cannot sneak one in |
| 2 | PostgreSQL has no published port | `db` has no `ports:` key at all. Not even a loopback mapping |
| 3 | Worker has no published port | `worker` has no `ports:` key; `expose: 8081` is container-only |
| 4 | Web is the only published service, exactly `127.0.0.1:3100:3000` | Written as a **literal**, not an interpolation. An interpolated host address is one typo away from `0.0.0.0` |
| 5 | Isolated networks and volumes; never touch OpenBot | Own project name `walaaplus-staging-cohost`; **no `external: true` anywhere**; its own `db-data` volume; own PostgreSQL container |
| 6 | Migrator/runtime role separation | `MIGRATE_DATABASE_URL` reaches `migrate` and nothing else; `web` and `worker` get the runtime role only. No `env_file` anywhere |
| 7 | Startup order | `db` healthy → `migrate` `service_completed_successfully` → `web` and `worker` |
| 8 | Environment validation, no fallback secrets | `src/server/env.ts` unchanged; every required variable uses `${VAR:?message}` so Compose refuses to start on a missing one |

**Ports belonging to the neighbours — 3456, 5432 and 18789 — are never bound.** `5432` appears in
the file only as the *container-side* port of the private `db` service, which is not a host
binding; there is no `ports:` entry on that service at all.

### 4.2 `deploy/Caddyfile.walaaplus-staging.caddy`

A site block for `staging.truebiznes.com` reverse-proxying to `127.0.0.1:3100`, intended for
manual insertion into `/etc/caddy/Caddyfile` by whoever administers the host.

| Requirement | How it is met |
|---|---|
| HTTPS through the existing system Caddy | The site address is a hostname, so the host Caddy serves it on the ports it already listens on and obtains the certificate itself |
| No global Caddy options | **No `{ ... }` block, no `email`, no `auto_https`, no `admin`, no `storage`, no `debug`.** A Caddyfile may contain exactly one global block; the host already has it, and a second is a parse error that takes the host's *existing* sites down |
| No port bindings | No listener address, no `bind`. Asserted by a test that rejects any directive starting `:<digits>` |
| Reverse proxy only to `127.0.0.1:3100` | Exactly one `reverse_proxy` directive, and its upstream is that address |
| Replace, never append, forwarded headers | Four `header_up` directives **with values**, which SET and replace. Caddy's `{http.request.header.X-Forwarded-For}` placeholder — the way an append gets written by accident — appears nowhere |
| Remove untrusted variants | `-Forwarded`, `-X-Forwarded-Server`, `-X-Client-IP`, `-CF-Connecting-IP`, `-True-Client-IP` |
| Same approved staging security headers | `X-Robots-Tag: noindex, nofollow`; HSTS 60 days **without** `includeSubDomains` or `preload`; `nosniff`; `Referrer-Policy`; `frame-ancestors 'none'`; `X-Frame-Options: DENY`; `-Server` |
| Do not reload Caddy or request a certificate | Nothing in this repository reads the file. It is inert until a human inserts it |

HSTS deliberately omits `includeSubDomains` and `preload`: `staging.truebiznes.com` is one
subdomain of a domain used for other things, and those directives would reach every other name
under it and could not be withdrawn quickly.

### 4.3 Environment template

**No new template was created.** `.env.staging.example` already names every variable the
co-hosted stack needs, so it gained two notes instead: which Compose file each command line uses,
and that `ACME_EMAIL` is unused in the co-hosted shape because the host Caddy already has an ACME
account. A second template would have been a second thing to drift.

The template still assigns no value to anything, which is asserted by a test.

### 4.4 Runbook

`docs/STAGING-RUNBOOK.md` gained a **§13 "Co-hosted OCI staging"**, and a table at the top so
nobody follows §1–12 on the shared host by mistake. It states, as required:

- the host Caddy **owns 80 and 443**, which is why this stack ships no proxy (§13.1, §13.2);
- WalaaPlus `web` binds **`127.0.0.1:3100` only**, what loopback excludes, and that 3456, 5432 and
  18789 belong to OpenBot (§13.2);
- the OCI agent must **validate the complete `/etc/caddy/Caddyfile`**, never the fragment alone,
  because only the combined file answers whether the host still parses (§13.5 step 3);
- the agent must **reload only after explicit owner approval**, and must reload rather than
  restart, because a restart drops OpenBot's connections too (§13.5 steps 4–5);
- **DNS must point `staging.truebiznes.com` at `84.8.119.97`** and be verified from off the
  server *before* the block is inserted, since the ACME challenge is validated from the internet
  and issuance is rate limited per hostname (§13.3);
- **this is staging, not production**, it does not become production by promotion, and no
  production data may be loaded into it (§13 preamble).

It also adds a back-out (§13.5) and four post-deployment isolation checks (§13.6).

---

## 5. Tests

### 5.1 Added

`tests/unit/compose-exposure.test.ts` — **+12**, holding the co-hosted file:

- only four services exist, and none is a proxy **by name or by image**;
- exactly one published port, from `web`, and its literal text is `127.0.0.1:3100:3000`;
- no published host port is 80, 443, 3456, 5432 or 18789;
- `db`, `worker` and `migrate` publish nothing;
- `backend` is `internal: true` and carries `db`, `worker` and `migrate`;
- **no network or volume is `external`**, so the stack joins nothing that already exists on the host;
- the project name is `walaaplus-staging-cohost` and differs from the dedicated stack's;
- startup order is still db → migrate → web/worker.

The file's credential-reach block now runs over all three Compose files, so the co-hosted one is
also held to "no `env_file`", "migrator credential only in `migrate`", and "no `TEST_*` variables
in the application".

`tests/unit/deploy-config.test.ts` — **+11**, holding the fragment: one site and it is the staging
hostname; no global options block and none of the five global directives; no listener and no
`bind`; exactly one `reverse_proxy` and its upstream is `127.0.0.1:3100`; no neighbour port
mentioned anywhere; all four headers SET; all five stripped; no inbound placeholder; `/healthz`
answered locally; `health_uri /api/health`; and the full security-header set including the HSTS
scope limit.

### 5.2 Proven to bite

Static tests that never fail are decoration, so two were mutation-tested and both files were
restored byte-identical afterwards, verified by sha256:

| Mutation | Result |
|---|---|
| `- "127.0.0.1:3100:3000"` → `- "3100:3000"` | **1 failure**: "publishes exactly one port, from web, bound to loopback" |
| `reverse_proxy 127.0.0.1:3100` → `…:3456` | **2 failures**: the upstream assertion and "never points at a port that belongs to the neighbours" |

### 5.3 Caddy validation with a real Caddy

Run in a throwaway `caddy:2-alpine` container against copies in a scratch directory. `caddy
validate` loads the configuration without starting listeners and without requesting a
certificate.

```
=== fragment alone ===
Valid configuration
=== combined with a simulated host global block + existing site ===
Valid configuration
```

The second run is the one that matters: the fragment was concatenated **after** a simulated host
file containing a global options block and a neighbour site proxying to `127.0.0.1:3456`. That is
the shape the real insertion produces, and it parses.

### 5.4 Totals

| Suite | Files | Tests |
|---|---|---|
| unit | 12 | **188** (+23) |
| integration | 31 | **368** (unchanged) |
| browser | 1 | **3 passed (45.4 s)** |

```
GATE SUMMARY
PASS  dependency audit (prod, high+)             1204 ms
PASS  prisma generate                            1860 ms
PASS  lint                                      10203 ms
PASS  typecheck                                  3019 ms
PASS  prisma validate                            1750 ms
PASS  unit tests                                 1726 ms
PASS  test db up                                  988 ms
PASS  migrate deploy (test db, migrator role)    5964 ms
PASS  migrate status (test db)                   6040 ms
PASS  runtime role grants (test db)               220 ms
PASS  integration tests                        249703 ms
PASS  worker build                                162 ms
PASS  production build                          21815 ms
GATE PASSED in 304.7s (13/13 steps)
```

---

## 6. Deliberately not done

Every item here was in reach and was left alone on purpose.

| Not done | Why |
|---|---|
| **Any deployment** | Out of scope. This task prepares reviewed files |
| Contacting, logging into or reading the OCI host | Not authorized, and not needed to write configuration |
| Editing `/etc/caddy/Caddyfile` | It is the host's file. The fragment is separate, and a human inserts it after review |
| Reloading or restarting Caddy | Reload requires explicit owner approval (runbook §13.5) |
| Restarting Docker, or touching OpenClaw/OpenBot | Neighbours. Nothing here reads, stops or reconfigures them |
| Any DNS change | `staging.truebiznes.com` → `84.8.119.97` is the owner's record to create |
| Requesting a certificate | Requires DNS and a Caddy reload, neither of which happened |
| Changing `docker-compose.staging.yml` or `deploy/Caddyfile.staging` | Required to stay as-is. Verified byte-identical |
| Creating a second environment template | `.env.staging.example` already covers it; two would drift |
| Bringing the co-hosted stack up locally to test the loopback binding | Would have proven the published port end to end. It needs a full image build and a running stack, and static validation plus `docker compose config` already prove what the file declares. **The first real `up` is therefore still unexercised** — recorded as a limitation below |
| Production anything | Out of scope, and owner decision B4 is open |

---

## 7. Required confirmations

- **No OCI host was contacted.** No SSH, no API call, no credential used. Everything in this
  session ran on the local developer machine.
- **No Caddy was changed, reloaded or restarted.** `/etc/caddy/Caddyfile` was not read or
  written. The only Caddy executed anywhere was a throwaway local container running `validate`
  against copies in a scratch directory, which starts no listener and requests no certificate.
- **No DNS record was created, changed or queried against a live zone.**
- **No Docker service was restarted**, and no remote Docker daemon was contacted. The local
  daemon was used for `compose config` and the disposable validation container.
- **OpenClaw/OpenBot were not touched** in any way: not read, not stopped, not reconfigured. No
  file in this commit references their networks, volumes or database, and none of their ports is
  bound by it.
- **No remote environment of any kind was modified.**
- **No secret was committed or written to this file.** The only tracked environment files remain
  `.env.example` and `.env.staging.example`, both of which assign nothing, asserted by a test.
  The placeholder file used for `compose config` contains obvious non-values and lives outside
  the repository.
- **`master` is untouched** at `b9ee686`; nothing was pushed; no history was rewritten.
- **Phase 1a Prompt 3 was not started**, and no deployment was begun.

---

## 8. Known limitations

| # | Sev | Item | Follow-up |
|---|---|---|---|
| C-1 | Medium | **`TRUST_PROXY_HEADERS=true` trusts every local process here**, not only the proxy. On a dedicated box `web` publishes nothing, so the proxy is the only possible path; on loopback anything on the host can reach port 3100 and forge `X-Forwarded-For`, defeating the per-address rate limits. Acceptable on an owner-controlled staging machine as the price of having TLS at all | Not acceptable for production: put the app on its own host, or behind a proxy it does not share |
| C-2 | Low | The co-hosted stack has never been **run**, only validated. A first `up` on that host may still surface something host-specific | Owner/OCI agent, following runbook §13.4 |
| C-3 | Low | `staging.truebiznes.com` is now hardcoded in the fragment | Correct for a reviewed fragment naming one site. If the hostname changes, the fragment changes with it |
| C-4 | Low | Backups (§6) write to the same host they protect | Unchanged from before; owner decision C2 |
| C-5 | Low | The real-device checklist (§12) is still unperformed | Blocked until staging is live; unchanged by this work |

---

**PASS — CO-HOSTED OCI STAGING CONFIG READY FOR REVIEW**
