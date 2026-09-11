# Evidence — Phase 0, Prompt 0.2

**Prompt:** Secure Foundation and Ledger Schema
**Date:** 2026-09-11
**Performed by:** development agent (Claude Fable 5.1)
**Branch:** `rebuild/phase-0-foundation`
**Predecessor:** Prompt 0.1 — PASS (`docs/evidence/phase-0-prompt-1.md`)

---

## 1. Result

**ENGINEERING GATE PASSED.** `npm run gate` completed 10/10 steps in 52.1 s on the exact code
committed below. Unit 22/22, integration 57/57 against real PostgreSQL, production build succeeded.

Nothing was pushed, deployed, provisioned, or made private. No credential was requested, generated,
held or committed. Owner decisions A1–A5 remain **open**; local configuration follows their
recommendations without marking them approved.

---

## 2. Commits

All on `rebuild/phase-0-foundation`, on top of `5b57b0f` (Prompt 0.1 evidence). `master` untouched.

| # | SHA | Subject | Files |
|---|---|---|---|
| A | `b7b6c8db0806f4b92ed124b4601412f9b6a2ace9` | build: engineering gate, test harness, CI, Docker and env template | 16 |
| B | `d02112a837ad1f429b21f0b3936a3079373edf34` | feat(db): foundation schema and append-only ledger migration | 3 |
| C | `7e8642ed8435ca30d126b52a0592fe0647745932` | feat(core): secure foundation, tenant guards, ledger engine, worker; remove prototype backend | 62 |
| D | `7cd4e2e389794ca13c5bc6cdf4f6d6b158727a17` | test: unit and real-PostgreSQL integration suites | 14 |
| E | recorded in the final response | docs: Phase 0 implementation guide, README, this evidence | 3 |

Tooling (A) was committed **before** schema (B) and code (C), as the prompt required, so every
later commit was verifiable by the gate.

---

## 3. Changed areas

### Added
| Area | Paths |
|---|---|
| Gate and tests harness | `scripts/gate.mjs`, `vitest.config.mts`, `tests/setup/{integration-global,integration-env,test-env,fixtures}.ts` |
| CI | `.github/workflows/gate.yml` |
| Containers | `Dockerfile` (targets `web`, `worker`), `docker-compose.yml` (rewritten), `.dockerignore` |
| Repo hygiene | `.gitattributes`, `.nvmrc`, `.env.example` |
| Schema | `prisma/schema.prisma` (rewritten, 18 models, 13 enums), `prisma/migrations/20260911000000_foundation/migration.sql` (639 lines), `prisma/migrations/migration_lock.toml` |
| Server domain layer | `src/server/{env,db,errors,http}.ts`, `src/server/auth/{options,session}.ts`, `src/server/tenant/{permissions,context,memberships}.ts`, `src/server/audit/audit.ts`, `src/server/registration/register.ts`, `src/server/ledger/{types,visits,ledger,idempotency,reconciliation,index}.ts` |
| Worker | `src/worker/{index,boss,health}.ts`, `src/worker/jobs/smoke.ts` |
| Routing / startup | `src/proxy.ts` (replaces `src/middleware.ts`), `src/instrumentation.ts` |
| Routes / pages | `src/app/api/auth/register/route.ts`, `src/app/api/auth/[...nextauth]/route.ts` (rewritten), `src/app/[locale]/business/page.tsx` (rewritten as membership list) |
| Seed | `prisma/seed.ts` (rewritten; uses the registration service) |
| Tests | 4 unit files, 10 integration files |
| Docs | `docs/PHASE-0-IMPLEMENTATION.md`, `README.md` (rewritten), this file |

### Removed (all preserved in tag `prototype-baseline` = `0aee6ee`)
`src/lib/auth.ts`, `src/lib/prisma.ts`, `src/middleware.ts`, old `prisma/seed.ts`, every route under
`src/app/api/**` except NextAuth (12 files incl. wallet stubs), and the mock pages that consumed those
routes: `business/{page,customers,cards/*,developer,feedback,forms,locations,push}`, `card/**`, `scanner`,
`GrowthChart.tsx`. Static marketing and shell pages retained as visual reference.

### Dependencies
Added `zod`, `pg-boss`; dev `vitest`, `tsx`, `dotenv`, `@types/node@^24`. Removed `google-auth-library`,
`passkit-generator`.

---

## 4. Commands and results

Numbered in execution order. Read-only unless stated. Outputs abbreviated to the decisive lines.

