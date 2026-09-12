# Evidence — Co-hosted OCI Staging Configuration

**Date:** 2026-09-11
**Performed by:** development agent (Claude Opus 5)
**Branch:** `rebuild/phase-0-foundation`
**Scope:** repository files only. **No deployment, and no contact of any kind with the OCI host.**

---

## 1. Result

**PASS — the configuration is written, validated locally, and ready for review.** It has not been
deployed, and deploying it is not part of this task.

**Round 6 (§13): a real staging owner could not register at all.** The registration page was a
preserved prototype that never called its own, already-tested API. Fixed. See §13.

**Round 5 (§12): staging is LIVE and healthy, and the product had a hole in the middle of it.**
`https://staging.truebiznes.com` serves, but no owner-facing screen created a loyalty program, so
no enrolment link existed and real-device testing could not begin. Fixed. See §12.

**Round 4 (§11): the second deployment attempt got further and found the next defect, also
fixed.** Database healthy, migrations applied, runtime role created, `web` and `worker` started,
and then the deployment correctly stopped before Caddy because the `web` container was unhealthy:
the standalone server was not listening on its own loopback. See §11.

**Round 3 (§10): the first deployment attempt failed, and the defect it found is fixed.** It
applied its migrations successfully and then stopped inside the `migrate` container when role
setup could not resolve a module. `web` and `worker` never started and Caddy was never changed.
See §10.

**Round 2 (§9): both review findings remediated.** Forwarded IP headers are no longer trusted in
the co-hosted shape, and all four services now carry CPU and memory ceilings. The figures in the
table below are from the run after that remediation.

| Check | Result |
|---|---|
| `npm run gate` on `58b1b98` | **PASS 13/13 in 262.8 s** |
| unit tests | **195** (12 files), up 30 from before this work |
| integration tests | **368** (31 files), unchanged |
| Playwright | **3 passed (35.2 s)** |
| `npm audit`, full tree and production/high+ | **0 vulnerabilities** each |
| `docker compose … config --quiet`, **all four** Compose files | valid |
| `caddy validate` on the new fragment, alone and combined | **Valid configuration**, both |

**Nothing was deployed. Nothing remote was touched.** See §7.

---

## 2. Commits

On top of `9d3cb67`. `master` untouched at `b9ee686`; the branch still has no upstream and
nothing was pushed.

| # | SHA | Subject |
|---|---|---|
| 1 | `2e4e17d` | feat(ops): a co-hosted staging stack for a server that already owns 80 and 443 |
| 2 | `d30e4c2` | docs: the co-hosted configuration evidence |
| 3 | `4b635c2` | docs: fill in row 2 |
| 4 | `58b1b98` | fix(ops): stop trusting forwarded IP headers on the shared host, and cap what this stack can take |
| 5 | `d6c4964` | docs: the safety remediation |
| 6 | `7a95d26` | docs: fill in row 5 |
| 7 | `bed552f` | fix(docker): ship the module the migrate entrypoint imports |
| 8 | `8b9d577` | docs: the migrate-image remediation |
| 9 | `9d8d1c8` | docs: fill in row 8 |
| 10 | `354694a` | docs: correct the deployment record - migrations completed, role setup failed |
| 11 | `6f0c270` | docs(ops): correct the migrate failure message an operator will read |
| 12 | `887d18a` | fix(deploy): bind the standalone server on container loopback, and prove it in a real container |
| 13 | `05c89e3` | docs: the web container health remediation |
| 14 | `0c1db70` | docs: fill in row 13 |
| 15 | `7cf9e37` | feat(business): the owner can create the loyalty card, and get the link customers scan |
| 16 | `bc6745a` | docs: the owner bootstrap remediation |
| 17 | `6bdf2a5` | docs: fill in row 16 |
| 18 | `dbc5d80` | test(daily-limit): pin the hour in the two-timezone test, which was a coin flip |
| 19 | `6aa6aed` | fix(auth): connect the registration page to the registration API |
| 20 | `d7e9013` | docs: the registration remediation |
| 21 | (this commit) | docs: fill in row 20 |

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
| ~~C-1~~ | **CLOSED in round 2 (§9.1)** | ~~`TRUST_PROXY_HEADERS=true` trusts every local process here.~~ The setting is now `false` and a test prevents its return. The residual is that per-IP rate limiting is unavailable in this shape, which is a documented consequence rather than a defect | Recoverable by moving to a dedicated server (`docker-compose.staging.yml`) |
| ~~C-2~~ | **CLOSED (§12.1)** | ~~The co-hosted stack has never been run.~~ Three attempts: the first failed inside `migrate` (§10), the second failed its web healthcheck (§11), and the third **succeeded — staging is live and healthy at the staging hostname** | — |
| C-3 | Low | `staging.truebiznes.com` is now hardcoded in the fragment | Correct for a reviewed fragment naming one site. If the hostname changes, the fragment changes with it |
| C-4 | Low | Backups (§6) write to the same host they protect | Unchanged from before; owner decision C2 |
| C-5 | Low | The real-device checklist is still unperformed. **It is now possible**: staging is live and an owner can create a card and get a link to point a phone at (§12)** | Owner, runbook §13 checklist |

---

---

## 9. Round 2 — safety remediation

Two findings, both accepted, both fixed in `58b1b98`. Nothing from §1–8 was erased; the figures in
§1 were re-taken after this work.

### 9.1 Forwarded IP headers are no longer trusted here

This was recorded as limitation **C-1** in §8 of the original evidence, at medium severity. The
reviewer is right that recording it was not enough.

`docker-compose.staging-cohost.yml` now sets **`TRUST_PROXY_HEADERS: "false"`**.

The reasoning, stated as the reviewer put it: `127.0.0.1:3100` is reachable by **every local
process on the host**, not only by Caddy. Any of them could send a request carrying a different
`X-Forwarded-For` each time. A per-address limit built on an address the caller chooses is not a
weak limit, it is a **misleading** one — it appears on the dashboard and stops nothing.

The Caddy fragment is unchanged and still replaces the headers correctly. The application simply
declines to believe them in this shape.

