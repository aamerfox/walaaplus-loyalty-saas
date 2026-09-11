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
| Ledger rows are never updated or deleted | PostgreSQL triggers in `prisma/migrations/*/migration.sql` |
| Card balances are projections refreshed in the same transaction as the ledger insert, under `SELECT … FOR UPDATE` | `src/server/ledger/ledger.ts` |
| Corrections are compensating rows; negative balances rejected | `reverseOperationGroup` |
| Idempotency reserved BEFORE the work, in the same transaction | `src/server/ledger/idempotency.ts` |
| `countsAsVisit` frozen at write time | `src/server/ledger/visits.ts` |
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
docker compose up -d db         # application database on ${POSTGRES_PORT:-5433}
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
| `GET :8081/health`, `/ready` | 200 once pg-boss started, 503 while connecting |
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

- One migration, `20260911000000_foundation`, generated with `prisma migrate diff --from-empty` and
  extended by hand with the triggers and partial unique indexes Prisma cannot express.
- **Until the Phase 1a engineering gate passes, migrations may be squashed** into this single file.
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
→ `prisma generate` → lint → typecheck → `prisma validate` → unit tests → test-db up → `migrate deploy`
(migrator role) → `migrate status` → `db-roles` (runtime role grants, must print `OK role`) →
integration tests (as the runtime role) → `next build`. Prints a per-step PASS/FAIL table. Set
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

Container topology: `caddy/nginx (TLS)` → `web` (Next standalone) + `worker` (compiled pg-boss bundle)
→ `postgres`, with a one-shot `migrate` container that must **complete successfully before web and
worker start** (`depends_on: condition: service_completed_successfully`). It runs `db-migrate deploy`
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

## 9. Removed in this phase

Deleted from the working branch (all preserved in tag `prototype-baseline`): the prototype Prisma
schema and seed, `src/lib/auth.ts`, `src/lib/prisma.ts`, `src/middleware.ts`, every route under
`src/app/api/**` except NextAuth, and the mock pages that called those routes. Static marketing and
shell pages remain as visual reference until Phase 1a rebuilds them. Dependencies used only by the
wallet stubs (`google-auth-library`, `passkit-generator`) were removed.

The dashboard sidebar (`src/components/dashboard/Sidebar.tsx`) lists only routes in its
`IMPLEMENTED_ROUTES` set — currently the dashboard home. The remaining mock pages are unreachable
from navigation until the commit that implements each one adds its route.

`POST /api/auth/register` is rate limited per client address (10 attempts / 15 minutes, HTTP 429
with `Retry-After`) by an in-process fixed-window limiter (`src/server/rate-limit.ts`). It is
per web replica; a shared store replaces it when the platform runs more than one replica.
