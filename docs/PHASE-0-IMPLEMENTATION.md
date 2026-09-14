# Phase 0 — Implementation Guide

What Phase 0 built, how to run it, and where its boundaries are. Product decisions live in
[PRODUCT-SPEC.md](PRODUCT-SPEC.md); the phase sequence in [PHASE-PLAN.md](PHASE-PLAN.md); open
owner decisions in [DECISIONS-REQUIRED.md](DECISIONS-REQUIRED.md).

---

## 1. Architecture

```
Browser ──► Next.js 16 (App Router, standalone)          src/app/**, src/proxy.ts
               │  pages & route handlers call SERVICES only
               ▼
            Server domain layer                          src/server/**
               ├─ env.ts            fail-fast env validation, no fallbacks
               ├─ db.ts             single PrismaClient from validated env
               ├─ auth/             NextAuth (JWT carries user id ONLY)
               ├─ tenant/           membership resolved from DB per request; guards
               ├─ audit/            AuditLog writer
               ├─ registration/     atomic User+Business+OWNER+Main location
               └─ ledger/           the only writer of LoyaltyOperation
                    ├─ ledger.ts         appendOperationGroup, reverseOperationGroup
                    ├─ idempotency.ts    runIdempotent (reserve-then-execute)
                    ├─ reconciliation.ts ledger vs projection comparison
                    └─ visits.ts         countsAsVisit policy
               ▼
            PostgreSQL 15  ◄──── pg-boss worker (separate process)   src/worker/**
              • public schema: Prisma-managed, one squashable migration
              • pgboss schema: managed by pg-boss itself
              • triggers: append-only ledger, frozen ProgramVersion mechanics
              • partial unique indexes: one ACTIVE version/template, one default location/business
```

### Rules the code enforces