### Preconditions
| # | Command | Result |
|---|---|---|
| 1 | `git branch --show-current; git status --short` | `rebuild/phase-0-foundation`, clean |
| 2 | `docker version`, `docker compose version` | 29.7.2 / v5.3.1 |
| 3 | `docker ps` | ports 5432/5434/5436/5541 in use by other projects → test-db assigned **5435** |
| 4 | Read `.env` keys (values redacted) | `DATABASE_URL`, `NEXTAUTH_SECRET`, `NEXTAUTH_URL`, `ONESIGNAL_*` present; no `POSTGRES_*`/`TEST_*` |
| 5 | grep Next constants for proxy convention | `PROXY_FILENAME = 'proxy'`; docs: default or named `proxy` export supported |
| 6 | `npx eslint . -f json` grouped by file | **baseline 34 errors / 43 warnings**, 26 of the errors in files scheduled for deletion |
| 7 | `npm view` versions | vitest 5.0.0, pg-boss 12.31.0, zod 4.6.2, tsx 4.23.13 |

### Setup (mutating)
| # | Command | Result |
|---|---|---|
| 8 | `npm install zod pg-boss` | ok |
| 9 | `npm install -D vitest tsx dotenv` | **ERESOLVE**: vitest 5 needs `@types/node ^22 \|\| >=24`; repo had `^20` |
| 10 | `npm install -D @types/node@^24 vitest tsx dotenv` | ok (`@types/node ^24.13.4`) — consistent with Node 24 pin |
| 11 | `npm uninstall google-auth-library passkit-generator` | ok |
| 12 | Append to git-ignored `.env`: `POSTGRES_USER/PASSWORD/DB/PORT`, `TEST_POSTGRES_PORT=5435`, `TEST_DATABASE_URL`, `WORKER_HEALTH_PORT` | added 7 keys; `git check-ignore .env` → ignored. Values are local dev fixtures matching the already-public prototype literals; **no new exposure, no real credential** |
| 13 | `docker compose up -d --wait test-db` | `loyalty-platform-test-db-1 … (healthy) 0.0.0.0:5435->5432` |

### Schema and migration
| # | Command | Result |
|---|---|---|
| 14 | `npx prisma validate` | schema valid |
| 15 | `npx prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma --script > …/migration.sql` | 567 lines, 18 `CREATE TABLE`, 14 unique indexes |
| 16 | Append hand-written SQL (2 partial unique indexes, 2 functions, 3 triggers) | 639 lines total |
| 17 | `DATABASE_URL=$TEST_DATABASE_URL npx prisma migrate deploy` | "All migrations have been successfully applied" |
| 18 | `… npx prisma migrate status` | "Database schema is up to date!" |
| 19 | `npx prisma generate` | Prisma Client v6.19.2 generated |

### Code removal
| # | Command | Result |
|---|---|---|
| 20 | `git rm -r` prototype backend + dead pages (list in §3) | 32 deletions staged |
| 21 | `rm -rf .next` | stale generated route types (referencing deleted pages) removed; gate now does this automatically |

### Verification loops
| # | Command | Result |
|---|---|---|
| 22 | `npx tsc --noEmit` (pass 1) | 33 errors: 26 stale `.next/dev/types`, pg-boss default-export, type-guard direction in ledger, JSON typing in fixtures, read-only `NODE_ENV` |
| 23 | fixes applied; `npx tsc --noEmit` (pass 2) | **0 errors** |
| 24 | `npx eslint .` | 3 errors remaining (unescaped `'`, `prefer-const`, `any` in old spec) → fixed |
| 25 | `npx eslint .` | **0 errors, 18 warnings** (all in retained mock pages, see §8) |
| 26 | `npx vitest run --project unit` | **22 passed** |
| 27 | `npx vitest run --project integration` (pass 1) | 55/57 — two test-side artefacts: `jsonb` reorders keys (compare canonically); email test trimmed after validation (schema now trims before) |
| 28 | `npx tsc --noEmit` (tests included) | 12 errors in tests (ProcessEnv typing, `as const` on enum, pg-boss `StopOptions`) → fixed |
| 29 | `npx tsc --noEmit` | **0 errors** |
| 30 | `npx vitest run --project integration` (pass 2) | **57 passed**, 12.27 s |

### The gate
| # | Command | Result |
|---|---|---|
| 31 | `npm run gate` | **GATE PASSED in 52.1s (10/10 steps)** — table in §5 |

