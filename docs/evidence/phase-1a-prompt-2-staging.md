# Evidence — Phase 1a Prompt 2: HTTPS Staging Unblocker

**Date:** 2026-09-11
**Performed by:** development agent (Claude Opus 5), except where a row says otherwise
**Branch:** `rebuild/phase-0-foundation`
**Scope:** prepare a secure HTTPS staging deployment. **Not** Phase 1a Prompt 3, and no later
phase was started.

---

## 1. Result

**BLOCKED. No deployment happened, because none could.** Owner decisions B1, B2 and B3 are all
still `⬜` open in [DECISIONS-REQUIRED.md](../DECISIONS-REQUIRED.md); there is no host, no
hostname, no DNS record, no credential and no deployment authorization. Nothing in this session
invented one.

Everything that can be honestly done without them is done:

| | |
|---|---|
| Staging stack, TLS proxy, environment template | written and validated |
| Deployment runbook | written |
| Backup and restore-verification scripts | written **and actually run against a real PostgreSQL** |
| Local security validation (§5) | done, output below |
| `npm run gate` | **PASS 13/13 in 241.4 s** on `591aa2f` |
| `npm run test:e2e` | **3 passed (30.8 s)** |
| `npm audit`, full tree and production/high+ | **0 vulnerabilities** each |

### Owner inputs: supplied or not

| Input | Supplied? | Consequence |
|---|---|---|
| **B1** approved hosting / VPS access | **No** | Nothing to deploy to |
| **B2** staging domain | **No** | Caddy cannot request a certificate for a name that does not exist |
| **B3** HTTPS certificate approach and DNS readiness | **No** | No DNS record, so the ACME challenge cannot be answered |
| Explicit deployment authorization | **No** | Deployment would have been unauthorized |
| Staging-only environment values | **No** | Correctly so: the agent must never hold them |

**Was deployment authorized?** No.
**Was deployment performed?** No.
**Staging URL:** none exists.
**Was production touched?** No. No production deployment occurred, and none was attempted.

---

## 2. Commits

On top of `620b91d`. `master` untouched at `b9ee686`. No push, no force-push, no amend, no
rewritten history; the branch still has no upstream.

| # | SHA | Subject |
|---|---|---|
| 1 | `e1b96d0` | fix(pwa): move the card's theme colour to the viewport export |
| 2 | `95dc8a6` | feat(ops): a health endpoint that proves the database is reachable |
| 3 | `cdbe660` | feat(ops): a staging stack whose database has no route, not just a closed port |
| 4 | `30b3003` | feat(ops): backups that are verified on write, and a restore drill that reads the data |
| 5 | `591aa2f` | docs: the staging runbook, and who performs each step |
| 6 | `ea3f880` | docs: the staging evidence, and why it is blocked rather than passed |
| 7 | (this commit) | docs: fill in the evidence commit SHA, which row 6 could not know while being written |

---

## 3. What was inspected first

`docs/evidence/phase-1a-prompt-2.md`, `docs/DECISIONS-REQUIRED.md`, `docker-compose.yml`,
`Dockerfile`, `deploy/Caddyfile`, `.env.example`, `.env.production.example`,
`scripts/db-roles.mjs`, `scripts/db-migrate.mjs`, `scripts/gate.mjs`, `src/server/env.ts`,
`src/proxy.ts`, `src/worker/health.ts`, `.github/workflows/e2e.yml`, `.gitignore`, and the
deployment sections of `docs/PHASE-0-IMPLEMENTATION.md`.

Two documents named in the prompt, `docs/WALAAPLUS-MVP-SPEC.md` and `docs/DECISIONS.md`, do not
exist. The repository's equivalents are `docs/PRODUCT-SPEC.md` and `docs/DECISIONS-REQUIRED.md`
and those were read instead. No document was created to match the names in the prompt.

### Four defects found while inspecting, and fixed

