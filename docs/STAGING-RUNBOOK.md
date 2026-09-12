# Staging Deployment Runbook

How to bring WalaaPlus up on a staging server over HTTPS, verify it, back it up, and roll it back.

**Two shapes, and you must pick one before reading further.**

| | Server | Compose file | Who owns 80 and 443 |
|---|---|---|---|
| **Dedicated** | nothing else runs on it | `docker-compose.staging.yml` | this stack, via its own Caddy container |
| **Co-hosted** | already runs other services | `docker-compose.staging-cohost.yml` | a Caddy that is already installed on the host |

Sections 1 to 12 describe the **dedicated** shape. **[Section 13](#13-co-hosted-oci-staging)** describes
the co-hosted one and is the current target: an Oracle Linux 9.8 host already running
OpenClaw/OpenBot behind a system-managed Caddy. Read section 13 first if that is your server;
sections 2, 6, 7 and 12 still apply as written, and section 13 says which of the others do not.

**Who runs this.** The owner, on a server the owner controls, with credentials the owner
generates. The agent wrote this file, the Compose stack and the scripts it names; the agent has
never run any of it against a server and holds no credential. Every step below is marked with who
performs it.

**Why staging exists at all.** Service workers, installability and (later) web push refuse to run
without TLS, except on `localhost`. The customer card is a PWA. Until there is an HTTPS origin on
a real hostname, the card cannot be installed on a phone and that half of Phase 1a Prompt 2
cannot be verified by anyone. That is the whole reason for this document.

**Prerequisites — owner decisions.** All three are still open in
[DECISIONS-REQUIRED.md](DECISIONS-REQUIRED.md) and nothing here can start without them:

| | Decision | What it means here |
|---|---|---|
| B1 | Hosting | A Linux host with Docker Engine and the Compose plugin, a public IPv4 address, and inbound 80 and 443 open |
| B2 | Staging domain | A hostname the owner controls, e.g. `staging.<a-domain-you-own>` |
| B3 | HTTPS certificate | This runbook assumes Caddy with Let's Encrypt, which needs only B1 and B2 to work |

---

## 1. DNS

**Owner.** Before the first start, create ONE record:

| Type | Name | Value | TTL |
|---|---|---|---|
| `A` | the staging hostname, e.g. `staging.example` | the server's public IPv4 address | 300 while setting up |

Add an `AAAA` record as well if the host has a public IPv6 address and it is reachable; leave it
out entirely if it is not. A published `AAAA` that does not answer makes certificate issuance fail
intermittently and look like a Caddy problem.

Verify it resolves **from off the server** before continuing. A record that exists only in the
server's own resolver cache will still fail the ACME challenge, which is validated from outside:

```bash
dig +short staging.example A
```

Wait until the answer is the server's address. Nothing below works before that.

### Firewall

```bash
sudo ufw allow 80/tcp && sudo ufw allow 443/tcp && sudo ufw status
```

Port 80 is not optional. It answers the HTTP-01 challenge and redirects human traffic to HTTPS.
Do **not** open 5432: the database is not reachable from the host's network stack at all, and §9
is how you confirm that.

---

## 2. Secrets

**Owner.** Three secrets exist. Generate all three **on the server**, never on a laptop, never in
a chat window, never in a ticket:

```bash
openssl rand -base64 48   # NEXTAUTH_SECRET        (never goes in a URL; base64 is fine)
openssl rand -hex 32      # POSTGRES_PASSWORD      (the migrator/owner role)
openssl rand -hex 32      # APP_DB_PASSWORD        (the restricted runtime role)
```

**The two database passwords must be hex.** Both are embedded in a connection string that
`docker-compose.staging.yml` builds:

```
postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@db:5432/${POSTGRES_DB}
```

base64 uses `/` and `+`. A password containing `/` ends the URL's authority early, so
`postgresql://walaaplus:ab/cd@db:5432/loyalty` is not a URL at all: `prisma migrate deploy`,
`psql` and `pg_dump` all reject it. The trap is that this depends on which bytes `openssl`
happened to draw, so the same instructions work one day and fail the next, with an error that
points nowhere near the password. Measured on a developer machine: **36% of
`openssl rand -base64 24` values contain a `/`, and 38% contain a `+`.**

Hex is `[0-9a-f]`: safe in a URL, safe in Compose interpolation, safe on a `psql` command line.
32 bytes of hex is 64 characters and 256 bits of entropy, stronger than the 192 bits of the
base64 form it replaces. `NEXTAUTH_SECRET` stays base64 because it is never put in a URL.

If you must use a password that contains `/`, `+`, `%`, `:`, `@` or whitespace, percent-encode
it before it reaches the URL (`/` becomes `%2F`). The application refuses to start on a
connection string that does not parse, and `scripts/db-roles.mjs` refuses to create the role,
both naming the variable and neither printing the value.

The two database passwords must differ from each other. All three must differ from development
and from production. A value that has ever appeared in this repository's git history is refused
at startup by hash, so an old prototype secret cannot be reused by accident.

Then, in the repository directory on the server:

```bash
cp .env.staging.example .env.staging
chmod 600 .env.staging
```

Fill in `.env.staging` with an editor. The template lists every variable and assigns none.
`.env.staging` is git-ignored and must never be committed, pasted, or copied into an evidence
file. Ownership of these values is owner decision B5.

**Variable names this deployment requires** — names only, values are the owner's:

| Variable | Set where | Notes |
|---|---|---|
| `WALAAPLUS_DOMAIN` | `.env.staging` | Hostname only, no scheme, no path. Not a secret |
| `ACME_EMAIL` | `.env.staging` | A mailbox someone reads. Not a secret |
| `POSTGRES_USER`, `POSTGRES_PASSWORD` | `.env.staging` | Migrator/owner role. Reaches the `migrate` container only |
| `POSTGRES_DB` | `.env.staging` | Optional; defaults to `loyalty` |
| `APP_DB_USER`, `APP_DB_PASSWORD` | `.env.staging` | Restricted runtime role. Defaults to the name `walaaplus_app` |
| `NEXTAUTH_SECRET` | `.env.staging` | Minimum 32 characters |
| `DATABASE_URL`, `MIGRATE_DATABASE_URL`, `NEXTAUTH_URL`, `TRUST_PROXY_HEADERS`, `NODE_ENV`, `WORKER_HEALTH_PORT` | **`docker-compose.staging.yml`** | Built from the above. Do not also put them in the env file |

Every one of them is validated at startup by `src/server/env.ts`. A missing or malformed value
stops the process and reports the variable **name**; no value is ever printed or logged.

---

## 3. Start

**Owner**, from the repository directory on the server, on the branch being staged:

```bash
docker compose -f docker-compose.staging.yml --env-file .env.staging up -d --build
```

`--env-file` is not optional. Compose reads `.env` by default, and `.env` is the local
development file; without the flag a staging stack silently comes up on development values.

`docker-compose.staging.yml` is used **alone**, never merged with `docker-compose.yml`. Merging
would inherit two things staging must not have: the local file's loopback PostgreSQL port, which
an overlay cannot remove because Compose only appends ports, and the `test-db` service, a
throwaway database that holds the migrator credentials and keeps its data in tmpfs.

### Order, and why it is not a suggestion

Compose enforces this; you do not sequence it by hand.

1. **`db`** starts and must report healthy (`pg_isready`).
2. **`migrate`** runs to completion and exits 0. It is the only container that ever receives
   `MIGRATE_DATABASE_URL`. It does two things in order:
   - `prisma migrate deploy` — applies pending migrations as the owner role. Forward-only; never
     edit an applied migration.
   - `scripts/db-roles.mjs` — creates or refreshes the restricted runtime role and its grants,
     re-reading the role name and password from `DATABASE_URL`. **It must run after every
     migration**, because new tables need grants. Both steps are idempotent.
3. **`web`** and **`worker`** start only once `migrate` has completed successfully
   (`condition: service_completed_successfully`). Neither can run against an unmigrated schema,
   and neither ever holds the migrator credential.
4. **`proxy`** starts and requests the certificate.

The worker is a separate container from the web app, deliberately: background work must not run
inside a request. Both connect as the same restricted runtime role.

### First start: watch the certificate

```bash
docker compose -f docker-compose.staging.yml --env-file .env.staging logs -f proxy
```

Expect `certificate obtained successfully`. Common failures, in order of likelihood: DNS not
propagated; port 80 closed or taken by a host nginx; the hostname in `WALAAPLUS_DOMAIN` not the
one the record points at. Fix the cause and restart `proxy` alone.

---

## 4. Verify the deployment

**Owner**, from a machine that is not the server:

```bash
curl -sI https://staging.example/healthz
curl -s  https://staging.example/api/health
curl -sI http://staging.example/          # expect 308 to https://
```

Expect `200` and `ok` from the first, `{"status":"ok"}` from the second, and a redirect from the
third. `/healthz` is answered by the proxy itself, so it stays up when the app is down; the
difference between the two tells you which layer failed.

### Certificate

```bash
echo | openssl s_client -connect staging.example:443 -servername staging.example 2>/dev/null \
  | openssl x509 -noout -subject -issuer -dates
```

Check that the subject matches the hostname, the issuer is Let's Encrypt, and `notAfter` is about
90 days out. A browser padlock is not sufficient evidence for the evidence file; this output is.

---

## 5. Health checks

| What | How | Expected |
|---|---|---|
| Proxy | `curl -s https://<domain>/healthz` | `ok`. Answered by Caddy; independent of the app |
| App + database | `curl -s https://<domain>/api/health` | `{"status":"ok"}`; `503 {"status":"degraded"}` if PostgreSQL is unreachable |
| Worker | `docker compose -f docker-compose.staging.yml --env-file .env.staging exec worker wget -qO- http://localhost:8081/health` | `{"status":"ok",...}`. Not published to the host by design |
| Containers | `docker compose -f docker-compose.staging.yml --env-file .env.staging ps` | `db`, `web`, `worker`, `proxy` all `running (healthy)`; `migrate` `exited (0)` |

`/api/health` runs `SELECT 1` as the runtime role and returns a status word only — no version, no
database name, no error text. The proxy probes it every 30 seconds and takes the app out of
rotation when it fails, so an app that is up but cut off from PostgreSQL stops serving instead of
returning five-hundreds.

---

## 6. Backups

**Owner.** Nightly dump, verified on write:

```bash
./deploy/backup.sh
```

It runs `pg_dump -Fc` **inside** the database container over the local socket, so no password is
passed on a command line where `ps` would show it. It then reads the archive back with
`pg_restore --list` and compares a checksum taken inside the container with one taken on the
host, before renaming the file into place. A partial or corrupt dump never becomes a backup.
Default output `./backups`, default retention 30 files, mode 600.

Schedule it as root, on the server, in the repository directory:

```
17 3 * * *  cd /srv/walaaplus && ./deploy/backup.sh >> /var/log/walaaplus-backup.log 2>&1
```

**Copying the dumps off this host is a separate, manual owner step** and is deliberately not
automated here, because it needs a storage credential the agent must never hold. A backup that
lives only on the machine it protects is not a backup. Destination and retention are owner
decisions C2 and C3.

### Backup verification

```bash
./deploy/restore-check.sh
```

Restores the newest dump into a throwaway database beside the live one, prints row counts for
`User`, `Business`, `Customer`, `CustomerCard`, `ProgramVersion` and `LoyaltyOperation`, then
drops the throwaway database. The live database is never written to. It warns loudly when the
restored ledger is empty, because on a pilot database that means the dump is not of the live
data. Schedule it weekly.

**This is not the restore drill.** The real drill — restoring a dump onto a *separate* host and
pointing an application at it — is owner decision C3 and must be rehearsed before the pilot.
Running the script does not substitute for it, and no evidence file may claim otherwise.

---

## 7. Rollback

Migrations are forward-only. There is no `migrate down`, and inventing one under pressure is how
data is lost. Choose by what actually broke.

**Application code is bad, schema is fine.** The common case.

```bash
git checkout <previous-good-commit>
docker compose -f docker-compose.staging.yml --env-file .env.staging up -d --build web worker
```

Older application code against a newer schema is safe as long as the migration was additive,
which is why additive migrations are the rule.

**A migration is bad.** Restore, do not reverse:

```bash
docker compose -f docker-compose.staging.yml --env-file .env.staging stop web worker
./deploy/restore-check.sh backups/<chosen>.dump     # confirm the dump is good FIRST
# then, with the app still stopped, restore it over the live database:
docker compose -f docker-compose.staging.yml --env-file .env.staging exec -T db \
  sh -c 'dropdb -U "$POSTGRES_USER" --force "$POSTGRES_DB" && createdb -U "$POSTGRES_USER" "$POSTGRES_DB"'
docker compose -f docker-compose.staging.yml --env-file .env.staging exec -T db \
  sh -c 'cat > /tmp/restore.dump'  < backups/<chosen>.dump
docker compose -f docker-compose.staging.yml --env-file .env.staging exec -T db \
  sh -c 'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --no-owner --no-privileges --exit-on-error /tmp/restore.dump && rm -f /tmp/restore.dump'
git checkout <commit-before-the-bad-migration>
docker compose -f docker-compose.staging.yml --env-file .env.staging up -d --build
```

Everything written since that dump is gone. On staging that is acceptable; on a pilot database it
is an incident, and the decision to do it is the owner's alone.

**Total rollback, keeping nothing:**

```bash
docker compose -f docker-compose.staging.yml --env-file .env.staging down -v
```

`-v` deletes the volumes, including `caddy-data` — which holds the certificate and its private
key. Re-issuing counts against Let's Encrypt's rate limit for that hostname (5 duplicate
certificates per week). Prefer `down` without `-v` unless the database must go too.

---

## 8. Updating

```bash
git pull
docker compose -f docker-compose.staging.yml --env-file .env.staging up -d --build
```

`migrate` re-runs and applies anything new, then `web` and `worker` restart. Run `./deploy/backup.sh`
**before** an update that carries a migration, not after.

---

## 9. Confirming the databases are private

**Owner**, after every deployment and after any change to the Compose file. Four checks, weakest
to strongest:

**1. Compose publishes nothing but the proxy.** On the server:

```bash
docker compose -f docker-compose.staging.yml --env-file .env.staging ps --format '{{.Service}} {{.Ports}}'
```

Only `proxy` may show a `->` mapping, and only for 80 and 443. `db`, `web` and `worker` must show
none. The same policy is asserted statically in `tests/unit/compose-exposure.test.ts` and fails
the gate on every commit.

**2. The host is not listening on a database port.**

```bash
sudo ss -tlnp | grep -E '5432|5433|8081|3000' || echo 'nothing listening — correct'
```

**3. There is no route, not merely a closed port.** `db`, `worker` and `migrate` sit on a Compose
network declared `internal: true`, which has no gateway:

```bash
docker network inspect walaaplus-staging_backend --format '{{.Internal}}'   # true
docker compose -f docker-compose.staging.yml --env-file .env.staging exec db \
  sh -c 'wget -qO- --timeout=3 https://example.com >/dev/null 2>&1 && echo REACHABLE || echo "no route — correct"'
```

**4. From outside, the port is not open.** From another machine:

```bash
nc -vz staging.example 5432    # expect refused or timeout
nc -vz staging.example 443     # expect succeeded
```

Record the output of all four in the evidence file.

---

## 10. Certificates: renewal and verification

Caddy renews automatically, roughly 30 days before expiry, using the same HTTP-01 challenge.
There is no cron entry to add and no `certbot renew` to forget. Three things are worth knowing:

- **Port 80 must stay open.** Renewal fails silently-ish months after issuance if it is closed;
  the only symptom is a line in the proxy log and, eventually, an expired certificate.
- **The `caddy-data` volume must survive.** It holds the certificate, the private key and the
  ACME account. `down -v` destroys it.
- **`ACME_EMAIL` must be a mailbox someone reads.** It is where Let's Encrypt writes when
  renewal has been failing.

Check expiry at any time with the `openssl s_client` command in §4. To force a renewal test
without waiting, restart the proxy and read its log:

```bash
docker compose -f docker-compose.staging.yml --env-file .env.staging restart proxy
docker compose -f docker-compose.staging.yml --env-file .env.staging logs --tail=50 proxy
```

Set a calendar reminder to run the §4 certificate check monthly. Automatic renewal that nobody
ever looks at is how a certificate expires.

---

## 11. What this stack does not use

`.env.production.example` in the repository root **predates the rebuild**. It names Stripe,
Twilio, OneSignal, Apple Wallet, Google Wallet, SMTP, Supabase and a `DIRECT_URL`, none of which
exist in this product. It is git-ignored, it is not the template for anything, and it should not
be copied to any server. The templates are `.env.example` (local) and `.env.staging.example`
(this runbook). Deleting the stale file is the owner's call, since it is a local file the agent
did not create.

Not configured in staging, deliberately: web push and VAPID keys (Phase 1.5, decision C1),
offline card caching (the service worker caches nothing on purpose), any payment provider, any
SMS provider, and any public API credential or webhook.

---

## 12. After staging is live: the real-device checklist — PASSED 2026-09-12

These are the checks that HTTPS staging exists in order to make possible. **The owner performs
them on physical phones.** Record who ran each one and what happened in
`docs/evidence/phase-1a-prompt-2.md`; do not mark any of them as automated.

**Status: every row below was performed by the owner on 2026-09-12 and passed**, against staging
running commit `c759d78`. The table is kept as the procedure to repeat after a change that could
affect any of it — a new service worker, a new manifest, or anything touching the camera.

| # | Check | Device | Expected |
|---|---|---|---|
| 1 | Android Chrome offers "Install app" on a card page | Android | The prompt appears; the installed icon opens the card standalone, with no browser chrome |
| 2 | iOS Safari "Add to Home Screen" | iPhone | Standalone card with the right name and icon |
| 3 | Three cards from three businesses install as three separate icons | Android | Three icons, three scopes; opening one never shows another's balance |
| 4a | Real camera scan of a printed card QR | **Android** | Permission granted, **rear-camera preview visibly starts**, then the QR decodes and the scanner resolves the customer |
| 4b | Real camera scan of a printed card QR | **iPhone, Safari** | The permission prompt appears at all, then the fallback decoder scans. Safari has no `BarcodeDetector`; this path exists only because of that |
| 5 | Camera permission denied | Android | The scanner falls back to phone lookup with no dead end |
| 6 | Service worker caches nothing | Either, DevTools | Application → Cache Storage is empty; no cached card responses |
| 7 | Arabic RTL and English LTR | Both | Layout correct in both locales at phone width |
| 8 | **Counter enrolment** — search a number that has no card, fill the panel, tick consent, submit | Either | A card is created, its link and QR appear on the Scanner, and the card loads so a stamp can be awarded at once |
| 9 | **Counter enrolment, repeated** — search the same number again, and enrol again if offered | Either | No second card and no second welcome bonus. The balance is unchanged |
| 10 | **Card restore** — find an existing customer by phone and reveal their link | Either | The same link as row 8, shown on screen and copyable |
| 11 | **An old printed enrolment link** (`/join/<token>`) | Either | A notice to ask a member of staff. No form, no card, and the same page for a token that never existed |

Rows 1 to 7 have been performed and recorded, so Phase 1a Prompt 2's manual gate is complete.

**Rows 8 to 11 were performed by the owner on 2026-09-12**, against staging running
`bdd8731b53b4ed352e82573c79b41a6ebc7cc853`, together with an award-then-reversal check that
restored the original balance. All passed. No names, phone numbers, card links, QR values or
screenshots were recorded, by instruction. The results are in
`docs/evidence/phase-1a-prompt-3.md` §13.9; the agent did not observe them and records them as the
owner's results.

**Rows 4a and 4b both failed on the first real attempt**, for two different and unrelated reasons:
Safari was told it had no camera before any prompt, and Android granted permission and then showed
nothing at all. Both were fixed in code (evidence §14) and **both have since been retested on the
deployed build and passed** (evidence §15).

That history is the reason 4a and 4b are separate rows and should stay separate: a pass on one has
never been a pass on the other. Run both.

---

## 13. Co-hosted OCI staging

The current staging target is **not** a dedicated box. It is an Oracle Linux 9.8 host that
already runs OpenClaw/OpenBot behind a **system-managed Caddy service**, and that Caddy **owns
ports 80 and 443**. Docker Engine and the Compose plugin are already installed.

**This is staging. It is not production, it never becomes production by being promoted, and no
production data may be loaded into it.** Production hosting remains owner decision B4 and is out
of scope here.

### 13.1 What changes, and what does not

| | Dedicated (§1–12) | Co-hosted (this section) |
|---|---|---|
| Compose file | `docker-compose.staging.yml` | **`docker-compose.staging-cohost.yml`** |
| Proxy | a Caddy container in the stack | **none.** The host's existing Caddy serves the site |
| Published ports | `80:80` and `443:443` | **`127.0.0.1:3100:3000`, and nothing else** |
| TLS | obtained by the stack's own Caddy | obtained by the host Caddy, from a reviewed fragment |
| PostgreSQL | no port | no port. **Never 5432 on this host — it belongs to a neighbour** |
| Worker | no published port | no published port |
| `ACME_EMAIL` | required | **unused.** The host Caddy already has an ACME account |
| Forwarded IP headers | trusted: the proxy is the only path | **not trusted.** Loopback is reachable by every local process (§13.2) |
| Resource limits | none: the box is ours | **explicit CPU and memory ceilings** on all four services (§13.2) |

Everything else carries over unchanged: the same two database roles, the same startup order, the
same startup validation, the same backup and restore scripts (§6), the same rollback procedure
(§7), and the same real-device checklist (§12).

### 13.2 Ports, and why only one is bound

The host Caddy owns 80 and 443. A second proxy cannot bind them, and trying would either fail to
start or take the existing sites down. So this stack runs no proxy and publishes exactly one port:

```
127.0.0.1:3100:3000
```

`127.0.0.1` is the host's own loopback interface. Not `0.0.0.0`, not the Docker bridge, not the
VPC address, not the public one. A container in another stack on this host cannot reach it, and
neither can the internet; only a process on the host itself can, which is exactly what the host
Caddy is. `3100` was chosen because it is free on that host. **Ports 3456, 5432 and 18789 belong
to OpenBot and are never bound by anything in this repository.**

The Compose file writes that mapping as a literal rather than a variable on purpose. An
interpolated host address is one typo away from `0.0.0.0`, which would publish the application to
the internet beside the proxy that is meant to be in front of it.

### Why forwarded IP headers are not trusted here

`TRUST_PROXY_HEADERS` is **`false`** in `docker-compose.staging-cohost.yml`, and it must stay
false in that file.

On a dedicated box `web` publishes nothing, so the proxy is the only possible path to it and
`TRUST_PROXY_HEADERS=true` means precisely "trust the proxy". Here `web` answers on
`127.0.0.1:3100`, which **every local process on this shared host can reach** — not only Caddy.
Any of them could send a request with a different `X-Forwarded-For` on every attempt. A per-address
limit built on an address the caller chooses is worse than no limit at all, because it looks like
protection while providing none.

The host Caddy still replaces the headers correctly, and the fragment keeps doing so; the
application simply declines to believe them in this shape.

**What that costs, stated plainly:**

| | In co-hosted staging |
|---|---|
| Per-IP window on registration | **unavailable** |
| Per-IP window on sign-in | **unavailable** |
| Per-IP window on public enrolment | **not applicable** — public enrolment was withdrawn by owner decision B7 option 3; `/api/enroll` answers `410` and writes nothing |
| Per-submitted-email window on registration | **active** |
| Per-identifier window on sign-in | **active** — this is the one that stops credential stuffing against one account |
| **Per-enrolment-link window**, database-backed | **not applicable** — it guarded the public write that no longer exists. Enrolment now requires a staff session, which is itself rate-limited at sign-in |
| Global window on registration, keyed on a constant | **active** — the one that survives having no client address |
| Rate limiting of counter enrolment and scanner writes | **none exists.** Those paths require a staff session, which is itself limited at sign-in; there is no per-actor window behind it (Prompt 3 finding M-11) |
| Idempotency, tenant isolation, append-only ledger | unaffected |

The application reports no client address at all rather than a forgeable one, so the windows above
simply do not open. Nothing silently degrades to a weaker limit.

**This is the safer of the two options**, not a reluctant compromise: trusting the header would not
have protected against a local process anyway — it would have handed that process an unlimited
supply of distinct identities and made the per-address windows useless while still appearing on
the dashboard.

**A dedicated server restores the trusted-proxy behaviour**, unchanged, by using
`docker-compose.staging.yml`, where `web` publishes nothing and the proxy really is the only path.
That file already sets `TRUST_PROXY_HEADERS=true` and is untouched by this shape.

### Resource limits, because the box is shared

One vCPU, shared with OpenClaw/OpenBot. Every service has an explicit ceiling so this stack cannot
take the core:

| Service | `cpus` | `mem_limit` | `mem_reservation` | When |
|---|---|---|---|---|
| `db` | 0.25 | 384m | 128m | always |
| `web` | 0.35 | 512m | 160m | always |
| `worker` | 0.15 | 256m | 64m | always |
| `migrate` | 0.50 | 512m | 128m | startup only, then it exits |

**Steady state is capped at 0.75 vCPU and 1152 MiB**, leaving at least a quarter of the single
core and the rest of memory to the host and its other services. During startup `migrate` runs
while `web` and `worker` do not, so the transient ceiling is `db` + `migrate` = 0.75 vCPU as well.

Why each one:

- **`db` 384m** is roughly triple PostgreSQL's expected resident size here (128 MB of shared
  buffers plus a handful of Prisma connections). Deliberately loose: an OOM-killed database is a
  corrupted staging run, not a tidy failure. If it is ever killed — `docker inspect` reports
  `OOMKilled` — raise this one rather than lowering the others.