| Rule | Where |
|---|---|
| No secret fallbacks; refuse known-burned secrets; report variable names only | `src/server/env.ts`, `src/instrumentation.ts`, `src/worker/index.ts` |
| Session token holds only `sub` (user id) | `src/server/auth/options.ts`, `src/types/next-auth.d.ts` |
| Membership, role, permissions, location scope resolved from DB every request | `src/server/tenant/context.ts` |
| Every business-scoped query includes `businessId` | services in `src/server/**`; tests in `tests/integration/tenant-guard.test.ts` |
| Ledger rows are never updated or deleted — two layers | runtime role has no `UPDATE/DELETE/TRUNCATE` privilege (`scripts/db-roles.mjs`, proved by `tests/integration/runtime-role.test.ts`); PostgreSQL triggers refuse even the owner (`prisma/migrations/*/migration.sql`) |
| Eight tables are append-only under the same two layers: the ledger, consent history, campaign revisions, campaign approvals, audience snapshots and their members, referral attributions and promotion redemptions | `APPEND_ONLY_TABLES` in `scripts/db-roles.mjs` grants only `SELECT`/`INSERT`; a PL/pgSQL trigger per table refuses even the owner. Both refusals are asserted in `tests/integration/runtime-role.test.ts` and in the feature suites |
| A campaign approval cannot be set, only recorded | `APPROVED` and `WITHDRAWN` are written solely by `src/server/campaigns/approvals.ts`; `/api/staff/campaigns` `setState` lists the three merchant-driven states literally and refuses the rest |
| An audience snapshot carries no contact data and no capability value | `CampaignAudienceMember` has columns for a profile reference and a consent observation and nothing else; asserted by serialising the rows and searching for the real phone, serial and tokens |
| Nothing in the product can deliver a message | `src/server/campaigns/delivery.ts` is the only delivery-shaped module and its sole implementation throws before reading anything; a source scan asserts no `fetch`, provider SDK, queue or timer exists under `src/server/campaigns` or `src/server/consent` |
| A card's invitation capability is stored as a digest, never as a value | `CardShareLink.tokenDigest` is SHA-256 of 32 random bytes; the raw token exists in the wallet pass built from it and nowhere else, and neither the token nor the digest reaches an audit row |
| That capability never reaches a server log | it travels in a URL fragment, which is not sent with a request; the page posts it in a body, and the browser suite records every request made while opening the page and asserts the token is in none of their URLs |
| Opening an invitation is not recorded | `/api/share/resolve` writes nothing — no audit row, no counter, no IP, no rate-limit state — and answers every failure in one identical shape |
| An issued capability can be revoked but never erased or rewritten | `NO_DELETE_TABLES` in `scripts/db-roles.mjs` grants SELECT/INSERT/UPDATE and never DELETE/TRUNCATE; `card_share_link_revoke_only` permits `revokedAt` NULL→value once and freezes every other column |
| A presented invitation is resolved and discarded | the capability reaches the server only in the body of the authenticated counter enrolment, is hashed, and only a row id is kept; neither it nor its digest reaches `ReferralAttribution`, an audit row, a response or a screen |
| Staff are never told who referred whom | every refusal answers one generic value, and nothing exported from `src/server/share/referrals.ts` returns a referrer's name, card or link |
| A referral attribution can credit nobody | the table has no amount, currency, points, reward, eligibility or expiry column, asserted by a column-name check in `tests/integration/share-links.test.ts` |
| A coupon code is stored as a salted digest, never as a value | `Promotion.codeDigest` is `sha256(codeSalt ‖ businessId ‖ normalised code)` with a 32-byte salt per promotion, because a spoken four-to-sixty-four character code is not 256 bits of entropy; the raw code lives only in the body of the authenticated request that carried it, and neither it nor the digest reaches an audit row, a response, a log or a screen |
| No selection anywhere reads a code back out | `PROMOTION_SELECT` in `src/server/promotions/promotions.ts` lists its columns literally and omits `codeDigest` and `codeSalt`; there is no reveal route, and the browser suite asserts the digest does not appear in the rendered HTML |
| Every ineligible coupon answers the same way | `redeemCoupon` returns one `NOT_ACCEPTED` value for unknown, malformed, draft, paused, expired, out-of-window, exhausted, already-used and cross-tenant, and a catch-all returns it for anything unforeseen; a bad coupon never fails the enrolment it was typed into |
| A promotion redemption cannot alter anything but itself | the module imports no ledger, points, stamp, campaign, consent, wallet or referral verb; the table has no amount, currency, points or balance column, asserted by a column-name check in `tests/integration/promotion-integrity.test.ts` |
| A redemption cannot exceed its limits under concurrency | `SELECT … FOR UPDATE` on the promotion inside the transaction, a re-read after the lock, and `promotion_redemption_validate` recounting from the table as a backstop for a caller that forgets the lock |
| A redemption is withdrawn by a second row, never by an edit | `PromotionRedemption` is in `APPEND_ONLY_TABLES`; the trigger requires a `VOIDED` row to be a faithful copy of the `REDEEMED` row it names, and a partial unique index allows one void per redemption |
| A redemption's event time is the server's, not the caller's | `walaaplus_validate_redemption` assigns `recordedAt` from `now() AT TIME ZONE 'UTC'` before the window checks read it, on `REDEEMED` and `VOIDED` alike; nothing in this phase can import, backdate or future-date one, proved by direct runtime-role inserts a year either side of now |
| A promotion's canonical name cannot be set apart from its name | `walaaplus_promotion_guard` computes `normalizedName` from `name` and assigns it on every insert and update, so the unique index that reads it cannot be hidden from; an expired row refuses the edit with an error rather than a correction |
| Two concurrent creates cannot both claim one code | `createPromotion` takes `pg_advisory_xact_lock` inside its transaction and re-reads behind it; the key is derived from the business id and never from the code, and is never stored |
| Tracked source stays reviewable | no tracked `.ts`/`.sql`/`.json`/`.md` file contains a physical U+0000 byte, checked over `git ls-files` in `tests/unit/source-text-encoding.test.ts` — one such byte makes Git call a file binary, and diff, blame, grep and pull-request review all skip it |
| A promotion can be expired but never deleted | `Promotion` is in `NO_DELETE_TABLES`; `promotion_guard` freezes id, business, code digest, salt, creator and creation time, forces `DRAFT` on insert, and allows only the transitions that exist |
| Ledger writes carry a verified actor: business and user are derived from `TenantContext` or an explicit system actor, never from input | `src/server/ledger/actor.ts`, `appendOperationGroup` |
| Cashiers write only at assigned locations; an unassigned cashier has no access; OWNER/MANAGER unrestricted | `src/server/tenant/context.ts` (`requireLocationAccess` inside the ledger transaction) |
| One reversal per original operation, even under concurrency | card lock before the reversal check + partial unique index on `reversalOfOperationId` |
| RewardTier frozen with its ProgramVersion; `cardType` locked after activation or issued card; a group's tiers must belong to the card's pinned version | triggers `reward_tier_protect`, `program_template_protect_card_type`; tier check in `appendOperationGroup` |
| Card balances are projections refreshed in the same transaction as the ledger insert, under `SELECT … FOR UPDATE` | `src/server/ledger/ledger.ts` |
| Corrections are compensating rows; negative balances rejected | `reverseOperationGroup` |
| Idempotency reserved BEFORE the work, in the same transaction | `src/server/ledger/idempotency.ts` |
| `countsAsVisit` decided from kind × source × version setting × explicit intent, frozen at write time; API/automation awards and every integration award must state intent | `src/server/ledger/visits.ts` |
| Privileged changes audited in the same transaction | `src/server/audit/audit.ts` |