**D-1 — the local stack handed the application every credential in the env file.** `docker-compose.yml`
gave `web` and `worker` `env_file: .env`, directly beneath a comment reading *"RUNTIME role only:
web never holds the migrator credentials."* Compose resolved `web`'s environment to seventeen
variables including `MIGRATE_DATABASE_URL`, `POSTGRES_PASSWORD`, both `TEST_*` database URLs and
two leftover `ONESIGNAL_*` keys from the prototype. Services now receive variables by name. After:

```
web    -> DATABASE_URL, NEXTAUTH_SECRET, NEXTAUTH_URL, NODE_ENV, TRUST_PROXY_HEADERS
worker -> DATABASE_URL, NEXTAUTH_SECRET, NEXTAUTH_URL, NODE_ENV, WORKER_HEALTH_PORT
migrator credential present? false
```

**D-2 — the proxy's health probe could not detect a database outage.** It probed
`/api/auth/providers`, which answers whenever Next is serving. An app that was up but cut off
from PostgreSQL passed and stayed in rotation. Replaced by `/api/health`.

**D-3 — the card's theme colour was silently dropped.** `themeColor` sat in the `metadata` export;
Next warned on every build that it is unsupported there, and a value it warns about is a value it
does not apply. It is the tint an installed PWA paints its status bar with, so it was missing on
exactly the artifact staging exists to verify. Moved to the `viewport` export; the build warning
is gone.

**D-4 — a stray empty directory named `Caddyfile;C`** sat beside `deploy/Caddyfile`, left by a
botched shell redirect. Untracked and empty; removed.

---

## 4. What was built

### `docker-compose.staging.yml` — self-contained, not an overlay

An overlay was tried first and abandoned for two reasons that are properties of Compose, not
preferences. Compose **appends** an overlay's `ports` and offers no syntax for removing one, so an
overlay could never take back the local stack's `127.0.0.1:5433` PostgreSQL binding. And the local
stack defines `test-db`, a throwaway database holding the migrator credentials with its data in
tmpfs, which must not exist on a server facing the internet.

| Property | Local stack | Staging stack |
|---|---|---|
| Public bindings | `proxy` only, `${WEB_PORT:-8080}:80` | `proxy` only, `80:80` and `443:443` |
| PostgreSQL | `127.0.0.1:5433` for host tooling | **no port at all** |
| Network | default bridge | `backend` **`internal: true`** (db, worker, migrate) + `edge` (proxy, web) |
| TLS | none, `auto_https off` | Caddy + Let's Encrypt, hostname from the environment |
| `test-db` | present | absent |

`internal: true` removes the network's gateway, so `db`, `worker` and `migrate` have **no route to
the internet in either direction**. That is a stronger property than an unpublished port.

### `deploy/Caddyfile.staging`

Automatic HTTPS on; hostname and ACME contact from `{$WALAAPLUS_DOMAIN}` and `{$ACME_EMAIL}`, so
no domain is committed. Forwarding headers are **SET** from the received connection, never
appended, which is the only reason `TRUST_PROXY_HEADERS=true` is defensible. Adds
`X-Robots-Tag: noindex`, HSTS without `includeSubDomains` or `preload`, `nosniff`,
`frame-ancestors 'none'` and `X-Frame-Options: DENY`; removes the `Server` banner; keeps the admin
API off; redirects `http://` to `https://`.

### `.env.staging.example`, `docs/STAGING-RUNBOOK.md`, `deploy/backup.sh`, `deploy/restore-check.sh`

The template names every required variable and **assigns none** (asserted by a test). The runbook
covers DNS, secret provisioning, migration order, startup order, health checks, backups and their
verification, rollback, four ways to confirm the database is private, and certificate renewal,
marking who performs each step. The scripts are described in §6.

---

## 5. Local security validation

All run on this machine against the committed files. No server was contacted.

### Compose validity

```
docker compose -f docker-compose.staging.yml --env-file <placeholder> config --quiet   -> staging: VALID
docker compose config --quiet                                                          -> local:   VALID
```