- **`web` 512m** against a standalone Next.js server that sits well under 200 MB, leaving room for
  a restart, a burst of requests and the V8 heap without making this stack the reason the host
  swaps.
- **`worker` 256m and 0.15 CPU** is the smallest allowance, because a pg-boss loop that wakes,
  polls and sleeps has no user waiting on it. It is the right service to squeeze first.
- **`migrate` 512m and 0.50 CPU** is the most generous, and costs nothing in steady state because
  the container exits before `web` and `worker` start. `web` and `worker` wait on it completing
  **successfully**, so an OOM kill there does not fail one request — it halts the entire startup.
  Its memory ceiling is never lower than `web`'s, which a test enforces.

`mem_reservation` is set well below each limit on purpose. A reservation is a floor the kernel
tries to protect; setting it near the limit would make this stack the *last* thing reclaimed under
pressure, which is backwards on someone else's host.

These use the plain Compose keys `cpus`, `mem_limit` and `mem_reservation`, which `docker compose
up` enforces directly. `deploy.resources` is not used: it is the Swarm spelling, and a limit that
is silently ignored on a one-vCPU box is the worst of both worlds.

**Assumption: the host has at least 2 GiB of RAM.** Check before the first start, and scale the
numbers down if it has less:

```bash
free -m
nproc
```