### Routing protection

`src/proxy.ts` replaces the deprecated `middleware` convention (Next 16). It answers one question
only — is a merchant signed in? — and redirects to `/{locale}/auth/login` otherwise. Public patterns
already declared for later phases: `/`, `/pricing`, `/auth/*`, `/join/*`, `/card/*`, `/scanner/login`.
No customer pages exist yet; the rules exist so they can never redirect a customer to a merchant login.

---

## 2. Local setup

Prerequisites: Node 24 (`.nvmrc`), Docker Desktop, npm 11.

```bash
cp .env.example .env            # then fill values; nothing in .env.example is a real value
npm ci
docker compose up -d db         # application database on 127.0.0.1:${POSTGRES_PORT:-5433}
npm run db:migrate              # apply committed migrations AS THE MIGRATOR (MIGRATE_DATABASE_URL)
npm run db:roles                # create/refresh the restricted runtime role named in DATABASE_URL
npm run db:seed                 # optional dev owner; refuses NODE_ENV=production
npm run dev                     # web on :3000, connects as the runtime role
npm run worker:dev              # worker, separate terminal, /health on :8081
```

`.env` variables the web and worker require: `DATABASE_URL` (**runtime role**), `NEXTAUTH_SECRET`
(≥ 32 chars, generate with `openssl rand -base64 48`), `NEXTAUTH_URL`. Optional: `NEXT_PUBLIC_APP_URL`,
`WORKER_HEALTH_PORT`. Migrations and grants only: `MIGRATE_DATABASE_URL` (**owner/migrator role**).
Compose-only: `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`, `POSTGRES_PORT`, `TEST_POSTGRES_PORT`,
`APP_DB_USER`, `APP_DB_PASSWORD`. Tests: `TEST_MIGRATE_DATABASE_URL` (migrator), `TEST_DATABASE_URL`
(runtime). Seed: `SEED_OWNER_EMAIL`, `SEED_OWNER_PASSWORD`.

The full annotated list is `.env.example`. Never commit `.env`.

---

## 3. Worker

The worker is a **separate process and container**. It never runs inside a request and the web
process never schedules work itself.

