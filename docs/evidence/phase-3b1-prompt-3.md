# Phase 3B.1 Prompt 3 — public API release gate

| | |
|---|---|
| Branch | `rebuild/phase-0-foundation` |
| Baseline audited | `88972b6` |
| Matrix written before any change | `docs/PHASE-3B1-RELEASE-GATE.md` |
| Migration | **19**, `20260925120000_api_key_name_active_only`. Migrations 15–18 untouched — `git status` shows one new directory and no modification |
| New secret, env var, Compose, Caddy, DNS, TLS or staging change | **none** |
| Staging | **not contacted.** No external network call, no provider, no device, no real key, no customer data |

---

## 1. Five findings, all fixed and red-proved

| # | Severity | Finding | Fix |
|---|---|---|---|
| F1 | **HIGH** | Rotation could not keep its own name — the default path through the owner's form failed every time | Migration 19 |
| F2 | **HIGH** | A key's name was burned permanently once used | Migration 19 |
| F3 | **HIGH** | The keyset cursor was a scan, not a seek: 20,001 rows discarded to return 26 | Row-value predicate |
| F4 | MEDIUM | The one-time reveal was silent to assistive technology | Live region + focus |
| F5 | MEDIUM | `lastUsedAt` written on every request — ten `UPDATE`s/second on one row | 60-second resolution |

No critical finding. `docs/PHASE-3B1-RELEASE-GATE.md` has the full reasoning, what was checked and
held, and what was deliberately left alone.

### 1.1 How F1 was found

By rotating a key without renaming it. The existing rotation test renamed it ("Before" → "After"),
so it passed throughout; the screen pre-fills the current name, so the untested path was the one
every owner would actually take.

---

## 2. Red proofs

Each fix was reverted and the suite re-run. Every one took its own tests red.

| Reverted | Tests that failed |
|---|---|
| The partial name index → migration 18's unconditional form | **6** — rotation keeping its name, repeated rotation, reuse after revocation, reuse after expiry, the index-shape assertion, the runtime-role permission case |
| Dropping `ApiKey_businessId_activeName_key` outright | **8** — the three name races, the control, both index-shape assertions, the migration replay, and the runtime-role case |
| The row-value keyset → the OR form | **2** — the captured-SQL plan assertion and the source assertion |
| `lastUsedAt` resolution → write every request | **2** — the timestamp test and the `xmin` row-version test |
| The reveal's live region and focus | **1** — the browser announcement test |

The name-index proof is applied to the live test database rather than the migration file, because
migration 19's checksum is recorded there and rewriting it would need a full recreate per proof. The
index definition was read back from `pg_indexes` before and after to confirm the revert actually
took — an earlier attempt silently failed on a bad `psql -U` and reported "10 passed", which would
have been a red proof that proved nothing.

---

## 3. Two regression tests that passed for the wrong reason

Recorded because this is the failure mode a release gate exists to catch, and it happened twice
inside this gate.

The F3 guard needed three attempts:

1. **EXPLAIN a hand-written statement** of the same shape — proved what PostgreSQL does with the
   predicate and nothing about what the service sends. Reverting the service left it green.
2. **Read `pg_stat_user_tables.idx_tup_fetch`** around a service call — measured nothing at all.
   Those statistics are per-backend and pending; the service runs on the application pool and
   `pg_stat_force_next_flush()` flushes only the calling connection. The delta was **zero in both
   states**, so every assertion passed vacuously.
3. **Capture the statement the service sends and EXPLAIN that.** `src/server/db.ts` caches its
   client on `globalThis.__walaaplusPrisma`, a global that exists for hot-reloads, so a test can
   install a query-logging client there and read the SQL off the wire. No shipped code changed.

Only the third goes red on a revert. The first two were deleted rather than kept alongside: a test
that cannot fail is worse than no test, because it reads like coverage.

---

## 4. Verification

| Check | Result |
|---|---|
| `node scripts/gate.mjs` | **GATE PASSED, 16/16 steps, 807.0s** (re-run after the migration-19 redesign) |
| Unit tests | **638** passed (43 files) |
| Integration tests | **1111** passed (69 files) — up from 1086 at the baseline |
| Playwright, run 1 | **137** passed |
| Playwright, run 2 | **137** passed |
| `npm audit --omit=dev` | 0 vulnerabilities |
| `npm audit` (including dev) | 0 vulnerabilities |
| Migration status | 19 applied, 0 rolled back, on a database recreated from empty after migration 19 changed |
| `prisma migrate diff` | only the pre-existing cosmetic `ConsentRecord` FK/index naming difference from Phase 2 Prompt 2 — **no new drift**, see §4.1 |
| `git diff --check` | clean |
| Raw-key scan (`wpk_` shape) | no match |
| Secret-literal scan | no match |
| Raw-capability scan (`$queryRawUnsafe` / `$executeRawUnsafe` under `src/server/api`, `src/app/api/v1`) | no match — the feed's raw SQL is a parameterised `$queryRaw` template |
| Control-byte scan | none |
| `public/` | 0 changed files |
| `docker-compose*.yml`, `deploy/`, `.env*` | 0 changed files |
| Migrations 15–18 | 0 modifications |