### 13.3 DNS — before anything else

**Owner.** `staging.truebiznes.com` must resolve to **84.8.119.97** before Caddy is asked to
serve it. The ACME challenge is validated from the internet, not from the host's resolver cache,
so a record that has not propagated fails issuance and looks like a Caddy fault:

```bash
dig +short staging.truebiznes.com A
```

Do not insert the site block until that prints `84.8.119.97`. Certificate issuance is rate
limited per hostname, so repeated failed attempts are not free.

### 13.4 Bring the stack up

**Owner**, in the repository directory on the host, on the branch being staged:

```bash
cp .env.staging.example .env.staging
chmod 600 .env.staging
# fill it in per §2. ACME_EMAIL is not used in this shape and may be left blank.
docker compose -f docker-compose.staging-cohost.yml --env-file .env.staging up -d --build
```

Secrets are generated on the server exactly as in §2, **hex for both database passwords**.

Startup order is enforced by Compose and is the same as §3: `db` healthy, then `migrate` runs
migrations and role grants to completion, then `web` and `worker` start. Confirm before touching
Caddy at all:

```bash
docker compose -f docker-compose.staging-cohost.yml --env-file .env.staging ps
curl -s http://127.0.0.1:3100/api/health        # expect {"status":"ok"}
```

If that curl does not answer, stop. A Caddy site pointing at a dead upstream serves 502s under a
real hostname and burns certificate attempts for nothing.