| Command | Purpose |
|---|---|
| `npm run build:worker` | compile `src/worker/index.ts` to `dist/worker/index.mjs` with esbuild (ESM bundle; pg-boss, pg and Prisma stay external) |
| `npm run worker` | start the compiled bundle — what the container runs, no TypeScript loader |
| `npm run worker:dev` | tsx watch, restart on change (development only) |
| `GET :8081/health`, `/ready` | 200 once pg-boss started, 503 while connecting. Served on the container's own port, **not published**: probe it from inside with `docker compose exec worker wget -qO- http://localhost:8081/health` |
| `docker compose --profile app up worker` | containerised (needs a build) |

The worker image (`Dockerfile --target worker`) contains production `node_modules`, the generated
Prisma client and the bundle — no source tree, no `tsx`, no dev dependencies. The gate builds the
bundle on every run. The worker connects as the runtime role and never needs `CREATE` on the
database: the `pgboss` schema is created for it by `npm run db:roles` (`createSchema: false`).

Registered queues in Phase 0: `system.smoke` only — a harmless job proving connectivity and
processing. Business jobs (expiry, birthday, reconciliation, push) arrive with their phases, each
as its own module under `src/worker/jobs/`.

pg-boss stores its state in the `pgboss` schema of the application database. Prisma does not manage
that schema and `prisma migrate status` ignores it.

---

## 4. Migration policy

- Migrations: `20260911000000_foundation` (generated with `prisma migrate diff --from-empty` and extended
  by hand with the triggers and partial unique indexes Prisma cannot express), `20260911120000_reversal_unique`,
  `20260911120100_program_integrity`, `20260911120200_utm_unique_name` (Prompt 0.2 remediation).
- **Until the Phase 1a engineering gate passes, migrations may be squashed** into one file.
  There is no deployed database to protect.
- **After the first pilot database is deployed, migrations are forward-only.** Never edit an applied
  migration; add a new one.
- `npm run db:migrate` (= `prisma migrate deploy` as the migrator role) is the only command used
  against shared databases. `npm run db:migrate:dev` and `db push` are local-only. Never call the
  Prisma CLI with the runtime `DATABASE_URL`: that role cannot create or alter tables, by design.
- Every `db:migrate` is followed by `npm run db:roles`, which grants the runtime role on any new
  tables. Both run inside the Compose `migrate` service and inside the gate.
- Schema ⇄ migration parity is enforced by the gate: `migrate deploy` then `migrate status` must
  report "up to date". `prisma migrate diff --from-migrations` is deliberately **not** used because it
  cannot represent the hand-written partial indexes and would report false drift.

### Database roles

Every environment — developer machine, the disposable test database, CI, staging, production — has
**two** PostgreSQL roles. The application never holds the credentials of the first.

| Role | Variable | Who uses it | Can | Cannot |
|---|---|---|---|---|
| **migrator / owner** | `MIGRATE_DATABASE_URL` (tests: `TEST_MIGRATE_DATABASE_URL`) | `npm run db:migrate`, `npm run db:roles`, the Compose `migrate` service, the test harness | own and alter every table, apply migrations, grant | mutate the ledger — the trigger refuses even the owner |
| **runtime** (`walaaplus_app` by default) | `DATABASE_URL` (tests: `TEST_DATABASE_URL`) | web, worker, every service under test | `SELECT/INSERT/UPDATE/DELETE` on application tables; `SELECT, INSERT` on `LoyaltyOperation`; own the `pgboss` schema | `UPDATE/DELETE/TRUNCATE` the ledger, `ALTER` any table, disable or drop a trigger, replace a trigger function, drop an index, `SET session_replication_role`, `SET ROLE` to the migrator, create anything in `public`, read or write `_prisma_migrations` |

`scripts/db-roles.mjs` (`npm run db:roles`) is the single source of the grants. It connects with
`MIGRATE_DATABASE_URL`, reads the runtime role's **name and password from `DATABASE_URL`** (so a
credential lives in exactly one place), and idempotently:

