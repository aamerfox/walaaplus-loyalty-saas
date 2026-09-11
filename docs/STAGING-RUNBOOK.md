# Staging Deployment Runbook

How to bring WalaaPlus up on a staging server over HTTPS, verify it, back it up, and roll it back.

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
openssl rand -base64 48   # NEXTAUTH_SECRET
openssl rand -base64 24   # POSTGRES_PASSWORD      (the migrator/owner role)
openssl rand -base64 24   # APP_DB_PASSWORD        (the restricted runtime role)
```

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

## 12. After staging is live: the real-device checklist

These are the checks that HTTPS staging exists in order to make possible. **The owner performs
them on physical phones.** Record who ran each one and what happened in
`docs/evidence/phase-1a-prompt-2.md`; do not mark any of them as automated.

| # | Check | Device | Expected |
|---|---|---|---|
| 1 | Android Chrome offers "Install app" on a card page | Android | The prompt appears; the installed icon opens the card standalone, with no browser chrome |
| 2 | iOS Safari "Add to Home Screen" | iPhone | Standalone card with the right name and icon |
| 3 | Three cards from three businesses install as three separate icons | Android | Three icons, three scopes; opening one never shows another's balance |
| 4 | Real camera scan of a printed card QR | Android | The scanner resolves the customer and can award a stamp |
| 5 | Camera permission denied | Android | The scanner falls back to phone lookup with no dead end |
| 6 | Service worker caches nothing | Either, DevTools | Application → Cache Storage is empty; no cached card responses |
| 7 | Arabic RTL and English LTR | Both | Layout correct in both locales at phone width |

Only when 1 through 7 have been performed and recorded may Phase 1a Prompt 2 be called complete.
