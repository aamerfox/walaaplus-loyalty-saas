# Evidence — Phase 0, Prompt 0.2

**Prompt:** Secure Foundation and Ledger Schema
**Date:** 2026-09-11
**Performed by:** development agent (Claude Fable 5.1)
**Branch:** `rebuild/phase-0-foundation`
**Predecessor:** Prompt 0.1 — PASS (`docs/evidence/phase-0-prompt-1.md`)
**Revision:** original evidence 2026-09-11; **corrected and extended the same day by the Prompt 0.2 remediation (§11)** after an architect review found six must-fix issues. Sections 1–10 are the original record with inaccuracies struck and corrected in place; §11 is the remediation record.

---

## 1. Result

**Original gate: PASSED, 10/10 steps in 52.1 s** on the code committed in §2. Unit 22/22, integration 57/57 against real PostgreSQL, production build succeeded.

> **Correction (remediation).** That gate contained **no dependency audit**. `npm audit --omit=dev` on the code as committed reported **13 production findings — 2 critical, 7 high** (Next.js RCE advisories, next-auth email-normalisation bypass, next-intl open redirect, Prisma CLI transitive `effect`/`deepmerge-ts`/`defu`). The original §8 sentence "No critical or high issue remains" was therefore **inaccurate and is withdrawn**. The architect review also found that `requireLocationAccess` was never called (an unassigned cashier was unrestricted), a concurrent-reversal race, mutable reward tiers under an active version, an implicit `countsAsVisit` for API/automation sources, no runtime database role, and a wrong UTM uniqueness key. All are fixed and proven in §11. **The remediation gate (13 steps, including the audit) passed on the final code; see §11.5.**

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
| E | `75ee29a` | docs: Phase 0 implementation guide, README and Prompt 0.2 evidence | 3 |

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
| M-1 | Medium | Sidebar still links to routes deleted in this prompt (404s). Mock navigation removal is a Phase 1a gate item | **Resolved in remediation** (`3b41c0d`): sidebar shows only implemented routes |
| M-2 | Medium | No rate limiting on `/api/auth/register` or NextAuth sign-in | **Registration resolved in remediation** (`3b41c0d`, 10 / 15 min per address, in-process). NextAuth sign-in limiting remains for 0.3 |
| M-3 | Medium | No password reset flow; needs an email provider (decision D3) | Phase 1a/1.5 once provider chosen |
| M-4 | Medium | Runtime DB role privilege `REVOKE UPDATE, DELETE, TRUNCATE ON "LoyaltyOperation"` is an owner action per environment; trigger already enforces | **Resolved in remediation** (`fb7446c`): `scripts/db-roles.mjs` creates the role in every environment; tests connect as it; owner still runs it on staging/production (§11.7) |
| L-1 | Low | 18 lint warnings (unused imports, `<img>`) in retained static mock pages | Disappear as pages are rebuilt in 1a/1b |
| L-2 | Low | `tests/walaaplus.spec.ts` targets removed pages; excluded from gate | Rewritten in 1a.2 |
| L-3 | Low | Prisma 6.19 (banner offers 8.0.0-rc); `package.json#prisma` removed to silence deprecation, `prisma db seed` therefore not wired — use `npm run db:seed` | Evaluate Prisma upgrade in 0.3; document |
| L-4 | Low | Amount columns are 32-bit `Int` minor units (max ≈ 2.1 × 10⁹ per row) | Adequate for SYP transaction sizes; revisit if aggregates need `BigInt` |
| L-5 | Low | Unused deps retained for later phases: `html5-qrcode`, `framer-motion`, `recharts` | Prune or use in 1a/1b |
| L-6 | Low | pg-boss `pgboss` schema not tracked by Prisma migrations (by design) | Documented |
| L-7 | Low | Effective permissions = role defaults ∪ explicit grants; no per-permission revoke from a role's defaults | Sufficient for Phase 0; extend when staff UI lands (1b) |

~~No critical or high issue remains.~~ **Withdrawn — inaccurate when written.** At the time of this section 13 production dependency findings (2 critical, 7 high) existed and no audit had been run. See §1 correction and §11.6 for the audit results after remediation.

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

**Original status line (superseded by §11):** ENGINEERING GATE PASSED — READY FOR THE NEXT PROMPT

---

## 11. Remediation record — Prompt 0.2 R