1. creates the role if missing and applies `LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT
   NOREPLICATION NOBYPASSRLS` plus the password;
2. grants `CONNECT`, `USAGE` on `public` (never `CREATE`), `SELECT/INSERT/UPDATE/DELETE` on all
   tables and sequences, and the same as *default privileges* for tables future migrations create;
3. revokes everything on the append-only tables (`APPEND_ONLY_TABLES` in the script — add any new
   append-only table there in the same commit as its migration) and re-grants `SELECT, INSERT`;
4. revokes everything on `_prisma_migrations`;
5. creates the `pgboss` schema owned by the runtime role and transfers any pre-existing `pgboss`
   objects to it (an environment whose worker once ran as the owner);
6. verifies the result with `has_table_privilege()` / `has_schema_privilege()` and exits non-zero
   on any discrepancy. It prints role and table names only, never a password or URL.

The migrator must be a superuser or hold `CREATEROLE`. Two layers therefore stand between any code
path and ledger history: the runtime role has **no privilege** to mutate it, and even the owner is
refused by the trigger. `tests/integration/runtime-role.test.ts` proves the first layer by
connecting as the runtime role and attempting twenty-nine distinct bypasses; every one fails with a
privilege error, and a snapshot taken as the owner confirms row, triggers, function and indexes are
unchanged. `database-protection.test.ts` proves the second layer as the owner.

**Staging and production (owner action):** provision the migrator credential and choose a runtime
password, put them in `MIGRATE_DATABASE_URL` and `DATABASE_URL` of the deployment environment, then
run `npm run db:migrate && npm run db:roles` (or start the Compose `migrate` service). The agent
never holds or requests those values.

---

## 5. Test strategy

| Project | Where | Database | Runs in gate |
|---|---|---|---|
| `unit` | `tests/unit/**` | none | yes |
| `integration` | `tests/integration/**` | **real PostgreSQL** at `TEST_DATABASE_URL`, connected as the **runtime role** | yes |
| Playwright e2e | `tests/*.spec.ts`, `npm run test:e2e` | running app | **no** — Phase 1a onward |

Integration harness (`tests/setup/`):

- `integration-global.ts` runs once, as the migrator (`TEST_MIGRATE_DATABASE_URL`): validates both test
  URLs (database name must contain `test`, same host and database, different roles, neither equal
  to an application URL), applies migrations with `scripts/db-migrate.mjs`, then creates the runtime
  role with `scripts/db-roles.mjs`.
- `integration-env.ts` runs in every worker: sets `DATABASE_URL` to `TEST_DATABASE_URL` so every
  service under test connects **as the restricted runtime role**, exactly like web and worker, and
  sets test-only fixtures for required variables. The fixture secret is a constant string that
  never leaves tests.
- `fixtures.ts`: `migratorPrisma()` is a second client connected as the owner. `resetDatabase()` uses
  it to truncate all tables — because the ledger blocks TRUNCATE by trigger, it disables the *user*
  trigger for that statement, an action the runtime role cannot take (proved in
  `runtime-role.test.ts`). Tests also use it to verify, from the owner's side, that a refused
  bypass really changed nothing.

Concurrency and idempotency are tested with real parallel transactions against PostgreSQL, never
with mocks: 25 concurrent appends must yield `balanceAfter` exactly 1..25; 8 concurrent idempotent
calls must execute the work exactly once.

---

## 6. The gate

```bash
npm run gate
```

Runs in order and stops at the first failure: clean `.next` → `npm audit --omit=dev --audit-level=high`
→ `prisma generate` → lint (`--max-warnings=0`) → typecheck → `prisma validate` → unit tests →
test-db up → `migrate deploy` (migrator role) → `migrate status` → `db-roles` (runtime role grants,
must print `OK role`) → integration tests (as the runtime role) → worker build → `next build`.