**The trade-off, honestly.** The rate limiter was already written to degrade rather than pretend:
`consumeRegisterLimit`, `consumeSignInLimit` and `consumeEnrollmentLimit` each add the per-address
window **only when an address is supplied**, so with none supplied those windows do not open at
all. Nothing silently falls back to something weaker.

| Control | Co-hosted staging |
|---|---|
| Per-IP window, registration | **unavailable** |
| Per-IP window, sign-in | **unavailable** |
| Per-IP window, public enrolment | **unavailable** |
| Per-submitted-email window, registration | active |
| Per-identifier window, sign-in | active — the one that actually stops credential stuffing against one account |
| **Per-enrolment-link window, database-backed** | **active** — and the right shape for the real threat: farming a welcome bonus means hammering one merchant's link |
| Enrolment honeypot, idempotency, tenant isolation, append-only ledger | unaffected |

**Why this is the safer option rather than a reluctant compromise.** Trusting the header would not
have protected against a local process in the first place — it would have handed that process an
unlimited supply of distinct identities. The choice was never "per-IP limits or none"; it was
"honest absence, or a limit that can be walked through at will".

**A dedicated server restores the trusted-proxy behaviour** with no code change, by using
`docker-compose.staging.yml`, where `web` publishes nothing and the proxy really is the only path
in. That file still sets `TRUST_PROXY_HEADERS=true` and is untouched.