### Manual verification
| # | Command | Result |
|---|---|---|
| 32 | `DATABASE_URL=$TEST_DATABASE_URL WORKER_HEALTH_PORT=8099 npx tsx src/worker/index.ts &` | log: `health endpoint listening {port:8099}`, `worker started {queues:["system.smoke"]}` |
| 33 | `curl :8099/health` | `HTTP 200 {"status":"ok","service":"walaaplus-worker","schema":"pgboss"}` |
| 34 | `curl :8099/nope` | `HTTP 404` |
| 35 | `grep -E '^[A-Z_]+=.+' .env.example` | **none — names only** |
| 36 | `validateEnv({})` with required vars unset | `EnvValidationError: … Missing or invalid: DATABASE_URL, NEXTAUTH_SECRET, NEXTAUTH_URL. Values are never printed.` |
| 37 | `npx tsx src/worker/index.ts` with required vars unset | refuses, same message, **exit 2** |
| 38 | `git diff --check` before each commit | clean |

---

## 5. Gate output (verbatim summary)

```
==============================================
GATE SUMMARY
==============================================
PASS  prisma generate             1774 ms
PASS  lint                        4477 ms
PASS  typecheck                   2668 ms
PASS  prisma validate             1542 ms
PASS  unit tests                  1466 ms
PASS  test db up                   978 ms
PASS  migrate deploy (test db)    1534 ms
PASS  migrate status (test db)    1568 ms
PASS  integration tests          13449 ms
PASS  production build           22604 ms
----------------------------------------------
GATE PASSED in 52.1s (10/10 steps)
```

Build routes: 16 dynamic pages, `/api/auth/[...nextauth]`, `/api/auth/register`, and
`ƒ Proxy (Middleware)` — confirming Next 16 recognised `src/proxy.ts`.

**CI run URL: none.** The workflow exists (`.github/workflows/gate.yml`) but pushing is forbidden
until owner decision A1. The local gate above is the witness for this prompt.

---

## 6. Test outcomes against the prompt's required list

| Required proof | Test | Result |
|---|---|---|
| Registration creates business, owner membership, Main location atomically | `registration.test.ts` (5) + `registration-atomicity.test.ts` (2, injected late failure rolls back all rows) | ✅ |
| Tenant guard blocks a user from another business | `tenant-guard.test.ts` (5) | ✅ |
| Membership removal / role change takes effect from DB state | `memberships.test.ts` (9) | ✅ |
| Duplicate idempotency key creates no duplicate | `idempotency.test.ts` — replay + **8 concurrent first attempts execute once** | ✅ |
| Changed payload with same key is rejected | `idempotency.test.ts` → `IdempotencyConflictError` | ✅ |
| PostgreSQL rejects ledger UPDATE and DELETE | `database-protection.test.ts` — Prisma update/updateMany/delete/deleteMany and raw UPDATE/DELETE/TRUNCATE all raise `append-only` | ✅ |
| Reconciliation detects corrupted projection | `reconciliation.test.ts` — corrupted `stampBalance`/`rewardBalance` reported per unit, scoped by business | ✅ |
| Worker smoke test | `worker.test.ts` — starts on test DB, processes job, health 503→200, 404 | ✅ |
| Required unique constraints present | `constraints.test.ts` — 14 unique indexes, 2 partial uniques, 5 ledger indexes, 3 triggers, no `updatedAt`, NOT NULL core columns | ✅ |

Additional proofs beyond the minimum: ProgramVersion mechanics frozen and forward-only status;
one ACTIVE version per template; one default location per business; **25 concurrent appends produce
`balanceAfter` exactly 1..25** (row-lock serialisation); grouped reversal semantics incl. refusal when
dependent value was consumed; `countsAsVisit` per kind and per version setting; env validation never
echoes values and refuses the burned secrets.

Totals: **unit 22/22, integration 57/57, 14 test files.**

---

## 7. Schema and database-protection evidence

- Migration `20260911000000_foundation` applied to the test database; `migrate status` up to date.
- Triggers present: `loyalty_operation_append_only` (BEFORE UPDATE OR DELETE), `loyalty_operation_no_truncate`
  (BEFORE TRUNCATE), `program_version_protect` (BEFORE UPDATE OR DELETE).
- Partial unique indexes present: `ProgramVersion_one_active_per_template`, `Location_one_default_per_business`.
- `LoyaltyOperation` has no `updatedAt`; `transactionGroupId`, `businessId`, `locationId`, `customerId`,
  `customerBusinessProfileId`, `customerCardId`, `templateId`, `programVersionId`, `kind`, `unitType`,
  `quantity`, `balanceAfter`, `countsAsVisit`, `source`, `createdAt` are NOT NULL; `performedByUserId`
  nullable for ENROLLMENT/SYSTEM sources.