The placeholder env file contains obvious non-values (`placeholder-not-a-real-password`) and lives
in a scratch directory outside the repository. `--quiet` is used deliberately: `docker compose
config` prints resolved values, and printing them is how a secret reaches a transcript.

### Public ports and database isolation — resolved staging config

```
networks: backend (internal), edge (routed)
db       published=[]                              nets=[backend]        env=[POSTGRES_DB,POSTGRES_PASSWORD,POSTGRES_USER]
migrate  published=[]                              nets=[backend]        env=[DATABASE_URL,MIGRATE_DATABASE_URL]
proxy    published=[0.0.0.0:80->80 0.0.0.0:443->443] nets=[edge]         env=[ACME_EMAIL,WALAAPLUS_DOMAIN]
web      published=[]                              nets=[backend edge]   env=[DATABASE_URL,NEXTAUTH_SECRET,NEXTAUTH_URL,NODE_ENV,TRUST_PROXY_HEADERS]
worker   published=[]                              nets=[backend]        env=[DATABASE_URL,NEXTAUTH_SECRET,NEXTAUTH_URL,NODE_ENV,WORKER_HEALTH_PORT]
```

Only the proxy publishes. PostgreSQL is private and on a gateway-less network. `web` never
receives a migrator variable.

### Migration before application

```
migrate  db:service_healthy
web      db:service_healthy  migrate:service_completed_successfully
worker   db:service_healthy  migrate:service_completed_successfully
proxy    web:service_started
```

`service_completed_successfully` is the guarantee: web and worker cannot start against an
unmigrated schema or without their grants.

### Runtime role still restricted

From the gate's own step, against the test database as the migrator:

```
db-roles: OK role "walaaplus_app" — read/write on 20 public tables, append-only on
[LoyaltyOperation], no access to [_prisma_migrations], owns schema "pgboss",
cannot CREATE in public, members: [none]
```

### Docker runs the standalone artifact

`Dockerfile` line 52 copies `/app/.next/standalone` into the `web` image and line 57 runs
`node server.js`. The build produced `.next/standalone/server.js` (7,486 bytes), and the Playwright
suite serves that same output through `scripts/e2e-server.mjs` — the browser tests exercise the
shipped artifact, not `next dev`.

### Health endpoints reveal nothing

`/api/health` returns `{"status":"ok"}` or `{"status":"degraded"}`, `no-store`, one key. The worker's
endpoint returns a fixed status object with no environment or payload data. Five integration tests
assert the shape, including that the key list is exactly `["status"]` and that the body mentions
none of `postgres`, `prisma`, `walaaplus_app`, `database`, `url`, `secret`, `version`, `node`.

### Static policy tests, run in the gate on every commit

`tests/unit/compose-exposure.test.ts` (18 assertions) holds both Compose files to an exposure and
credential-reach policy. `tests/unit/deploy-config.test.ts` (23) holds both Caddyfiles and the env
template: TLS stays on in staging, headers are set and not appended, no real domain is committed,
the template assigns nothing. An early version of these tests failed four times by matching the
files' own **comments** — which name the things they forbid — and was corrected to parse directive
lines only.

---

## 6. Backups: actually executed

Run against the local `db` container (PostgreSQL 15), not a hypothetical one. Two failures were
found and fixed by running it:

- `pg_restore --list /dev/stdin` fails with `did not find magic string in file header`: the custom
  format needs a **seekable** file, and a pipe is not one. Both scripts now stage the archive
  inside the container. A byte-for-byte comparison confirmed the pipe itself was not at fault
  (identical size and sha256 in and out).
- the drill's table list named `Card`, which is not a table in this schema. Corrected to
  `CustomerCard` and `ProgramVersion`; the check reported `MISSING` and failed, as designed.

Final runs, with the database seeded so the drill had data to find:

```
backup: ok - walaaplus-20260911T164634Z.dump (76K, 20 tables with data, sha256 04fef7ff458359a2...)

restore-check: restored. Row counts in the throwaway database:
  User               1
  Business           1
  Customer           0
  CustomerCard       0
  ProgramVersion     0
  LoyaltyOperation   0
restore-check: WARNING - the restored ledger is empty. Expected on a fresh staging
               database; on a pilot database it means this is not a backup of live data.
restore-check: ok - ... restores and contains the core tables
```

The throwaway database was dropped afterwards (`select datname from pg_database where datname like
'restorecheck%'` returned nothing). Retention pruning keeps 30 files; dumps are mode 600 and
`/backups/` is git-ignored.

**This is not the restore drill.** Restoring onto a separate host is owner decision C3 and remains
not performed.

---

## 7. Automated verification

On `591aa2f`, working tree clean.

```
GATE SUMMARY
PASS  dependency audit (prod, high+)             1219 ms
PASS  prisma generate                            1561 ms
PASS  lint                                       5946 ms
PASS  typecheck                                  5333 ms
PASS  prisma validate                            1729 ms
PASS  unit tests                                 1676 ms
PASS  test db up                                  967 ms
PASS  migrate deploy (test db, migrator role)    6002 ms
PASS  migrate status (test db)                   5611 ms
PASS  runtime role grants (test db)               160 ms
PASS  integration tests                        193685 ms
PASS  worker build                                117 ms
PASS  production build                          17433 ms
GATE PASSED in 241.4s (13/13 steps)
```

| Suite | Files | Tests | Change |
|---|---|---|---|
| unit | 12 | **154** | +35 (compose exposure +12, deployment config +23) |
| integration | 31 | **368** | +5 (`/api/health`) |
| browser (Playwright) | 1 | **3 passed (30.8 s)** | unchanged |

`npm audit` full tree: **0 vulnerabilities**. `npm audit --omit=dev --audit-level=high`: **0
vulnerabilities**. `git diff --check` clean. `git status --porcelain` 0 entries.

**No migration was added.** The schema is unchanged by this work.

**CI run URL: none.** Pushing is still forbidden until owner decision A1, so the `e2e` and `gate`
workflows have not run on a server. Every figure above was produced locally.

---

## 8. Real-device checklist — NOT performed

Preparing this checklist was task 5, and task 5 is conditional on staging being live. **It is
not.** The checklist is written and waiting in
[STAGING-RUNBOOK.md §12](../STAGING-RUNBOOK.md); every row is unperformed, and none may be
recorded as automated.

| # | Check | Who performs it | Status |
|---|---|---|---|
| 1 | Android Chrome offers "Install app"; the icon opens standalone | Owner, on an Android phone | ⬜ not performed — no HTTPS origin |
| 2 | iOS Safari "Add to Home Screen" gives a standalone card | Owner, on an iPhone | ⬜ not performed — no HTTPS origin |
| 3 | Three cards install as three separate apps | Owner, on an Android phone | ⬜ not performed — no HTTPS origin |
| 4 | Real camera scan of a printed card QR resolves the customer | Owner, on an Android phone | ⬜ not performed — camera needs a secure context |
| 5 | Denied camera permission falls back to phone lookup | Owner, on a phone | ⬜ not performed — no HTTPS origin |
| 6 | The service worker caches no card responses | Owner, DevTools on a phone | ⬜ not performed — no HTTPS origin |
| 7 | Arabic RTL and English LTR reviewed at phone width | Owner, on a phone | ⬜ not performed — no device access |

The agent has no authorized physical device access, so no row could be performed by the agent
either.

**HTTPS verification:** not available. No certificate was requested, issued or inspected, because
there is no hostname to request one for.

---

## 9. Known limitations

No critical or high issue remains open. Everything below is Low unless marked.