**Date:** 2026-09-11 · **Performed by:** development agent (Claude Fable 5.1) · **Branch:** `rebuild/phase-0-foundation`
**Trigger:** architect verdict on Prompt 0.2 listing six must-fix issues; owner instruction to remediate before Prompt 0.3 with a fresh gate, new real-PostgreSQL tests, a runtime-role proof and corrected evidence.

### 11.1 Result

**REMEDIATION GATE PASSED — 13/13 steps** on the final code (§11.5), including a new first step `npm audit --omit=dev --audit-level=high` (0 findings), a new `db-roles` step and a worker-bundle build. Totals: **unit 33/33, integration 122/122 (16 files), all integration tests executed while connected as the restricted runtime role.** `git diff --check` clean. Docker images `migrate`, `worker` and `web` build with no environment present.

Nothing was pushed, deployed, provisioned, or made private. No credential was requested, generated, held or committed. Owner decisions A1–A5 remain **open**.

### 11.2 Commits

All on `rebuild/phase-0-foundation`, on top of `75ee29a`. `master` untouched at `b9ee686`; tag `prototype-baseline` → `0aee6ee`. No amend, no rewrite. One focused commit (or a small group) per remediation item:

| Item | SHA | Subject |
|---|---|---|
| 1 | `1b51990` | fix(security): patch production dependency vulnerabilities and gate on the audit |
| 2–5 engine | `95832f0` | fix(ledger): verified actors, cashier location scope, locked reversals, tier integrity, explicit visit policy |
| 2 tests | `0f37a76` | test(ledger): actor enforcement and cashier location scope |
| 3 | `e048abf` | fix(db): one reversal per original operation, with a concurrency proof |
| 4 | `2a81d20` | fix(db): freeze RewardTier with its ProgramVersion and lock template cardType |
| 5 | `e02a24e` | test(ledger): countsAsVisit policy across kind, source, version and explicit intent |
| 6 | `fb7446c` | feat(db): restricted runtime role separate from the migrator, proven by tests |
| 7a | `c72d36f` | fix(db): UTM links unique by (templateId, name), not utmSource |
| 7b | `2d9ed03` | build: one-shot migrate container gates web/worker start; worker runs a compiled bundle |
| 7c | `3b41c0d` | fix(web): hide mock pages from the sidebar; rate limit registration |
| 7d | `510c920` | fix(build): create the Prisma client lazily so `next build` needs no environment |
| 8 | recorded in the final response | docs: corrected Prompt 0.2 evidence (this section) |

### 11.3 What changed, per item, and how it is proven