**Lint fails on warnings.** A warning is a defect nobody has triaged yet; allowing a backlog of
them is how a codebase stops reading its own linter output. The rule is never weakened to make a
warning go away — the code is fixed, or the rule is wrong and is changed deliberately.

**The audit gate covers production dependencies** (`--omit=dev`), because that is what ships in an
image. The FULL `npm audit`, dev tooling included, is also clean as of Prompt 0.3 and is checked by
hand each prompt; critical and high findings are fixed by targeted upgrades or version-scoped npm
`overrides`, never by `npm audit fix --force` and never by an allowlist or suppression file. Prints a per-step PASS/FAIL table. Set
`GATE_SKIP_DOCKER=1` when a database is provided externally (CI service container).

CI: `.github/workflows/gate.yml` runs the identical command on `rebuild/**` pushes and pull requests
against a throwaway PostgreSQL service. It uses **no secrets**: the CI database passwords (migrator
`ci`, runtime `walaaplus_app`) are ephemeral fixtures and `NEXTAUTH_SECRET` is generated fresh per run
and discarded. The runtime role is created inside the run by the gate's `db-roles` step. CI **never
deploys**.

---

## 7. Deployment boundary

| The agent produces | The owner performs |
|---|---|
| `Dockerfile` (targets `migrate`, `web`, `worker`), `docker-compose.yml`, CI workflow | Provisioning servers, domains, TLS certificates |
| Scripts, runbooks, variable names | Creating and storing every real secret |
| Migration files, `scripts/db-migrate.mjs`, `scripts/db-roles.mjs` | Running `npm run db:migrate && npm run db:roles` against staging/production |
| Health endpoints | Configuring monitoring and backups |
| — | Pushing to `master`; every deployment |

Container topology: `proxy` (Caddy, `deploy/Caddyfile`, the only service on a public interface) → `web` (Next
standalone) + `worker` (compiled pg-boss bundle) → `postgres`, with a one-shot `migrate` container
that must **complete successfully before web and worker start** (`depends_on: condition: service_completed_successfully`). It runs `db-migrate deploy`
then `db-roles` as the migrator; it is the only container that ever receives `MIGRATE_DATABASE_URL`.
Web and worker therefore cannot start against an unmigrated database, and never hold owner credentials.
Service workers, installability and web push require HTTPS, so **staging needs a real certificate
before Phase 1a Prompt 2** (decision B3).

---

## 8. Owner-only infrastructure actions

Tracked with status in [DECISIONS-REQUIRED.md](DECISIONS-REQUIRED.md). Blocking the next steps:

- **A1** permission to push `rebuild/*` (never `master`)
- **A2** make the public repository private
- **A3–A5** CI provider, database approach, Node 24 pin — implemented locally per recommendation, **not marked approved**
- **B1–B6** hosting, domains, staging TLS, secrets provisioning, deployment authority — before Phase 1a Prompt 2
- Provision the migrator and runtime database credentials for staging and production and run
  `npm run db:migrate && npm run db:roles` there (§4 "Database roles")


---

## 9. Authentication rate limiting

Enforced in **PostgreSQL**, not in process memory: an in-process counter resets on restart and is
per replica, and the staging design must not depend on there being exactly one web process.

| Surface | Windows | Response when exhausted |
|---|---|---|
| `POST /api/auth/register` | per submitted email, **and** per client address where one is trustworthy | `429` with `Retry-After`, fixed body text |
| Credential sign-in | per identifier, **and** per client address where one is trustworthy | NextAuth's generic sign-in failure |

The email window exists because the address window cannot be relied upon everywhere: see
"Trusting the client address" below. Registration stays limited either way.