### 4.1 One drift line, introduced and then removed

Migration 19 makes the name index partial, and Prisma cannot express a partial index. The first
`migrate diff` after the fix therefore reported a **new** line:

```
[*] Changed the `ApiKey` table
  [+] Added unique index on columns (businessId, name)
```

That is the declared `@@unique([businessId, name])` in `prisma/schema.prisma` disagreeing with what
the database actually enforces. Two ways to resolve it: document the drift, or stop declaring a
uniqueness rule that is not the real one.

The second is right, and the codebase already does it — the `activeSlot` partial index is not
declared in the schema either, for exactly this reason. The declaration was removed. Nothing looks
a key up by `(businessId, name)`, so no generated client method is lost, and the migrations are now
the single authority for both partial indexes on this table.
`tests/integration/api-key-name-reuse.test.ts` asserts the real shape by reading `pg_indexes`.

The gate was re-run in full after that change rather than assumed still valid, because regenerating
the Prisma client touches every query in the product.

---

## 4a. Migration 19, corrected twice under review

Two rounds of review found two things wrong with this migration, both in its safety story rather
than its SQL result:

1. **The locking comment was wrong.** It said `DROP INDEX` and `CREATE UNIQUE INDEX` both take
   `ACCESS EXCLUSIVE`. `CREATE INDEX` takes `SHARE` — writers wait, readers are served. The
   conclusion I had drawn happened to be right; the reason was not, which is the worse kind of error
   in a comment somebody uses to decide whether a migration is safe to run.

2. **The order was backwards, and the cost estimate was unfounded.** It dropped the old index before
   building the new one, putting the blocking lock in front of the long operation — then justified
   it with "the build is milliseconds because a business holds at most five active keys". That
   reasoning ignores that the ceiling bounds only ACTIVE rows: retired predecessors are never
   deleted (**D31**) and keys expire every ninety days, so the table is unbounded and the build
   scales with it.

The migration now creates `ApiKey_businessId_activeName_key` first and drops
`ApiKey_businessId_name_key` afterwards, both in Prisma's single transaction. No duration is
claimed; the comment requires a controlled low-traffic window and says why `CONCURRENTLY` cannot be
used inside a transactional migration. Release gate §2.4 and §2.5.

### 4a.1 The four properties proved

| Property | Where |
|---|---|
| Old data satisfying unconditional uniqueness accepts the new partial index | `api-key-name-reuse.test.ts` — builds a realistic pre-migration table across two businesses, replays the unconditional index over it, then replays migration 19's `CREATE` |
| Active-name uniqueness is concurrency-safe after the old index is gone | `api-key-concurrency.test.ts` — two overlapping transactions on **different slots** and the same name; B blocks on B's own PID and is refused `23505` on `("businessId", name)`. Different slots is the control that stops the slot index proving it instead |
| Same-name rotation, and reuse after revoke or expiry | `api-key-name-reuse.test.ts` |
| No committed window permits a duplicate ACTIVE name | `api-key-name-reuse.test.ts` — replays the swap one statement at a time and attempts the duplicate after each: refused before, refused with both indexes present, refused after |

---

## 5. What is NOT claimed

- **No staging contact.** Freebuff is deploying `88972b6`; migration 19 is additive and is theirs to
  apply after review.
- **No external call.** Nothing outside this repository has called `/api/v1`.
- **The scope check is live but unreachable end to end**, because `ApiScope` has one value. Asserted
  at the predicate rather than faked with a second scope that does not exist.
- **The revocation race is still open** and still correct to leave open — §5.3 of the release gate
  states the real boundary.
- **The performance numbers are local**, on a containerised PostgreSQL 15 with a synthetic 40,000-row
  feed. They compare two query plans against each other, which is what makes the comparison
  meaningful; they are not a production throughput claim.
- **No load test, no CDN or reverse-proxy behaviour, no device or provider testing.**

---

## 6. Files

**New**

```
prisma/migrations/20260925120000_api_key_name_active_only/migration.sql
tests/integration/api-key-name-reuse.test.ts
tests/integration/public-api-scale.test.ts
docs/PHASE-3B1-RELEASE-GATE.md
docs/evidence/phase-3b1-prompt-3.md
```

**Changed**

```
prisma/schema.prisma                                    the unconditional @@unique removed - see 4.1
src/server/api/events.ts                                row-value keyset, raw parameterised SQL
src/server/api/auth.ts                                  lastUsedAt resolution
src/app/[locale]/business/integrations/ApiKeysClient.tsx  live region and focus on the reveal
tests/e2e/api-keys-ui.spec.ts                           rotation-without-rename, name reuse, announcement
tests/integration/api-key-concurrency.test.ts           the active-name races, with a different-slot control
tests/integration/public-api-cursor.test.ts             a forged signature that was sometimes genuine
docs/API-KEY-CAPABILITY-MATRIX.md                       §12.2 corrected
docs/PUBLIC-API-V1.md                                   names, and the corrected pagination promise
docs/PHASE-3B1-IMPLEMENTATION.md                        §3.2a, §3.3a, §3.6a, §6a
```