### 13.5 The Caddy site block — reviewed, inserted by hand

The fragment is [`deploy/Caddyfile.walaaplus-staging.caddy`](../deploy/Caddyfile.walaaplus-staging.caddy).
Nothing in this repository loads it, reloads Caddy, or requests a certificate. It contains no
global options block, no listener address and no port binding, because the host Caddyfile already
has all three and **a Caddyfile may contain exactly one global `{ ... }` block** — a second one is
a parse error, and a parse error in `/etc/caddy/Caddyfile` takes the host's existing sites down
with it, OpenBot included.

The person administering the host, hereafter the OCI agent, performs these steps in this order:

1. **Back up the current configuration**, so a rollback is a copy rather than a reconstruction:
   ```bash
   sudo cp /etc/caddy/Caddyfile /etc/caddy/Caddyfile.bak.$(date -u +%Y%m%dT%H%M%SZ)
   ```
2. **Insert the fragment** into `/etc/caddy/Caddyfile`, after the existing site blocks. Do not
   edit the global block. Do not remove or reorder anything already there.
3. **Validate the COMPLETE file, never the fragment alone.** What matters is whether the combined
   configuration parses on that host:
   ```bash
   sudo caddy validate --config /etc/caddy/Caddyfile
   ```
   Expect `Valid configuration`. Anything else: restore the backup and stop. Validation loads the
   configuration without starting listeners and without requesting a certificate, so it is safe
   to run as often as needed.