One row per `(scope, keyHash)` in `AuthRateLimit` holds a fixed window. Enforcement is a single
`INSERT … ON CONFLICT (scope, keyHash) DO UPDATE … RETURNING` statement: PostgreSQL takes a row
lock on the conflicting row, so simultaneous attempts serialise and the counter is exact. There is
no read-then-write window for a burst of parallel requests to slip through, which
`tests/integration/auth-rate-limit.test.ts` proves by firing three times the limit in parallel and
asserting exactly `max` are allowed and every attempt was counted once.

**What is stored.** `keyHash` is an HMAC-SHA256 of the *normalised* identifier (trimmed,
lower-cased) keyed with a pepper — `AUTH_RATE_LIMIT_PEPPER`, or one derived from `NEXTAUTH_SECRET`
when that is unset. The table answers "has this key been seen too often" without being a readable
list of who tried to sign in, and a dictionary of email addresses cannot be matched against it.
Normalising first means capitalisation or padding cannot multiply an attacker's allowance.

**Windows and expiry.** A refused attempt is counted but never extends the window, so nobody can
hold a legitimate user out indefinitely. A successful sign-in forgets that identifier's window
(a user who mistyped twice is not punished for succeeding) while the address window stays, so one
host cannot mint unlimited attempts by interleaving valid sign-ins. Expired rows are removed by
`pruneExpiredRateLimits()` in bounded batches of 1,000, triggered on a 2% sample of new windows;
`AuthRateLimit_expiresAt_idx` keeps the sweep off a sequential scan. The function is exported so a
scheduled worker job can own it outright once the job runner takes on business jobs in Phase 1.5.

**Auditing.** The first refusal of each window writes one `auth.rate_limited` audit row carrying
the scope, the limit, the window length and a 12-character prefix of the keyed hash — enough to
correlate repeated refusals, not enough to recover the identifier. No email, no address, no
credential. Only the first refusal is audited, so one request cannot be turned into unbounded
audit writes. An audit failure never turns a refusal into a 500.

### NextAuth's flow, and what it does and does not allow

NextAuth owns `/api/auth/callback/credentials`; the application does not wrap that route. The
single hook it exposes is the provider's `authorize`, so that is where the limit is enforced —
**before** the user lookup and **before** `bcrypt.compare`, so a flood of guesses cannot be turned
into a flood of password hashes. Consequences, accepted deliberately:

- A refused sign-in returns `null`, which NextAuth renders as its generic sign-in failure. The
  caller gets **no `429` and no `Retry-After`** on this path. Returning one would require owning
  the callback route, which is a Phase 1a decision once the real sign-in UI exists.
- That same genericity is the account-enumeration defence: a wrong password, an unknown account,
  a deactivated account and an exhausted window are indistinguishable to the caller.
- `authorize` receives the request headers, so the client address comes from `x-forwarded-for`
  (first entry — the app sits behind one reverse proxy) or `x-real-ip`. When no address is
  present the identifier window still applies, so a missing header is not a bypass.

### Registration does not reveal whether an account exists

`POST /api/auth/register` answers a submission for an **existing** email exactly as it answers one
that creates a new account: `202` with the same fixed body, no `businessId`, no `Location`, the
same header set. The service still raises `ConflictError` internally — the seed and future admin
paths need the truth — and the route, which is the public boundary, flattens it.

The response carries no identifier of anything created, so there is nothing to compare between
the two outcomes. `registerBusinessOwner` also hashes the password **before** it opens its
transaction, so the duplicate path does not skip the dominant cost of the request.

That last point is a design property, not a measured one: the two paths do different amounts of
database work after the hash, and **no statistical timing analysis has been done**. Treat response
time as an unquantified side channel rather than a closed one. Closing it properly belongs with
the verification-email flow in Phase 1a, where the response stops depending on the outcome at
all.

The caller is told to sign in, which works for exactly one of the two people who can see that
response: whoever holds the password for that address. When the email provider of decision D3
arrives in Phase 1a this becomes the usual "check your inbox", and the existing-account case is
told so by email rather than over HTTP. Malformed input keeps its own `400`: input shape describes
the request, not the account.