| # | Finding | Fix | Proof (all on real PostgreSQL unless "unit") |
|---|---|---|---|
| 1 | 2 critical / 7 high production vulnerabilities; evidence claimed none | next 16.2.1→16.3.4, eslint-config-next 16.3.4, next-auth 4.24.13→4.24.15, next-intl 4.8.3→4.14.3; Prisma CLI finding investigated: every stable Prisma pins vulnerable `deepmerge-ts`; resolved with npm `overrides` (`effect ^3.20`, `deepmerge-ts ^8.0.2`, `defu ^6.1.7`) — not downgraded, not allowlisted; CLI moved to devDependencies; gate step added | `npm audit --omit=dev --audit-level=high` → **found 0 vulnerabilities**; `prisma validate/generate` work on the overridden tree; full gate |
| 2 | Ledger accepted caller-supplied `businessId`/`performedByUserId`; `requireLocationAccess` never called; unassigned cashier unrestricted | `LedgerActor` = verified `MemberActor{ctx,source}` or explicit `SystemActor{businessId,source,reason}`; business and user DERIVED; permission per kind (MAKE_ACCRUALS / MAKE_REDEMPTIONS / both for REVERSAL; system-only kinds refused); `requireLocationAccess` inside the transaction; `locationIds` null only for OWNER/MANAGER, `[]` for an unassigned cashier = denied | `ledger-actor.test.ts`: unassigned cashier denied at every location and nothing written; assigned cashier only at assigned location, row records derived user/location/business/source; OWNER and MANAGER unrestricted; foreign owner / foreign location / system actor naming another business → not found; permission matrix; deactivated membership loses access |
| 3 | Two concurrent reversals of one group could both succeed | Card row locked (`FOR UPDATE`) **before** the already-reversed check; partial unique index on non-null `reversalOfOperationId`; P2002 → `ConflictError` | `reversal-race.test.ts`: six simultaneous reversals → exactly one succeeds, one compensating group, ≤1 reversal per original, projection = ledger; raw duplicate compensating row refused by the index |
| 4 | RewardTier mutable under ACTIVE/RETIRED versions; tier ids not validated against the pinned version; `cardType` changeable | Triggers `reward_tier_protect` (tiers frozen unless version DRAFT, never movable) and `program_template_protect_card_type` (locked once any non-DRAFT version or any issued card); ledger validates every `rewardTierId` belongs to the card's pinned version with one identical error (no cross-tenant leak) | `program-integrity.test.ts`: DB matrix (DRAFT editable; ACTIVE/RETIRED frozen against insert/update/rename/move/delete; cardType lock by version and by issued card); service: foreign-version, foreign-business and unknown tier ids refused with an identical message containing neither id, nothing written |
| 5 | `countsAsVisit` implicit for API/automation; integrations could be visits implicitly | Policy over kind × source × version setting × explicit intent; staff awards are visits by policy and refuse a flag; platform awards never; API/AUTOMATION awards and every INTEGRATION_AWARD **must state intent**; redemptions follow the pinned version and refuse a flag; policy validated before balance arithmetic | unit `visits.test.ts` (every kind classified exactly once) + `visits-policy.test.ts` on stored rows, incl. refused flag writes nothing |
| 6 | Application connected as the table owner | `scripts/db-roles.mjs` + `db-migrate.mjs`; env split `MIGRATE_DATABASE_URL`/`DATABASE_URL` (tests: `TEST_MIGRATE_DATABASE_URL`/`TEST_DATABASE_URL`); harness deploys and grants as migrator, workers connect as runtime role; pg-boss `createSchema:false` with the schema pre-owned by the role; Compose/CI/gate wired | §11.7 |
| 7 | UTM unique on `(templateId, utmSource)`; web/worker could start unmigrated; worker ran `tsx`; mock sidebar; no register rate limit | `@@unique([templateId, name])` + migration; Compose `migrate` one-shot service with `service_completed_successfully` ordering, Dockerfile `migrate` target; esbuild ESM worker bundle, `prod-deps` stage, no tsx in the image; sidebar filtered to implemented routes; 10 / 15 min per-address limiter | `utm-links.test.ts` (same source twice OK, same name refused, token unique, exact index set); bundle started against the test DB as the runtime role → `/health` 200; Docker builds (§11.4 #24–26); unit `rate-limit.test.ts` |
| 7d | `next build` failed without an environment (found by the first Docker build) | Lazy Prisma client behind a transparent Proxy | Docker `worker` and `web` targets build with no `.env`; all suites unchanged |

### 11.4 Commands and results (execution order; decisive lines only)

| # | Command | Result |
|---|---|---|
| 1 | `docker info` | daemon 29.7.2 running (owner confirmed Docker Desktop up before verification) |
| 2 | `npm audit --omit=dev` (before item 1) | 13 findings: 2 critical, 7 high |
| 3 | `npm install next@^16.3.4 eslint-config-next@^16.3.4 next-auth@^4.24.15 next-intl@^4.14.3`; move `prisma` to devDependencies; add `overrides`; `npm update baseline-browser-mapping` | deliberate, no `npm audit fix` |
| 4 | `npm audit --omit=dev --audit-level=high` | **found 0 vulnerabilities**, exit 0 |
| 5 | `npx prisma validate && npx prisma generate` | valid; client generated on the overridden tree |
| 6 | items 2–5 implemented; `npx vitest run --project integration` (pass 1) | 80/81 — policy error ordered after balance check → reordered |
| 7 | `npx vitest run --project integration` (pass 2) | **81/81** |
| 8 | five commits (`95832f0`…`e02a24e`) via message files | tree clean |
| 9 | item 6 written; `.env` (git-ignored) split into migrator + runtime URLs and `APP_DB_USER/APP_DB_PASSWORD` dev fixture | names only recorded; values are local dev fixtures |
| 10 | `node scripts/db-migrate.mjs deploy` / `status` against test DB as migrator | up to date |
| 11 | `node scripts/db-roles.mjs` (twice) | `created role "walaaplus_app"`; second run idempotent; `OK role … append-only on [LoyaltyOperation], no access to [_prisma_migrations], owns schema "pgboss", cannot CREATE in public` |
| 12 | `npx vitest run --project integration` as runtime role (pass 1) | 3 failures: self-GRANT is a PostgreSQL WARNING not an error (test corrected to assert privilege unchanged); pg-boss objects created by the owner in earlier runs (`permission denied for table version`) → db-roles now transfers existing `pgboss` objects |
| 13 | rerun | **117/117**, `transferred 18 existing pgboss objects` |
| 14 | `docker compose down test-db && up -d --wait test-db` (fresh, empty database) then integration | 2 failures: `CREATE SCHEMA IF NOT EXISTS pgboss` needs database CREATE even when the schema exists → `createSchema: false` |
| 15 | rerun on the fresh database | **117/117**; role and schema created from nothing |
| 16 | `npx tsc --noEmit`; `npx eslint .`; `git diff --check` | 0 errors; 0 errors / 18 warnings (retained mock pages); clean |
| 17 | commit `fb7446c` | — |
| 18 | item 7: schema + migration `20260911120200_utm_unique_name`, Compose, Dockerfile, esbuild script, sidebar, rate limiter; `npm install` (esbuild devDep, pg dep) | lockfile updated |
| 19 | `node scripts/build-worker.mjs` | `dist/worker/index.mjs` 738.7 kB + map, 56 ms |
| 20 | `node dist/worker/index.mjs` with test-DB runtime URL, `WORKER_HEALTH_PORT=8099` | `worker started {queues:["system.smoke"]}`; `GET /health` → 200 `{"status":"ok","service":"walaaplus-worker","schema":"pgboss"}`; `/nope` → 404 |
| 21 | `npx vitest run --project integration` | migration applied; **122/122** |
| 22 | `npx eslint .` | 161 warnings → `dist/**` added to ignores → 18 warnings, 0 errors |
| 23 | commits `c72d36f`, `2d9ed03`, `3b41c0d` | — |
| 24 | `docker build --target migrate` | **success** (`walaaplus-migrate:remediation`) |
| 25 | `docker build --target worker` (first attempt) | **FAILED**: `Failed to collect page data for /api/auth/register … EnvValidationError` — `db.ts` evaluated env at import; fixed with a lazy client |
| 26 | `docker build --target worker` and `--target web` (after fix) | **both succeed** with no `.env` in the build context (`walaaplus-worker:remediation` 1.17 GB, `walaaplus-web:remediation` 407 MB, `walaaplus-migrate:remediation` 1.46 GB); build log shows `Collecting page data` completing and `ƒ Proxy (Middleware)` recognised |
| 27 | `npx tsc --noEmit`; `npx eslint .`; unit; integration (after lazy client) | 0 errors; 0 errors / 18 warnings; **33/33**; **122/122** |
| 28 | commit `510c920` | — |
| 29 | `npm run gate` (final, Docker available) | **GATE PASSED 13/13** — §11.5 |
| 30 | `npm audit --omit=dev --audit-level=high` (standalone, final) | **found 0 vulnerabilities** |
| 31 | `git diff --check`; `git status --porcelain` | clean before the evidence commit |
| 32 | `git rev-parse master prototype-baseline^{commit}`; `git for-each-ref refs/remotes` | `b9ee686`, `0aee6ee`; only `origin/master b9ee686` exists; `rebuild/phase-0-foundation` has no upstream and no remote ref — nothing pushed |

### 11.5 Final gate output (verbatim summary)

```
=============================================================
GATE SUMMARY
=============================================================
PASS  dependency audit (prod, high+)              985 ms
PASS  prisma generate                            1853 ms
PASS  lint                                       4417 ms
PASS  typecheck                                  3829 ms
PASS  prisma validate                            1458 ms
PASS  unit tests                                 1544 ms
PASS  test db up                                 1038 ms
PASS  migrate deploy (test db, migrator role)    1739 ms
PASS  migrate status (test db)                   1620 ms
PASS  runtime role grants (test db)               158 ms
PASS  integration tests                         20883 ms
PASS  worker build                                162 ms
PASS  production build                          14749 ms
-------------------------------------------------------------
GATE PASSED in 54.4s (13/13 steps)
```

### 11.6 Dependency audit — full disclosure

| View | Result |
|---|---|
| `npm audit --omit=dev --audit-level=high` (gate step, production dependencies) | **0 vulnerabilities** |
| `npm audit` (dev tooling included) | 0 critical, **3 high, 1 moderate, 1 low — all transitive dev-only**: `brace-expansion` (via ESLint/minimatch), `browserslist`, `js-yaml` (via ESLint/Babel tooling), `@humanfs/node` (ESLint), `@babel/core`. None ships in the web, worker or migrate images (`prod-deps` stage installs `--omit=dev`; the migrate image carries the Prisma CLI, whose own findings are fixed by the overrides). npm reports a fix available for each; they were **not** applied here to keep this remediation scoped to production dependencies and to avoid a blind `npm audit fix`. Tracked for Prompt 0.3 as targeted updates. |

No allowlist, ignore list or `audit-level` relaxation exists anywhere in the repository.

### 11.7 Runtime database role — proof

Two roles in every environment (`docs/PHASE-0-IMPLEMENTATION.md` §4 "Database roles"):

| Role | Variable | Holds |
|---|---|---|
| migrator / owner | `MIGRATE_DATABASE_URL` · tests `TEST_MIGRATE_DATABASE_URL` | migrations, grants, test truncation |
| runtime `walaaplus_app` | `DATABASE_URL` · tests `TEST_DATABASE_URL` | web, worker, every service under test |

`tests/integration/runtime-role.test.ts` (9 tests, 29 parameterised bypass attempts) runs **connected as the runtime role** and proves: non-superuser with no CREATEROLE/CREATEDB/BYPASSRLS/REPLICATION; not the migrator; owns nothing in `public`; exactly `SELECT, INSERT` on `LoyaltyOperation`, no `CREATE` in `public`; the legitimate service path appends and reads; and each of the following fails with a privilege error before any trigger runs — `UPDATE`, `DELETE`, `TRUNCATE` (with and without `CASCADE`), `ALTER TABLE … DISABLE TRIGGER USER/ALL/<name>`, `DROP TRIGGER` (both), `DROP COLUMN`, `RENAME`, `OWNER TO`, `DROP TABLE`, `CREATE OR REPLACE FUNCTION walaaplus_reject_ledger_mutation`, `DROP FUNCTION`, `DROP INDEX` (reversal index), disabling the RewardTier/ProgramVersion/cardType triggers, `SET [LOCAL] session_replication_role`, `CREATE TABLE/FUNCTION` in `public`, `DELETE FROM`/`SELECT` on `_prisma_migrations`, `SET ROLE` to the migrator, `ALTER ROLE … SUPERUSER/CREATEROLE/BYPASSRLS`, self-`GRANT`. A snapshot taken **as the owner** (row count and quantity, trigger names and enabled state, trigger-function source, index list) is identical before and after. `database-protection.test.ts` proves the second layer: the trigger refuses even the owner.

The gate step `runtime role grants (test db)` must print `db-roles: OK role`; CI creates the role inside the run with an ephemeral fixture password.

### 11.8 Verified here vs. owner-only

| Verified in this remediation (local, Docker available) | Owner-only (not done, not simulated) |
|---|---|
| Gate 13/13 on the final commit; all suites on real PostgreSQL 15 as the runtime role | Running CI (no push until A1) |
| Role script creates the role from an empty database and from one with legacy `pgboss` objects | Provisioning migrator and runtime credentials for staging/production |
| Compiled worker bundle starts and serves `/health` | Running `npm run db:migrate && npm run db:roles` (or the Compose `migrate` service) against staging/production |
| Docker images `migrate`, `worker`, `web` build without an environment | Running the `--profile app` stack against a real host, TLS, domains (B1–B6) |
| `npm audit` production view clean; dev view disclosed above | Deciding on the dev-tooling updates listed in §11.6 |

### 11.9 Remaining items (carried to Prompt 0.3)

- Dev-tooling audit findings (§11.6) — targeted updates, not `npm audit fix`.
- Rate limiting for NextAuth sign-in (registration is done); shared-store limiter when more than one web replica runs.
- Original L-2…L-7 unchanged; L-1 (18 lint warnings) unchanged, confined to retained mock pages now hidden from navigation.
- The migrator must be a superuser or hold CREATEROLE for `db-roles` to hand over `pgboss` ownership; documented in §4 of the implementation guide.
- Owner decisions A1–A5, B1–B6, C1–C5: unchanged, none approved by this work.

### 11.10 Boundaries

- `master` at `b9ee686`, untouched. Tag `prototype-baseline` → `0aee6ee`, unchanged.
- No commit amended, no history rewritten; commits are focused per remediation item.
- **Nothing pushed** (the branch has no upstream and no remote ref exists for it), nothing deployed, no cloud resource provisioned, repository visibility unchanged, no live credential requested, generated, held or committed. `.env.example` still contains names only. The runtime-role password used locally and in CI is a dev/CI fixture, not a credential to any real system.
- `npm audit fix` was not used; no vulnerability was suppressed, ignored or allowlisted.

**PASS — PHASE 0 PROMPT 2 REMEDIATION COMPLETE — READY FOR PHASE 0 PROMPT 3**
