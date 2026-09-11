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
npx prisma migrate deploy       # apply the committed migration
npm run db:seed                 # optional dev owner; refuses NODE_ENV=production
npm run dev                     # web on :3000
npm run worker:dev              # worker, separate terminal, /health on :8081
```

`.env` variables the web and worker require: `DATABASE_URL`, `NEXTAUTH_SECRET` (≥ 32 chars, generate
with `openssl rand -base64 48`), `NEXTAUTH_URL`. Optional: `NEXT_PUBLIC_APP_URL`, `WORKER_HEALTH_PORT`.
Compose-only: `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`, `POSTGRES_PORT`, `TEST_POSTGRES_PORT`.
Tests: `TEST_DATABASE_URL`. Seed: `SEED_OWNER_EMAIL`, `SEED_OWNER_PASSWORD`.

The full annotated list is `.env.example`. Never commit `.env`.

---

## 3. Worker

The worker is a **separate process and container**. It never runs inside a request and the web
process never schedules work itself.

| Command | Purpose |
|---|---|
| `npm run worker` | start (tsx) |
| `npm run worker:dev` | restart on change |
| `GET :8081/health`, `/ready` | 200 once pg-boss started, 503 while connecting |
| `docker compose --profile app up worker` | containerised (needs a build) |

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
- `prisma migrate deploy` is the only command used against shared databases. `migrate dev` and
  `db push` are local-only.
- Schema ⇄ migration parity is enforced by the gate: `migrate deploy` then `migrate status` must
  report "up to date". `prisma migrate diff --from-migrations` is deliberately **not** used because it
  cannot represent the hand-written partial indexes and would report false drift.

### Runtime database role (owner action, staging and production)

The trigger already rejects ledger mutation for every role. Defence in depth is to also deny the
privilege. The owner runs, once per environment, with a superuser:

```sql
-- app role used by web and worker
REVOKE UPDATE, DELETE, TRUNCATE ON "LoyaltyOperation" FROM walaaplus_app;
-- migrations run as a different, privileged role
```

Role names are environment-specific and therefore not in the migration.

---

## 5. Test strategy

| Project | Where | Database | Runs in gate |
|---|---|---|---|
| `unit` | `tests/unit/**` | none | yes |
| `integration` | `tests/integration/**` | **real PostgreSQL** at `TEST_DATABASE_URL` | yes |
| Playwright e2e | `tests/*.spec.ts`, `npm run test:e2e` | running app | **no** — Phase 1a onward |

Integration harness (`tests/setup/`):

- `integration-global.ts` runs once: validates `TEST_DATABASE_URL` (must contain `test`, must differ
  from `DATABASE_URL`) and applies migrations.
- `integration-env.ts` runs in every worker: points Prisma at the test database and sets test-only
  fixtures for required variables. The fixture secret is a constant string that never leaves tests.
- `fixtures.ts`: `resetDatabase()` truncates all tables. Because the ledger blocks TRUNCATE by trigger,
  the harness disables the *user* trigger for that statement — an action only the table owner can
  take, which is the point.

Concurrency and idempotency are tested with real parallel transactions against PostgreSQL, never
with mocks: 25 concurrent appends must yield `balanceAfter` exactly 1..25; 8 concurrent idempotent
calls must execute the work exactly once.

---

## 6. The gate

```bash
npm run gate
```

Runs in order and stops at the first failure: clean `.next` → `prisma generate` → lint → typecheck →
`prisma validate` → unit tests → test-db up → `migrate deploy` → `migrate status` → integration tests
→ `next build`. Prints a per-step PASS/FAIL table. Set `GATE_SKIP_DOCKER=1` when a database is
provided externally (CI service container).

CI: `.github/workflows/gate.yml` runs the identical command on `rebuild/**` pushes and pull requests
against a throwaway PostgreSQL service. It uses **no secrets**: the CI database password is an
ephemeral fixture and `NEXTAUTH_SECRET` is generated fresh per run and discarded. CI **never deploys**.

---

## 7. Deployment boundary

| The agent produces | The owner performs |
|---|---|
| `Dockerfile` (targets `web`, `worker`), `docker-compose.yml`, CI workflow | Provisioning servers, domains, TLS certificates |
| Scripts, runbooks, variable names | Creating and storing every real secret |
| Migration files | Running `prisma migrate deploy` against staging/production |
| Health endpoints | Configuring monitoring and backups |
| — | Pushing to `master`; every deployment |

Container topology: `caddy/nginx (TLS)` → `web` (Next standalone) + `worker` (pg-boss) → `postgres`.
Service workers, installability and web push require HTTPS, so **staging needs a real certificate
before Phase 1a Prompt 2** (decision B3).

---

## 8. Owner-only infrastructure actions

Tracked with status in [DECISIONS-REQUIRED.md](DECISIONS-REQUIRED.md). Blocking the next steps:

- **A1** permission to push `rebuild/*` (never `master`)
- **A2** make the public repository private
- **A3–A5** CI provider, database approach, Node 24 pin — implemented locally per recommendation, **not marked approved**
- **B1–B6** hosting, domains, staging TLS, secrets provisioning, deployment authority — before Phase 1a Prompt 2
- Apply the runtime-role `REVOKE` above on staging and production databases

---

## 9. Removed in this phase

Deleted from the working branch (all preserved in tag `prototype-baseline`): the prototype Prisma
schema and seed, `src/lib/auth.ts`, `src/lib/prisma.ts`, `src/middleware.ts`, every route under
`src/app/api/**` except NextAuth, and the mock pages that called those routes. Static marketing and
shell pages remain as visual reference until Phase 1a rebuilds them. Dependencies used only by the
wallet stubs (`google-auth-library`, `passkit-generator`) were removed.