4. **Ask the owner.** **Reload only after explicit owner approval.** Validation proves the file
   parses; it does not prove the change should happen now, and the reload affects a service the
   owner is already running in front of other things.
5. **Reload, never restart:**
   ```bash
   sudo systemctl reload caddy
   ```
   A reload keeps existing connections and sites serving. A restart drops every connection the
   host is handling, OpenBot's included.
6. **Verify from outside the server:**
   ```bash
   curl -sI https://staging.truebiznes.com/healthz
   echo | openssl s_client -connect staging.truebiznes.com:443 -servername staging.truebiznes.com 2>/dev/null \
     | openssl x509 -noout -subject -issuer -dates
   ```
   Then confirm the neighbours are still healthy. A change to a shared Caddy is not verified until
   the services that were already there have been checked too.

**Rollback:** remove the block, validate, reload. The certificate Caddy obtained stays in its data
directory and is reused if the block returns.

### 13.6 Confirming the stack stayed in its lane

**OCI agent**, after the stack is up:

```bash
# Only 3100, only on loopback. Nothing of ours on 0.0.0.0.
docker compose -f docker-compose.staging-cohost.yml --env-file .env.staging ps --format '{{.Service}} {{.Ports}}'
sudo ss -tlnp | grep 3100                       # expect 127.0.0.1:3100 only

# We publish no database port, and 5432 still belongs to whoever had it.
sudo ss -tlnp | grep 5432                       # unchanged from before this deployment

# Our networks and volumes are ours, created under our own project name.
docker network ls --filter name=walaaplus-staging-cohost
docker volume  ls --filter name=walaaplus-staging-cohost
```