Documented in runbook **§13.1** (comparison table) and **§13.2** ("Why forwarded IP headers are not
trusted here"), and in the Compose file itself at the setting.

### 9.2 Conservative resource limits

The host has one vCPU and shares it with OpenClaw/OpenBot. All four services now carry ceilings:

| Service | `cpus` | `mem_limit` | `mem_reservation` | When | Why this number |
|---|---|---|---|---|---|
| `db` | 0.25 | 384m | 128m | always | Roughly triple PostgreSQL's expected resident size here (128 MB shared buffers plus a handful of Prisma connections). Deliberately loose: an OOM-killed database is a corrupted staging run, not a tidy failure |
| `web` | 0.35 | 512m | 160m | always | The standalone Next.js server sits well under 200 MB; this leaves room for a restart, a burst of requests and the V8 heap without making this stack the reason the host swaps |
| `worker` | 0.15 | 256m | 64m | always | A pg-boss loop that wakes, polls and sleeps, with no user waiting on it. The right service to squeeze first |
| `migrate` | 0.50 | 512m | 128m | startup only | The most generous, and free in steady state because it exits before `web` and `worker` start |

**Budget**, from the resolved `docker compose config`:

```
db       cpus=0.25 mem_limit=402653184 mem_reservation=134217728
migrate  cpus=0.5  mem_limit=536870912 mem_reservation=134217728
web      cpus=0.35 mem_limit=536870912 mem_reservation=167772160
worker   cpus=0.15 mem_limit=268435456 mem_reservation=67108864
steady-state ceiling: cpus=0.75 mem=1152 MiB
```

Steady state is capped at **0.75 vCPU and 1152 MiB**, leaving at least a quarter of the single core
to the host and its other services. The startup ceiling is the same number, because `migrate` runs
while `web` and `worker` do not: `db` 0.25 + `migrate` 0.50 = 0.75.

**`migrate` can still complete**, which was an explicit requirement. `web` and `worker` wait on it
with `condition: service_completed_successfully`, so an OOM kill there does not fail a request — it
halts the entire startup. It therefore gets the largest allowance in the file, and a test enforces
that its memory ceiling is **never lower than `web`'s** and its CPU share never smaller.

**`mem_reservation` sits well below each limit on purpose.** A reservation is a floor the kernel
tries to protect; setting it near the limit would make this stack the *last* thing reclaimed under
pressure, which is backwards on someone else's host.

**Plain Compose keys, not Swarm.** `cpus`, `mem_limit` and `mem_reservation` are enforced by
`docker compose up` directly. `deploy.resources` is the Swarm spelling and is silently ignored by
parts of the non-Swarm toolchain; a limit that is quietly ignored on a one-vCPU box is the worst of
both worlds. A test asserts the file contains neither `deploy:` nor `resources:`.

**Assumption recorded in the runbook:** the host has at least 2 GiB of RAM. §13.2 tells the operator
to check with `free -m` and `nproc` before the first start and to scale down if it has less.

### 9.3 The required runbook step

New **§13.7, "First startup: watch what it does to the host — required, not optional"**. After the
first `up`, and again after the Caddy block goes live, the OCI agent watches for at least five
minutes with `docker stats` (live and as a pasteable `--no-stream` snapshot), `vmstat 1 10`,
`free -m` and `uptime`, then checks that OpenClaw/OpenBot are still healthy.

It states four **stop conditions**, each with the action:

| Signal | Action |
|---|---|
| OpenClaw/OpenBot unhealthy, unresponsive or erroring | `down` the stack and report before anything else |
| Sustained swap in/out in `vmstat`, or available memory near zero | Same. Heavy swapping on one vCPU degrades every service on the host |
| Load average sustained above ~2.0 on the single core | Same |
| A WalaaPlus container restarting repeatedly, or `docker inspect` reporting `OOMKilled` | Stop, raise that service's `mem_limit`, report which service and what it was doing |

It also notes that stopping is cheap and reversible — `down` keeps the volume, the images and the
certificate — and that the `docker stats --no-stream` snapshot must go in the deployment report,
because "it seemed fine" is not a result.

### 9.4 Tests added, and proven to bite

Seven new assertions in `tests/unit/compose-exposure.test.ts` (unit total **188 → 195**):

- `TRUST_PROXY_HEADERS` is exactly `"false"` in the co-hosted file, and never `"true"`;
- the dedicated file still has `"true"` **and still publishes no application port**, so the two
  differ for a reason that is itself asserted rather than remembered;
- all four services declare both `cpus` and `mem_limit`;
- the steady-state budget stays at or under 0.8 vCPU and 1536 MiB, and the startup ceiling too;
- `migrate` is never squeezed tighter than `web`, in memory or CPU;
- every reservation is below half its limit;
- the file uses neither `deploy:` nor `resources:`.

Mutation-tested, with both files restored byte-identical afterwards (sha256 verified):

| Mutation | Result |
|---|---|
| `TRUST_PROXY_HEADERS: "false"` → `"true"` | **1 failure**: "does not believe forwarded IP headers on a shared host" |
| Deleted `worker`'s three limit keys | **2 failures**: "gives every service an explicit CPU and memory ceiling" and "reserves far less than it limits" |

### 9.5 Verification after remediation

```
GATE SUMMARY
PASS  dependency audit (prod, high+)             2101 ms
PASS  prisma generate                            2416 ms
PASS  lint                                       7565 ms
PASS  typecheck                                  3690 ms
PASS  prisma validate                            2097 ms
PASS  unit tests                                 1981 ms
PASS  test db up                                 1023 ms
PASS  migrate deploy (test db, migrator role)    6135 ms
PASS  migrate status (test db)                   5840 ms
PASS  runtime role grants (test db)               185 ms
PASS  integration tests                        214388 ms
PASS  worker build                                181 ms
PASS  production build                          15192 ms
GATE PASSED in 262.8s (13/13 steps)
```

| Check | Result |
|---|---|
| `npm run test:e2e` | **3 passed (35.2 s)** |
| `npm audit --omit=dev --audit-level=high` | **0 vulnerabilities** |
| `npm audit` (full tree) | **0 vulnerabilities** |
| `docker compose config --quiet` — local, local with `--profile app`, dedicated staging, co-hosted | **all four valid** |
| unit / integration | **195** / **368** |

### 9.6 What this round did not change

`docker-compose.staging.yml` and `deploy/Caddyfile.staging` remain byte-identical. The Caddy
fragment `deploy/Caddyfile.walaaplus-staging.caddy` is unchanged: its header replacement was
already correct and stays exactly as reviewed. No application code was touched — the rate limiter
already handled an absent client address correctly, so the fix was a configuration decision, not a
code change.

Still true, and re-confirmed: **no OCI host was contacted, no Caddy was read, written, reloaded or
restarted, no DNS record was touched, no Docker service was restarted, no OpenClaw/OpenBot service
was touched, no remote environment was modified, nothing was deployed, and nothing was pushed.**
`master` is untouched at `b9ee686`.

### 9.7 Limitation C-1, closed

§8's limitation **C-1** (`TRUST_PROXY_HEADERS=true` trusts every local process) is **closed by
this remediation**: the setting is now false and a test prevents its return. The residual, which is
not a defect, is that per-IP rate limiting is unavailable in this shape — recorded above, in the
runbook, and in the Compose file, and recoverable by moving to a dedicated server.

---

---

## 10. Round 3 — the first real deployment attempt, and the image defect it found

This section records a **failed deployment**. Nothing in it claims staging is running.

### 10.1 What happened

The owner attempted the first real co-hosted staging deployment from commit
`7a95d2643fcc0eff9ad77035178ba7611bcb336a`. It reached the `migrate` container, and that container
runs two commands in sequence:

```dockerfile
CMD ["sh", "-c", "node scripts/db-migrate.mjs deploy && node scripts/db-roles.mjs"]
```

**The first command completed successfully. The second failed at module resolution:**

| Step | Outcome |
|---|---|
| `node scripts/db-migrate.mjs deploy` — `prisma migrate deploy` as the migrator role | **completed successfully.** The schema was applied to the staging database |
| `node scripts/db-roles.mjs` — create/refresh the restricted runtime role and its grants | **failed**, before doing any work |

```
Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/app/scripts/lib/db-role-membership.mjs'
imported from /app/scripts/db-roles.mjs
```

Because the two are chained with `&&`, the failure is in the **second** command only. Module
resolution happens before that script's top-level code, so `db-roles.mjs` itself did nothing: the
runtime role was not created and no grants were applied.

`migrate` therefore exited non-zero. **`web` and `worker` never started**, because both wait on it
with `condition: service_completed_successfully`. That is the depends_on condition doing exactly
its job: an application that started here would have run against a schema with no runtime role.

**Caddy was never changed.** The host's `/etc/caddy/Caddyfile` was not edited, no site block was
inserted, no reload was issued and no certificate was requested. The runbook's order — stack up and
answering on loopback *before* touching the proxy (§13.4, §13.5) — is what kept the failure
contained to a container that had not yet been put in front of anything.

**The WalaaPlus containers were removed without deleting volumes.** `down` was used, not
`down -v`, so the `walaaplus-staging-cohost_db-data` volume still exists on the host, with the
migrated schema in it.

**Nothing is claimed beyond that.** Staging is not deployed. No real-device check was performed.
No part of §8's manual checklist moved.

### 10.2 The defect

`scripts/db-roles.mjs` imports `./lib/db-role-membership.mjs`. The Dockerfile's `migrate` target
copied two files:

```dockerfile
COPY --chown=app:app scripts/db-migrate.mjs scripts/db-roles.mjs ./scripts/
```

The helper was in the repository the whole time, and every check in this project ran against the
**source tree**, where it exists. The image was missing it. That is the shape of the defect worth
naming: a source tree cannot answer whether an image is complete, and no amount of source-tree
testing would ever have caught this.

It landed in the worst container to land in, and in the worse of that container's two
commands. `web` and `worker` wait on `migrate` with `condition: service_completed_successfully`,
so a broken migrate image is not a degraded service, it is a deployment that cannot start at all —
and here it stopped *after* the schema had been applied but *before* the runtime role existed, the
one state in which the application must not be allowed to start.

**Reproduced locally before anything was changed**, with no network:

```
$ docker build --target migrate -t walaaplus-migrate:before-fix .
$ docker run --rm --network none walaaplus-migrate:before-fix sh -c 'ls -la /app/scripts/lib'
ls: /app/scripts/lib: No such file or directory

$ docker run --rm --network none walaaplus-migrate:before-fix node scripts/db-roles.mjs
Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/app/scripts/lib/db-role-membership.mjs'
imported from /app/scripts/db-roles.mjs
```

Byte for byte the deployment's error.

### 10.3 The fix — `bed552f`

```dockerfile
COPY --chown=app:app scripts/lib ./scripts/lib
```

The directory, not that one file, so a helper added later arrives with it.

**No product behaviour changed.** No schema, no ledger logic, no Compose networking, no Caddy
configuration, no secret, no application code. The commit touches `Dockerfile`, `scripts/gate.mjs`,
and two new test files.

### 10.4 The regression guard runs inside the image

`scripts/check-migrate-image.mjs` is a new **gate step**, because the only thing that can answer
"is this image complete" is the image. It:

1. builds `--target migrate`;
2. requires `/app/scripts/lib/db-role-membership.mjs` to be present in the image;
3. imports it inside the image and requires `decideMembershipAction` to be a function — presence
   on disk is not the same as being resolvable by Node;
4. runs `scripts/db-roles.mjs` inside the image **with no environment and `--network none`**, and
   requires the failure to be the missing-variable message rather than `ERR_MODULE_NOT_FOUND`.
   Module resolution happens before any top-level code, so this proves the entire module graph
   links.

No database is contacted at any point, and the script under test prints variable **names** only.

`tests/unit/dockerfile-migrate-deps.test.ts` is the cheap complement: it reads the entrypoints'
**real import graph** and checks a `COPY` line covers each relative specifier, catching the
mistake in milliseconds at edit time. It also asserts the gate still calls the image check, so the
fast guard can never quietly replace the real one. It is explicitly not the proof, and says so.

**Both were mutation-tested**, with the Dockerfile restored byte-identical afterwards (sha256
verified):

| Mutation | Result |
|---|---|
| Remove the `scripts/lib` COPY, then run the image check | **FAIL**, reporting the missing module and the deployment's own error |
| Remove it, then run the static test | **FAIL**: "copies every local module the entrypoints import" |

### 10.5 Verification, on `bed552f`

```
GATE SUMMARY
PASS  dependency audit (prod, high+)             1501 ms
PASS  prisma generate                           11670 ms
PASS  lint                                      37369 ms
PASS  typecheck                                  4391 ms
PASS  prisma validate                            1621 ms
PASS  unit tests                                 3101 ms
PASS  test db up                                 1058 ms
PASS  migrate deploy (test db, migrator role)    6357 ms
PASS  migrate status (test db)                   5693 ms
PASS  runtime role grants (test db)               626 ms
PASS  integration tests                        197684 ms
PASS  worker build                                196 ms
PASS  production build                          26280 ms
PASS  migrate image dependencies                 2829 ms
GATE PASSED in 300.4s (14/14 steps)
```

| Check | Result |
|---|---|
| unit / integration | **199** (13 files) / **368** (31 files) |
| `npm run test:e2e` | **3 passed (34.8 s)** |
| `npm audit --omit=dev --audit-level=high` | **0 vulnerabilities** |
| `npm audit` (full tree) | **0 vulnerabilities** |
| `docker compose config --quiet` — co-hosted, dedicated, local | **all valid**, with non-secret placeholder variables |
| `docker build --no-cache --target migrate` | **succeeded** |

Smoke check inside the clean, no-cache image:

```
/app/scripts/lib:
-rwxr-xr-x  1 app  app  1753  db-role-membership.mjs

$ node scripts/db-roles.mjs            # --network none, no env file
db-roles: MIGRATE_DATABASE_URL is not set. See .env.example.

$ node --input-type=module -e 'import("/app/scripts/lib/db-role-membership.mjs")…'
decideMembershipAction is a function
```

The entrypoint now reaches its own environment validation instead of dying at link time. That
message is the correct outcome for a container started with no configuration, and it names a
variable without printing any value.

### 10.6 The existing staging volume

**It can be reused, and it must not be deleted.**

**`prisma migrate deploy` completed before the failure, so the volume holds a migrated schema.**
It is not an empty database. What it does *not* hold is the restricted runtime role and its
grants: `db-roles.mjs` failed at module resolution, before it ran any statement of its own.

Expected state of `walaaplus-staging-cohost_db-data`:

| | State |
|---|---|
| WalaaPlus schema and `_prisma_migrations` | **applied**, by the migrator role |
| Runtime role `walaaplus_app` and its grants | **not created** |
| Application data | none. `web` and `worker` never started, so nothing wrote a business, a card or a ledger row |

**Both startup steps are idempotent, which is why this state is safe to resume from.**
`prisma migrate deploy` applies only what is missing and will report the schema is up to date;
`scripts/db-roles.mjs` creates the role if absent and re-applies its grants either way. Running
them again against this volume is the normal path, not a recovery procedure.

**Do not delete the volume.** There is nothing to gain: the schema in it is exactly what the next
run would produce, and deleting it destroys a database to re-create an identical one.

Before resuming, the runbook's §13.4 check still applies: bring the stack up, confirm `migrate`
exits 0 — this time reaching and completing `db-roles.mjs`, which prints `db-roles: OK role` —
and that `curl http://127.0.0.1:3100/api/health` answers, and only then consider the Caddy block.

### 10.7 Correction to this section

An earlier version of §10.1 and §10.6, committed in `8b9d577`, stated that the failure happened
"before `prisma migrate deploy` ran" and that "nothing reached PostgreSQL", and described the
volume as possibly empty.

**That was wrong, and it was wrong by reasoning rather than by evidence.** The inference was that
module resolution precedes execution — true of `db-roles.mjs` on its own, but the container runs
`node scripts/db-migrate.mjs deploy && node scripts/db-roles.mjs`, so the resolution failure in the
second command says nothing about the first. The deployment record shows the migration completed.
The corrected facts are above: migrations applied, role setup failed, `web` and `worker` never
started, containers removed without `-v`, Caddy untouched.

Two lessons worth keeping. A chained `&&` command has two failure points and the error names only
one of them. And an operator's deployment record outranks an inference drawn from source code.

This correction is documentation only. No code, Dockerfile, Compose file, Caddy configuration,
schema or secret was changed by it, and the remediation in `bed552f` is unaffected — it fixes the
image regardless of which of the two commands hit the missing module.

**One instance of the same error is knowingly left in place, out of scope.** The failure message in
`scripts/check-migrate-image.mjs` says the container "will die with ERR_MODULE_NOT_FOUND before it
applies a single migration". By the same reasoning corrected above, migrations would already have
been applied by the first command in the chain. It is a wrong sentence in an error message an
operator would read during a future failure, and it should be corrected — but this task is scoped
to documentation, so the script was not touched. Recorded here so it is not lost.

### 10.8 What this round did not do

- **It did not deploy anything.** No OCI host was contacted from this session.
- **No Caddy file was read, written, reloaded or restarted**; no DNS record was touched; no
  certificate was requested.
- **No real-device check was performed.** §8's checklist is unchanged and entirely unperformed.
- **No claim is made that staging works.** One container was fixed and proven to start; the
  deployment has not been re-attempted.
- `master` is untouched at `b9ee686`.

---

---

## 11. Round 4 — the second deployment attempt, and the web healthcheck defect it found

This section records a **second failed deployment**. It got considerably further than the first.
Nothing in it claims staging is running.

### 11.1 What happened, step by step

| Step | Outcome |
|---|---|
| `db` starts and reports healthy | **passed** |
| `prisma migrate deploy` as the migrator role | **completed.** Migrations applied |
| `scripts/db-roles.mjs` — restricted runtime role and grants | **completed.** The runtime role was created. This is the step that failed in round 3; the fix in `bed552f` worked |
| `migrate` exits 0 | **passed** |
| `web` and `worker` start | **both started** |
| Worker health, from inside its container | **OK** |
| Host request to `http://127.0.0.1:3100/api/health` | **`{"status":"ok"}`** |
| `web` container healthcheck | **FAILED**: `wget: can't connect to remote host (127.0.0.1): Connection refused` |
| Deployment halted before touching Caddy | **correct** |

**The WalaaPlus containers were removed without deleting volumes.** `down` was used, not
`down -v`. The `walaaplus-staging-cohost_db-data` volume still exists, now holding a migrated
schema **and** the runtime role.

**Caddy was untouched.** No site block inserted, no reload, no certificate requested.

**Nothing is claimed beyond that.** Staging is not deployed. No real-device check was performed.

### 11.2 The defect

Two observations that look contradictory were both correct:

```
from the host      GET http://127.0.0.1:3100/api/health   ->  {"status":"ok"}
inside the container  wget http://127.0.0.1:3000/...      ->  Connection refused
```

The Next standalone server begins with:

```js
const hostname = process.env.HOSTNAME || "0.0.0.0"
```

**Docker sets `HOSTNAME` to the container ID** unless it is overridden. So the server did not fall
back to `0.0.0.0`; it bound the container's **bridge address alone**. A published port forwards to
that bridge address, which is why the host got a healthy answer. Nothing was listening on the
container's own loopback, which is why its healthcheck was refused.

**The healthcheck was right and the binding was wrong.** That is worth stating plainly, because
the tempting fix — point the healthcheck somewhere else — would have hidden a real problem: a
process that is not on loopback is also not reachable by anything else that expects the
conventional binding.

This is a property of a **running container in Docker's default environment**. The application
code is correct, the Compose file was valid, the image built and started. No source-tree check
could have seen it.

### 11.3 The fix — `887d18a`

Every Compose file that runs this image now sets, on the `web` service:

```yaml
HOSTNAME: "0.0.0.0"
```

That restores the server's own documented default: listen on every interface **inside the
container**, loopback included.

**It publishes nothing new.** What a process listens on inside its container is not what Docker
exposes to the host; the `ports` and `expose` lines are untouched. A test asserts that too,
because it is the obvious misreading of this change.

**Every security constraint is preserved**, verified from the resolved configuration:

```
docker-compose.yml                   HOSTNAME=0.0.0.0 | ports=[]                        | TRUST=true
docker-compose.staging.yml           HOSTNAME=0.0.0.0 | ports=[]                        | TRUST=true
docker-compose.staging-cohost.yml    HOSTNAME=0.0.0.0 | ports=["127.0.0.1:3100->3000"]  | TRUST=false
```

Loopback-only publishing for co-hosted staging, no database host port, no proxy container,
`TRUST_PROXY_HEADERS=false` in the co-hosted shape, the resource limits, and no external networks
or volumes: all unchanged.

The local file has no loopback healthcheck today — the proxy reaches `web:3000` by service name,
which works on the bridge address — so its override is preventive, so that adding one later does
not rediscover this.

### 11.4 The regression test runs a real container

`scripts/check-web-image.mjs`, a new gate step. It builds `--target web` and runs **two real
containers**:

| | Binding observed | Loopback probe |
|---|---|---|
| Docker's default `HOSTNAME` | `172.17.0.2:3000` | **ECONNREFUSED** — the incident, reproduced |
| `HOSTNAME=0.0.0.0` | `0.0.0.0:3000` | **HTTP 503** |

It reads the bound address from `netstat` inside the container, because "is it listening" is not
the question here — "listening on what" is.

HTTP 503 is the correct and expected answer: the containers get an obviously-placeholder database
URL pointing at nothing, and `/api/health` runs `SELECT 1`. Any status proves what matters, that
something on loopback is speaking HTTP, which is exactly what the healthcheck needs and exactly
what was missing.

It then requires every Compose file to carry the override, and **fails if one loses it**.

The reproduction step is **reported, not asserted**. If a future Next release binds `0.0.0.0`
regardless of `HOSTNAME`, that step stops reproducing and the override becomes harmless rather
than required; failing a gate because upstream fixed a bug would be absurd. The load-bearing
assertions are the positive probe and the configuration check.

A fast static guard in `tests/unit/compose-exposure.test.ts` complements it and **cannot replace
it** — a YAML file cannot tell you what a server binds. It also rejects an *interpolated*
`HOSTNAME`, which is how this would silently come back.

**Mutation-tested**, with every file restored byte-identical afterwards (sha256 verified):

| Mutation | Result |
|---|---|
| Remove the override from the co-hosted file, run the container check | **FAIL**, naming the file and explaining the consequence |
| Remove it, run the static guard | **FAIL** on two assertions |
| Change it to `"${WEB_BIND:-0.0.0.0}"` | **FAIL** on two assertions |

### 11.5 Verification, on `887d18a`

```
GATE SUMMARY
PASS  dependency audit (prod, high+)             1141 ms
PASS  prisma generate                            1991 ms
PASS  lint                                       6485 ms
PASS  typecheck                                  2979 ms
PASS  prisma validate                            1574 ms
PASS  unit tests                                 1788 ms
PASS  test db up                                 1143 ms
PASS  migrate deploy (test db, migrator role)    5756 ms
PASS  migrate status (test db)                   5615 ms
PASS  runtime role grants (test db)               179 ms
PASS  integration tests                        195234 ms
PASS  worker build                                138 ms
PASS  production build                          16133 ms
PASS  migrate image dependencies                 2847 ms
PASS  web image container health                26278 ms
GATE PASSED in 269.3s (15/15 steps)
```

| Check | Result |
|---|---|
| unit / integration | **209** (13 files) / **368** (31 files) |
| `npm run test:e2e` | **3 passed (34.0 s)** |
| `npm audit --omit=dev --audit-level=high` | **0 vulnerabilities** |
| `npm audit` (full tree) | **0 vulnerabilities** |
| `docker compose config --quiet` — all three, non-secret placeholders | **all valid** |
| `node scripts/check-web-image.mjs` standalone | **OK** |
| `git diff --check` | clean |

### 11.6 The staging volume, again

Unchanged advice, with one addition: the volume now holds a migrated schema **and** the runtime
role, because round 4 got past the step that failed in round 3. It still holds no application
data — `web` never became healthy, so nothing wrote a business, a card or a ledger row.

**Do not delete it.** Both startup steps remain idempotent: `prisma migrate deploy` will report
the schema is up to date, and `db-roles.mjs` will re-apply the grants it already applied.

### 11.7 What this round did not do

- **It did not deploy anything.** No OCI host was contacted from this session.
- **No Caddy file was read, written, reloaded or restarted**; no DNS record touched; no
  certificate requested.
- **No real-device check was performed.** §8's checklist remains entirely unperformed.
- **No application behaviour was changed.** The fix is deployment configuration: three Compose
  files, one new check script, one gate step, and static guards. No application code, no
  Dockerfile, no schema, no Caddy configuration, no secret.
- **No claim is made that staging works.** Two containers were proven to behave correctly; the
  deployment has not been re-attempted.
- `master` is untouched at `b9ee686`.

---

---

## 12. Round 5 — staging is live, and the owner bootstrap that was missing

### 12.1 Staging status

**The deployment succeeded.** `https://staging.truebiznes.com` is live and healthy: the database
came up, migrations applied, the restricted runtime role was created, `web` and `worker` started
and both report healthy, and the host Caddy serves the site over HTTPS. The fixes from §10 and §11
both held.

**Real-device testing still could not begin**, for a reason that had nothing to do with the
deployment.

### 12.2 The gap

A real owner could sign up and get a business, a Main location and an OWNER membership. The stamp
engine could award, redeem and reverse. `createStampProgram()` already created the template, the
immutable version, the reward tier and the direct enrolment source atomically, with a row lock and
a one-program rule.

**Nothing called it.** No owner-facing route or page invoked that service, so:

- no merchant could create a loyalty card;
- therefore no enrolment link or QR existed;
- therefore no customer could join;
- therefore the manual checklist in §8 — install the PWA, scan a card with a camera — had nothing
  to point a phone at.

Every service was in place and unreachable from a browser. The only ways to start a pilot were to
seed the database by hand or to expose an admin endpoint, and both were explicitly ruled out: the
first is not a product, and the second is a permanent hole opened to solve a temporary problem.

### 12.3 What was built — `7cf9e37`

`/{locale}/business/program`, owner-facing, with two states:

| State | Screen |
|---|---|
| No card yet | A five-field form: card name, stamps per reward, reward name, optional reward description, optional welcome stamps |
| A card exists | Its enrolment link, a QR, a copy action, and the next step — add a cashier, or open the scanner |

The second state is not politeness. Phase 1a is one active program per business, enforced by the
service with a row lock and a 409, and a screen that keeps offering a button the server will
refuse teaches its user to distrust it.

**No domain logic was added or duplicated.** `POST /api/staff/program` validates five fields, fills
in the settings this phase does not offer, and calls `createStampProgram()`. The schema is
**strict**, so a body carrying `earnMode`, `spendAmountPerBlockMinor`, `dailyAwardLimit`,
`requirePurchaseAmount`, `rewardValueMinor`, `contractVersion` or `locationId` is refused rather
than quietly honoured — each is a test case.

**Phase 1a constraints preserved**, verified by grep and by test: one active program per business;
Main location only, resolved server-side, with no screen, URL or body able to name a location; and
no points, cashback, discount, multi-card, multi-location, template editing, version editing,
automation or GHL surface anywhere in the flow. No Prisma call exists outside `src/server`.

### 12.4 The enrolment token is treated as a capability

It is enough to enrol customers into a business, so:

- the read is tenant-scoped and requires `VIEW_TEMPLATES`, which a **CASHIER does not hold**.
  A cashier who opens the page is told they cannot see it, not shown an empty form;
- creation requires `EDIT_TEMPLATES` through the service, checked again beneath the route;
- a **cross-tenant** caller naming someone else's business gets 403, and the response body contains
  neither that business's token nor its name — asserted, not assumed;
- **the token never reaches the audit log.** A test creates a program and asserts the token appears
  in no audit row for that business. Audit rows are read by more people, and kept longer, than the
  screen that legitimately shows it;
- the **QR is rendered server-side as inline SVG**. A QR fetched from an image service would hand
  the token to that service on every render. A test asserts the only URL in the markup is the SVG
  namespace.

### 12.5 Two details worth naming

**The link carries no locale prefix.** `https://…/join/<token>` is negotiated to the visitor's
language, falling back to Arabic. A printed QR outlives the decision about which language the
person holding it reads. The origin comes from configuration, not from a request header: `Host`
and `X-Forwarded-Host` are attacker-influenced, and this value gets printed onto a table card a
merchant then trusts.

**A second submission returns the existing program**, with `created: false`, rather than an error.
A double tap on a slow connection should still land the owner on their link. Two racing requests
are tested to produce exactly one program.

### 12.6 A defect the browser test found

The form called `router.refresh()` after a successful create. The refreshed server render replaced
the component with the page's own "a program exists" branch, which has nothing to confirm — so the
owner's "your card is ready" message appeared and **vanished**.

It passed when run alone and failed in the full suite, because the race is only visible when the
machine is busy. The response already carries everything the screen needs, including the QR, so
the refresh is gone. The e2e still reloads the page afterwards to prove the link persists.

### 12.7 Tests

**Twelve integration tests** in `tests/integration/owner-program-route.test.ts`:

| Requirement | Covered by |
|---|---|
| Owner creates exactly one program and receives its link | one template, one ACTIVE version, one tier, one source; the URL carries the source's token and neither the business id nor the template id |
| Repeated submission creates no second program | a second call returns 200, `created: false`, the ORIGINAL name and link; template count stays 1 |
| Double submission, raced | two concurrent calls: statuses `[200, 201]`, one template, identical links |
| Existing owner sees the original link | through `getStampProgramOverview`, the same service the page uses, and the route agrees with it |
| Cashier refused | 403 on create, and the tenant-scoped read rejects them too |
| Cross-tenant refused | 403; the body leaks neither token nor business name; neither business is modified |
| Public enrolment works from the displayed link | the token from the URL enrols a customer through the real public route; the card lands in the right business with the chosen welcome bonus |
| QR resolves to the same URL | the returned SVG equals `qrSvg(enrollmentUrl)` exactly, and differs for a URL one character apart |

Plus: unauthenticated refused; the strict-schema cases; the welcome-bonus rule from the mechanics
contract; zero welcome stamps meaning none; and the audit-log check.

**Playwright** — `tests/e2e/owner-bootstrap.spec.ts`, the complete owner-to-customer journey: an
account exactly as registration leaves it, sign in, land on an empty card screen, fill five fields,
see the confirmation, the QR and the link, reload and get the same link rather than a second form,
then open that exact URL in a **second browser context** as a customer and join — arriving on a
card with the welcome stamp the owner chose.

### 12.8 Verification, on `7cf9e37`

```
GATE SUMMARY
PASS  dependency audit (prod, high+)             1846 ms
PASS  prisma generate                            1620 ms
PASS  lint                                       5745 ms
PASS  typecheck                                  5059 ms
PASS  prisma validate                            1475 ms
PASS  unit tests                                 1547 ms
PASS  test db up                                  948 ms
PASS  migrate deploy (test db, migrator role)    5916 ms
PASS  migrate status (test db)                   5619 ms
PASS  runtime role grants (test db)               153 ms
PASS  integration tests                        203685 ms
PASS  worker build                                136 ms
PASS  production build                          14183 ms
PASS  migrate image dependencies                 2715 ms
PASS  web image container health                24595 ms
GATE PASSED in 275.2s (15/15 steps)
```

| Check | Result |
|---|---|
| unit / integration | **209** / **380** (589 total, 45 files) |
| `npm run test:e2e` | **4 passed**, run twice for stability |
| `npm audit --omit=dev --audit-level=high` | **0 vulnerabilities** |
| `npm audit` (full tree) | **0 vulnerabilities** |
| `git diff --check` | clean |
| Prisma writes outside `src/server` | **none** |
| `locationId` anywhere under `src/app` | **none** |

**No migration was added.** The schema is unchanged: this flow uses tables that already existed.

### 12.9 What this round did not do

- **No staging deployment.** The fix is committed and pushed; updating staging is the owner's step.
- **No real-device check was performed.** §8's checklist remains unperformed — but it is now
  *possible*, which it was not before, because an owner can obtain a link and a QR to point a
  phone at.
- **No database was seeded and no admin endpoint was exposed**, as required.
- **No application behaviour outside this flow changed.** The stamp engine, the ledger, the
  scanner, the enrolment route and the Compose files are untouched.
- `master` is untouched at `b9ee686`.

---

---

## 13. Round 6 — the registration page was never connected to its API

### 13.1 What a real staging owner hit

A real owner test on live staging found that `/en/auth/register` **did not register anyone**.

The page was preserved prototype markup from the original mock-up:

- its inputs were uncontrolled and had no submission behaviour;
- "Create Account" was a **`Link` to `/business`**, not a submit control;
- it never called `POST /api/auth/register`;
- so no `User` and no `Business` were created;
- and the credentials sign-in that followed correctly returned **401**.

**The registration service and its route were correct and tested the whole time.** They had unit
and integration coverage, the API's non-enumerating 202 contract was already implemented, and
none of it was reachable from the page that was supposed to call it.

This is the same shape of defect as §12, one step earlier in the journey, and it invalidated the
owner-to-program real-world journey even though every server-side test passed. **A form that
navigates on submit is worse than no form at all, because it reports success.**

### 13.2 What was changed — `6aa6aed`

The page is now a real client registration flow:

| Requirement | How |
|---|---|
| Submits the fields as JSON to `POST /api/auth/register` | first name, optional last name, business name, email, password, `locale`, and the Syria-first defaults `currency=SYP` and `timezone=Asia/Damascus`, sent explicitly so the values a business is created with are visible at the call site |
| The prototype "Agency" option | **Removed**, not disabled. Phase 1a onboards local businesses, and a greyed-out control is still a promise. The page says so in one line instead |
| Controlled fields, client validation, loading state | All five fields controlled; required values and the 10-character password rule checked before anything is sent; the button disables and changes label while in flight |
| Accessible errors | Per-field messages tied to their input with `aria-describedby`, `aria-invalid` on the field, `role="alert"` on the form-level error and `role="status"` on the neutral notice |
| No navigation until the API responds | There is no navigation control on the form at all. The only `router.push` runs after a successful sign-in |
| Nothing added | No agency onboarding, billing, GHL, or any field the service does not accept |

### 13.3 The privacy contract is preserved, and the UI does not undo it

The API answers a **duplicate email and a new account with the same 202 and the same body**, by
design. The page therefore:

- **does not read or branch on that body at all.** The only branch after acceptance is whether the
  subsequent sign-in worked — which tells the person holding the right password what they need,
  and tells a prober nothing. A static test asserts the accepted branch contains no
  `response.json()` and no mention of existence;
- **never logs.** No `console` call anywhere in the file, asserted by test. An email and a password
  in a browser console outlive the tab they were typed in;
- shows the same neutral sentence — "Your details were submitted. Please sign in to continue." —
  whether the address was new or already taken. A browser test asserts that notice contains none
  of *exist*, *already*, *taken*, *registered*, *in use*, *duplicate*.

On a successful sign-in the new owner is sent to `/business/program`: the first loyalty card, which
is what §12 built and what they came to do.

### 13.4 A second prototype habit removed

Every visible string now comes from the message files. The prototype wrote both languages inline as
`locale === 'ar' ? … : …` ternaries, which is how two locales drift apart. A test asserts **no
Arabic character survives in the page source**, so a future edit cannot reintroduce an untranslated
string.

Login is unchanged, as required. Its `callbackUrl` handling was already restricted to same-site
paths and needed nothing.

### 13.5 Tests

**Five browser tests** in `tests/e2e/owner-registration.spec.ts` — the central assertion is not
that the form looks right, it is that **a request left the browser and a row appeared in the
database**:

| Requirement | Covered by |
|---|---|
| A real `POST /api/auth/register` occurs | the request is captured and its body checked field by field, including `SYP`, `Asia/Damascus` and the absence of `account_type` |
| The owner is signed in and reaches first-card setup | lands on `/en/business/program` with the card form visible; the database shows the user, one OWNER membership, the business with the right currency and timezone, and one default location |
| No prototype link | the submit control is a `BUTTON` with `type="submit"`, and **no anchor on the page has an href leading to `/business`** |
| Invalid input does not submit | empty form and short password both show field errors, the page never navigates, and **zero requests are made** |
| Duplicate email stays non-enumerating | the same 202, the neutral notice, no words that leak existence, nothing created for the prober, and the real owner's password still works afterwards |
| Arabic and English render | `dir` correct in both, headings translated, and the local-business-only line present in both |

**Eight static guards** in `tests/unit/register-page-wiring.test.ts` catch the specific regressions
that would bring the prototype back, in milliseconds: the fetch call, every field, both defaults,
`type="submit"`, no dashboard link, no console call, no "agency", no inline Arabic, the sign-in
attempt, and the non-branching accepted path.

### 13.6 An unrelated flaky test the gate caught — `dbc5d80`

The gate failed on `tests/integration/daily-limit.test.ts`, which this work had not touched. It had
passed all morning and failed at 08:00 UTC.

The test took the current instant and a row 20 hours old, on the reasoning that *"the two zones are
25 hours apart, so a 20-hour-old row cannot be inside both"*. **That is false.** Each local day is
24 hours long, and Kiritimati (UTC+14) and Niue (UTC-11) are offset by exactly **one** hour modulo
24 — so whenever both businesses are more than 20 hours into their local day, the same row sits
inside both. Measured: two hours out of every 24.

Pinning the hour removes the coin flip and makes the test stronger, because the old version only
exercised the interesting case some of the time. At 12:00 UTC one zone is 2 hours into its day and
the other 1 hour, so a row placed between the two local midnights belongs to exactly one of them on
every run — now asserted directly rather than derived from whatever the clock said. Verified across
all 24 possible suite start hours.

**No product code changed.** It is recorded here because it is outside this task's scope and was
fixed anyway: a gate that fails for two hours a day teaches people to re-run it.

### 13.7 Verification, on `6aa6aed`

```
GATE SUMMARY
PASS  dependency audit (prod, high+)             1477 ms
PASS  prisma generate                            2334 ms
PASS  lint                                       8141 ms
PASS  typecheck                                  3615 ms
PASS  prisma validate                            1719 ms
PASS  unit tests                                 1797 ms
PASS  test db up                                 1059 ms
PASS  migrate deploy (test db, migrator role)    5895 ms
PASS  migrate status (test db)                   5895 ms
PASS  runtime role grants (test db)               194 ms
PASS  integration tests                        223437 ms
PASS  worker build                                236 ms
PASS  production build                          15746 ms
PASS  migrate image dependencies                 2593 ms
PASS  web image container health                26813 ms
GATE PASSED in 301.0s (15/15 steps)
```

| Check | Result |
|---|---|
| unit / integration | **217** / **380** (597 total, 46 files) |
| `npm run test:e2e` | **9 passed (42.8 s)** |
| `npm audit --omit=dev --audit-level=high` | **0 vulnerabilities** |
| `npm audit` (full tree) | **0 vulnerabilities** |
| `git diff --check` | clean |

**No migration was added** and no schema changed.

### 13.8 What this round did not do

- **No staging deployment.** The fix is committed and pushed; updating staging is the owner's step.
- **No real-device check was performed, and none is claimed.** The manual checklist in §8 remains
  entirely unperformed. What has changed across §12 and §13 is that the path to it now exists: an
  owner can register, sign in, create a card and get a link — which is what those checks need.
- **The registration service's behaviour is unchanged**, including its account-enumeration
  contract. Only the page that calls it changed.
- **Login is unchanged.**
- `master` is untouched at `b9ee686`.

---

**PASS — REAL OWNER REGISTRATION REMEDIATION COMPLETE — READY TO UPDATE STAGING**