- `Customer` has no name columns; `CustomerBusinessProfile` carries `firstName`/`lastName`.
- Card uniqueness: `serialNumber`, `qrToken`, `shareToken`, `(customerBusinessProfileId, templateId)`.
- `UtmSourceLink.publicToken` unique; `IdempotencyRecord (businessId, key)` unique.
- Reserved tables created: `UtmSourceLink`, `PushSubscription`, `PushMessage`, `PushDelivery`.

---

## 8. Unresolved medium / low issues (for Prompt 0.3)

| # | Sev | Issue | Proposed handling |
|---|---|---|---|
| M-1 | Medium | Sidebar still links to routes deleted in this prompt (404s). Mock navigation removal is a Phase 1a gate item | Prune `Sidebar.tsx` to shipped pages in 1a.2; note in 0.3 |
| M-2 | Medium | No rate limiting on `/api/auth/register` or NextAuth sign-in | Add in 0.3 (in-memory or DB token bucket) before any public exposure |
| M-3 | Medium | No password reset flow; needs an email provider (decision D3) | Phase 1a/1.5 once provider chosen |
| M-4 | Medium | Runtime DB role privilege `REVOKE UPDATE, DELETE, TRUNCATE ON "LoyaltyOperation"` is an owner action per environment; trigger already enforces | Runbook in PHASE-0-IMPLEMENTATION.md §4; owner applies on staging/prod |
| L-1 | Low | 18 lint warnings (unused imports, `<img>`) in retained static mock pages | Disappear as pages are rebuilt in 1a/1b |
| L-2 | Low | `tests/walaaplus.spec.ts` targets removed pages; excluded from gate | Rewritten in 1a.2 |
| L-3 | Low | Prisma 6.19 (banner offers 8.0.0-rc); `package.json#prisma` removed to silence deprecation, `prisma db seed` therefore not wired — use `npm run db:seed` | Evaluate Prisma upgrade in 0.3; document |
| L-4 | Low | Amount columns are 32-bit `Int` minor units (max ≈ 2.1 × 10⁹ per row) | Adequate for SYP transaction sizes; revisit if aggregates need `BigInt` |
| L-5 | Low | Unused deps retained for later phases: `html5-qrcode`, `framer-motion`, `recharts` | Prune or use in 1a/1b |
| L-6 | Low | pg-boss `pgboss` schema not tracked by Prisma migrations (by design) | Documented |
| L-7 | Low | Effective permissions = role defaults ∪ explicit grants; no per-permission revoke from a role's defaults | Sufficient for Phase 0; extend when staff UI lands (1b) |

No critical or high issue remains.

---

## 9. Decisions still owned by the owner

Unchanged from `DECISIONS-REQUIRED.md`; none marked approved by this prompt.

| # | Decision | Local action taken (not an approval) |
|---|---|---|
| A1 | Push permission for `rebuild/*` | **Nothing pushed.** CI workflow committed but never triggered |
| A2 | Make repository private | Not changed |
| A3 | CI provider | GitHub Actions workflow authored per recommendation |
| A4 | Database approach | Docker Compose PostgreSQL 15 for dev/test per recommendation |
| A5 | Node pin | `.nvmrc` = 24, `@types/node` 24, Dockerfile `node:24-alpine` per recommendation |
| B1–B6 | Hosting, domains, staging TLS, secrets, deploy authority | Dockerfile/Compose/runbook authored; nothing provisioned |
| C1–C5 | VAPID keys, backups, monitoring, pilot volume | Not started (Phase 1.5) |

---

## 10. Confirmation of boundaries

- `master` still at `b9ee686`; not committed to, merged, or pushed.
- Tag `prototype-baseline` still at `0aee6ee`; unchanged.
- No commit amended, no history rewritten.
- **Nothing pushed to any remote; nothing deployed; no cloud resource provisioned; repository visibility unchanged.**
- No live credential requested, generated, held, logged or committed. `.env.example` contains names only (verified, §4 #35). Test fixtures use a constant non-secret string that never leaves the test process. CI uses an ephemeral per-run secret and a throwaway database password that is not a credential to any real system.
- No future-phase functionality built: no merchant UI beyond the membership list shell, no scanner, no enrollment, no PWA, no stamp/points mechanics, no campaigns, no integrations.

**ENGINEERING GATE PASSED — READY FOR THE NEXT PROMPT**