| # | Sev | Item | Why acceptable now | Follow-up |
|---|---|---|---|---|
| **B-1** | **Blocked** | No staging deployment exists; installability and camera scanning unverified | Requires B1, B2, B3 and explicit authorization. Nothing may be invented | Owner: B1–B3, then §8 |
| **B-2** | **Blocked** | The staging stack has never been *run*, only validated | Compose validity, resolved exposure and startup order are proven statically; a first real `up` may still surface a host-specific problem (DNS, port 80 taken, an existing nginx) | Owner: first deployment, following the runbook |
| L-21 | Low | Copying dumps off the host is manual | It needs a storage credential the agent must never hold | Owner decision C2 |
| L-22 | Low | The restore drill runs beside the live database, not on a separate host | It proves the archive restores and carries data; it does not prove a cold rebuild | Owner decision C3, before the pilot |
| L-23 | Low | `.env.production.example` is stale and misleading | Predates the rebuild; names Stripe, Twilio, OneSignal, Apple/Google Wallet, SMTP, `DIRECT_URL`, none of which exist here. Git-ignored, never committed, and the template for nothing. Documented in runbook §11 | Owner deletes it; the agent did not, as it is a local file it did not create |
| L-24 | Low | Staging builds images on the host rather than pulling from a registry | No registry exists and pushing is not authorized (A1). Building from a checkout is reproducible and needs no credential | Revisit if staging becomes shared |
| L-25 | Low | `deploy/backup.sh` writes to the same host it protects | Correct behaviour for the script; the off-host copy is the owner's step, stated in the runbook and in the script's own output | Owner decision C2 |
| L-26 | Low | The local stack still starts `test-db` on a bare `docker compose up` | Local only; the staging file has no such service, and both databases bind loopback only | Optional tidy-up |
| L-27 | Low | HSTS is 60 days without `includeSubDomains` | Deliberate: those directives on a staging subdomain reach the owner's other subdomains and cannot be taken back quickly | Revisit for the production domain (B4) |

---

## 10. Required confirmations

- **No secret was committed.** The only tracked environment file added is `.env.staging.example`,
  which assigns no value to any variable — asserted by a test that fails the gate otherwise.
  `.env.staging` is git-ignored (verified: `git add --dry-run .env.staging` is refused). The
  Compose files contain only `${VAR:?...}` interpolations, never a literal.
- **No secret was written to this evidence file, or to any other.** The only values printed
  anywhere in this session were variable **names**, and the placeholder validation file's obvious
  non-values. `docker compose config` was run with `--quiet` for exactly this reason.
- **No production deployment occurred.** No production host, domain, credential or certificate was
  created, requested or touched.
- **No staging deployment occurred.** No account was created, no domain purchased, no DNS record
  changed, nothing pushed, nothing deployed, no credential used.
- **Security was not weakened to make staging work.** Every change tightens: the database loses its
  host binding entirely and gains a gateway-less network, the application stops receiving the
  migrator credential, the proxy gains TLS and five security headers, and the health probe now
  actually detects a database outage.
- **PostgreSQL is never publicly exposed**, and only the HTTPS reverse proxy is publicly reachable,
  in both Compose files (§5, and enforced by tests in the gate).
- **All environment variables are validated at startup, with no fallback secrets.** `src/server/env.ts`
  is unchanged by this work and still refuses to start on a missing value, reporting names only,
  and still refuses two known-compromised prototype secrets by hash.
- **Production and staging configuration are separate files** that are never merged.
- **`master` is untouched** at `b9ee686`; the branch has no upstream and nothing was pushed.

---

**BLOCKED — PHASE 1A PROMPT 2 HTTPS STAGING — owner decisions B1 (hosting), B2 (staging domain) and B3 (HTTPS certificate and DNS readiness) are all still open, and no deployment authorization was given; there is no host, hostname or DNS record to deploy to, so no certificate could be issued and the seven real-device checks in §8 remain unperformed. All staging configuration, the runbook, the backup and restore-verification scripts, and every local check are complete and passing on `591aa2f`**