### Trusting the client address

`X-Forwarded-For` and `X-Real-IP` are ordinary request headers. If the application is reachable
directly, a caller sets a different value on every request, and any per-address limit becomes
decoration rather than a control. The boundary is therefore explicit on both sides:

- **`TRUST_PROXY_HEADERS` defaults to `false`.** With it off, the headers are ignored *entirely*
  and the application reports **no** client address. No address is better than a forgeable one,
  because a forgeable one silently converts a per-address limit into no limit at all. This is why
  registration and sign-in both carry an identifier window that needs no address.
- **With it on, the value taken is the LAST hop** of `X-Forwarded-For`. Anything earlier in the
  list arrived with the request and is attacker-controlled; the final entry is the one our own
  proxy appended or set. The value must parse as an IPv4 or IPv6 address — junk is discarded, so
  arbitrary text can never become a rate-limit key.
- **Only the Compose `proxy` service justifies turning it on.** `deploy/Caddyfile` SETS
  `X-Forwarded-For`, `X-Real-IP`, `X-Forwarded-Proto` and `X-Forwarded-Host` from the connection
  it actually received, and strips `Forwarded`, `X-Forwarded-Server`, `X-Client-IP`,
  `CF-Connecting-IP` and `True-Client-IP` outright. `web` is **not** published to the host — only
  `proxy` is (`WEB_PORT`, default 8080) — so there is no path to the application that bypasses it.

#### What each service publishes

A Compose mapping written `"5433:5432"` binds **0.0.0.0**, which on a VPS is every interface
including the public one. Only the proxy may do that.

| Service | Binding | Why |
|---|---|---|
| `proxy` | `${WEB_PORT:-8080}:80` — **public** | the entry point; the only thing meant to be reachable |
| `db` | `127.0.0.1:${POSTGRES_PORT:-5433}:5432` — loopback | host tooling: `prisma migrate`, `psql`, `npm run db:seed`. Production can drop this mapping entirely, since `web`, `worker` and `migrate` reach the database over the Compose network |
| `test-db` | `127.0.0.1:${TEST_POSTGRES_PORT:-5435}:5432` — loopback | the integration suite runs on the host |
| `web` | `expose: 3000` — container only | reached through `proxy`; see above |
| `worker` | `expose: 8081` — container only | the health endpoint exists for the orchestrator, which probes it from inside the container |
| `migrate` | none | runs to completion and exits |

`tests/unit/compose-exposure.test.ts` parses `docker-compose.yml` on every gate run and fails if
any service other than `proxy` gains a public binding, if a loopback service loses its
`127.0.0.1` prefix, or if `web`, `worker` or `migrate` publish anything at all. It needs no Docker
daemon, and it masks `${VAR:-default}` before splitting a mapping — the colon inside the default
would otherwise make a public `"${POSTGRES_PORT:-5433}:5432"` look like a bound `ip:host:container`.

A deployment that exposes the app directly must leave `TRUST_PROXY_HEADERS` unset. It then has no
per-address limiting, by design and visibly, rather than a limit that looks present and is not.
---

## 10. Removed in this phase

Deleted from the working branch (all preserved in tag `prototype-baseline`): the prototype Prisma
schema and seed, `src/lib/auth.ts`, `src/lib/prisma.ts`, `src/middleware.ts`, every route under
`src/app/api/**` except NextAuth, and the mock pages that called those routes. Static marketing and
shell pages remain as visual reference until Phase 1a rebuilds them. Dependencies used only by the
wallet stubs (`google-auth-library`, `passkit-generator`) were removed.

The dashboard sidebar (`src/components/dashboard/Sidebar.tsx`) lists only routes in its
`IMPLEMENTED_ROUTES` set — currently the dashboard home. The remaining mock pages are unreachable
from navigation until the commit that implements each one adds its route.

See §9 for authentication rate limiting.