From another machine, `nc -vz staging.truebiznes.com 3100` must be refused or time out: 3100 is
loopback-only and must never answer from off the host.

The same policy is asserted statically in `tests/unit/compose-exposure.test.ts` and
`tests/unit/deploy-config.test.ts`, which fail the gate on every commit if the Compose file
stops publishing exactly `127.0.0.1:3100:3000`, if a proxy service appears in it, or if the
fragment ever points somewhere other than `127.0.0.1:3100`.

### 13.7 First startup: watch what it does to the host — required, not optional

**OCI agent.** Immediately after the first `up`, and again after the Caddy block goes live, watch
the host for **at least five minutes** before walking away. This stack is a guest on a one-vCPU
machine; the limits in §13.2 are ceilings, not predictions.

```bash
# Live view. Leave it running for a few minutes; watch OUR containers and OpenBot's together.
docker stats

# One-shot snapshot, easier to paste into a report:
docker stats --no-stream --format 'table {{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}\t{{.MemPerc}}'

# Host pressure. si/so are swap in and out: sustained non-zero means the host is thrashing.
vmstat 1 10
free -m
uptime            # load average on ONE core: sustained > 2.0 is trouble
```

Then check the neighbours are still healthy, by whatever means the owner normally uses for
OpenClaw/OpenBot — their own health endpoint, their logs, or simply that they still answer.

**STOP THE DEPLOYMENT if any of these is true:**

| Signal | What to do |
|---|---|
| OpenClaw/OpenBot becomes unhealthy, unresponsive, or starts erroring | `docker compose -f docker-compose.staging-cohost.yml --env-file .env.staging down` and report before doing anything else |
| `vmstat` shows sustained swap in/out, or `free -m` shows available memory near zero | Same. Heavy swapping on one vCPU degrades every service on the host, not just this one |
| Load average stays above ~2.0 on the single core with no work being done | Same |
| A WalaaPlus container is repeatedly restarting, or `docker inspect <container>` reports `OOMKilled` | Stop, raise that one service's `mem_limit`, and report which service and what it was doing |

Stopping is cheap and reversible: `down` removes the containers and leaves the database volume,
the images and the certificate alone. Bringing it back up later is another `up -d`.

Record the `docker stats --no-stream` snapshot and the neighbours' status in the deployment
report. "It seemed fine" is not a result; the table is.
