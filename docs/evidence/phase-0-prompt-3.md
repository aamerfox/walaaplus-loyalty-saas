# Evidence — Phase 0, Prompt 0.3

**Prompt:** Foundation Certification and Remaining Security Closure
**Date:** 2026-09-11
**Performed by:** development agent (Claude Opus 5)
**Branch:** `rebuild/phase-0-foundation`
**Predecessor:** Prompt 0.2 + remediation — PASS (`docs/evidence/phase-0-prompt-2.md`, §11)
**Revision:** first record 2026-09-11; **the PASS below was withdrawn the same day** after review found
two unmet security requirements, and re-issued in §11 once both were fixed. Sections 1–10 are the
original record, corrected in place where they were wrong.

---

## 1. Result

**ENGINEERING GATE PASSED — 13/13 steps in 56.0 s** on `f356d75`, the final code commit.
Unit **32/32** (5 files), integration **188/188** (20 files) against real PostgreSQL 15, every
integration test connected as the restricted runtime role. `npm audit` — the **full** tree, dev
tooling included — reports **0 vulnerabilities**. `git diff --check` clean; working tree clean.

All six required items are implemented with tests. Nothing was pushed, deployed, provisioned or
made private. No credential was requested, generated, held or committed. Owner decisions A1–A5
remain **open**.

The only commit after the gate run is this documentation file, which contains no code.

> **Correction (remediation).** This section's PASS was **premature and is withdrawn**. Review
> found two Prompt 0.3 requirements unmet: registration still answered "an account with this
> email already exists", which the prompt's own generic-response requirement forbids; and the
> client address used for rate limiting came from a forgeable `X-Forwarded-For` while Compose
> published the web container directly, so the per-address limit could be bypassed with a new
> forged header on every request. §9 below recorded the first as accepted Phase 1a debt. That
> was the wrong call: it was a contract failure of this prompt. Both are fixed and proven in
> **§11**, which carries the re-issued result.

---

## 2. Commits

On top of `5474e1e` (Prompt 0.2 remediation evidence). `master` untouched at `b9ee686`; tag
`prototype-baseline` → `0aee6ee`. No amend, no history rewrite. One focused commit per item.

| Item | SHA | Subject |
|---|---|---|
| 2 | `c4ba65c` | fix(ledger): the transaction group id is server-generated, never caller-supplied |
| 1 | `374ff3d` | feat(audit): persist system-actor context with every platform ledger write |
| 5 | `f26d2cd` | fix(db): hand back the temporary runtime-role membership after the ownership transfer |
| 4 | `81cf103` | feat(security): database-backed rate limiting for registration and sign-in |
| 6 | `a616f85` | test(db): prove every Phase 0 access path has its constraint or index |
| 3 | `f356d75` | chore(security): clear the full audit and the lint backlog, drop unused deps |
| — | recorded in the final response | docs: this evidence file |

Item 2 was committed before item 1 because both touch `src/server/ledger/ledger.ts`; the
intermediate state was reconstructed and typechecked so each commit compiles on its own.

---

## 3. What changed, per item, and how it is proven

### Item 1 — system-actor audit context is persisted

`SystemActor.reason` was required but discarded, so a platform write left no record of why it
happened. A member write records its own actor, location and source on the ledger row; a system
write had nothing equivalent.

Every system group now writes **one** `AuditLog` row **in the same transaction** as the ledger
rows: action `ledger.system_group_appended`, entityType `LoyaltyOperationGroup`, entityId = the
generated transaction group id, `businessId`, `actorUserId` (verified on-behalf-of user or null),
`createdAt`, and metadata holding source, reason, customerCardId, locationId, operationIds and
operationCount — nothing else. The reason is trimmed and bounded to 500 characters.

`onBehalfOfUserId` is **verified inside the transaction** against `BusinessMembership`: an active
membership, with an active user, in the acting business. A foreign, unknown or deactivated user is
refused with `ForbiddenError` before any row is written, so a caller cannot attribute a platform
write to an unrelated person. That same verified id is what lands in `performedByUserId`.

`tests/integration/system-audit.test.ts` (8): one traceable record per group with every field
checked against the rows it names; a multi-row group as one record; an idempotent retry producing
no second group and no second audit row; scanner and dashboard writes producing no system audit
event; an active member accepted and recorded; a user from another business, an unknown id and a
deactivated member each refused with nothing written; the metadata key set and reason bound.

### Item 2 — callers cannot control the transaction group id

`transactionGroupId` is removed from `OperationGroupInput`; `appendOperationGroup` mints a fresh
UUID for every executed group. Supplying the property anyway — which untyped JavaScript can do, a
route handler spreading a JSON body — is **rejected** with a `ValidationError` before anything is
validated or written, not silently ignored. The check is `in`, so a forged `undefined` or `null`
is refused too. Retries reuse the original id through the idempotency record. Reversals still name
the group to reverse and each compensating row still carries `reversalOfOperationId`, while the
compensating group receives its own new id.

`tests/integration/transaction-group.test.ts` (6): fresh UUID per group; forged id rejected with
nothing written and no row under the forged id; forged `undefined`/`null` rejected; two writes
cannot be forced into one group; an idempotent retry returns the original id, writes no new rows
and stores that id on the idempotency record; a reversal keeps the original reference and gets a
distinct group id.

### Item 3 — audit and lint debt cleared deliberately

Full `npm audit` went from 3 high, 1 moderate, 1 low to **0**. No `npm audit fix --force`, no
allowlist, no suppression file. Each finding fixed by a targeted, version-scoped override inside
its existing major, so no toolchain API changed:

| Package | Severity | Path | Fix |
|---|---|---|---|
| `brace-expansion` | high | `eslint → minimatch@3` and `typescript-eslint → …→ minimatch@10` | scoped per parent: `minimatch@^3.1.5 → ^1.1.18`, `minimatch@^10.2.4 → ^5.0.9` |
| `browserslist` | high | `next`/babel toolchain | `^4.28.9` |
| `js-yaml` | high | eslint/babel toolchain | `^4.3.2` |
| `@humanfs/node` | moderate | `eslint` | `^0.16.8` |
| `@babel/core` | low | build toolchain | `^7.29.6` |

`brace-expansion` needed the scoped form: two majors were installed through two different
`minimatch` versions, and one global override would have forced one consumer across a major
boundary. Both replacements are the first fixed release on their own line.

Lint now fails on warnings (`eslint . --max-warnings=0`, in the gate and in `npm run lint`) and all
18 existing warnings are **fixed**, not suppressed: 16 unused imports removed, and the two
`<img>` warnings resolved by removing the third-party calls behind them. The dashboard avatar was
fetching `ui-avatars.com` with the account name on every render and is now initials with no network
call; the distribution mock was sending the registration URL to `api.qrserver.com` to draw a QR and
is now a placeholder panel. Real QR generation belongs to Phase 1a with real enrollment tokens.

Unused dependencies removed (no import anywhere in `src/`, `prisma/` or `tests/`): `html5-qrcode`,
`framer-motion`, `recharts` — 41 packages out of the tree. Closes L-5 from Prompt 0.2. Nothing was
built to justify keeping them.

### Item 4 — authentication rate limiting, enforced in PostgreSQL

The in-process limiter is gone (`src/server/rate-limit.ts` deleted). One row per `(scope, keyHash)`
in the new `AuthRateLimit` table holds a fixed window, and each attempt is counted by a single
`INSERT … ON CONFLICT (scope, keyHash) DO UPDATE … RETURNING` statement. PostgreSQL row-locks the
conflicting row, so simultaneous attempts serialise and the counter is exact: there is no
read-then-write window. The statement computes `now()` once and reuses it through `excluded`, so
the expiry comparison and the new window start cannot drift apart mid-statement.

Registration is limited per client address and answers `429` with `Retry-After` and fixed body
text. Credential sign-in is limited per identifier **and** per client address, enforced inside
NextAuth's `authorize` **before** the user lookup and **before** `bcrypt.compare`, so a flood of
guesses cannot become a flood of password hashes.

`keyHash` is an HMAC-SHA256 of the normalised identifier keyed with `AUTH_RATE_LIMIT_PEPPER`, or a
value derived from `NEXTAUTH_SECRET` when unset — never a plain email or raw IP. A refused attempt
counts but never extends the window. A successful sign-in forgets that identifier's window while
the address window stays. Expired rows are deleted in bounded batches of 1,000 behind
`AuthRateLimit_expiresAt_idx`, sampled at 2% of new windows; the function is exported for a
scheduled job in Phase 1.5. The first refusal of each window writes one `auth.rate_limited` audit
row carrying scope, limit, window length and a 12-character prefix of the keyed hash — no
credential, no identifier — and later refusals in the same window add nothing.

Five validated environment variables carry the thresholds, defaults 10 attempts per 15 minutes.
A typo fails startup rather than disabling the limit: `0` is refused; there is no "off" switch.

`tests/integration/auth-rate-limit.test.ts` (18): exact allowance then refusal with a retry-after;
three times the limit fired **in parallel** allowing exactly `max` and counting every attempt once;
per-address isolation; a missing address not crashing; window expiry starting a fresh window in the
same row; refusals not extending the window; pruning removing only expired rows; identifier
normalisation sharing one window across capitalisation and padding; password spraying capped by the
address window; reset on success clearing only the identifier window; known and unknown accounts
answered identically; the stored row containing no identifier; the audit row's exact key set with no
email, address or password anywhere in it. Four further tests drive the **real** `authorize`
function from the options object: sign-in succeeding and clearing its window, refusal for a correct
password once exhausted, wrong password and unknown account answering identically, and the
identifier window still applying when no address header is present.

That last group is why the real function is used rather than a copy: it caught that next-auth v4
keeps the configured `authorize` under `provider.options` while the top-level one is a stub
returning `null`. A test against the top-level property would have passed while proving nothing.

NextAuth's flow and its limits are documented in `docs/PHASE-0-IMPLEMENTATION.md` §9.

### Item 5 — runtime-role membership is handed back

`scripts/db-roles.mjs` granted the migrator membership in the runtime role on every non-superuser
run and never revoked it. Membership is privilege — a member can `SET ROLE` into the runtime role —
so leaving it behind defeats part of the separation the role split exists to create.

The grant is now taken only when missing and revoked inside the same transaction, immediately after
the pgboss ownership transfer; ownership is a catalog fact and survives. A membership that existed
**before** the run is detected, left exactly as it was, and reported with the manual `REVOKE` to
run if it is unintended. The verification pass fails if a membership this run granted was not
revoked, or if the migrator is a member without this run having granted it, and the `OK` line now
lists the role's members.

The decision lives in `scripts/lib/db-role-membership.mjs` because the live path here runs as a
**superuser** migrator, which never takes the grant at all — the branch that matters most would
otherwise be untested. `tests/unit/db-role-membership.test.ts` (4) covers all four combinations and
asserts both invariants directly: never revoke without having granted, never revoke a pre-existing
membership. `tests/integration/runtime-role.test.ts` (37) adds: no role is a member of the runtime
role after setup, the migrator is a member of nothing, and the runtime role owns the pgboss schema
and every object in it while still unable to create anything in `public`. Its 29 ledger-bypass
attempts continue to fail on privilege.

Both live paths were exercised by hand (§4 #16–17): grant-and-revoke leaves `members: [none]`; a
pre-existing membership produces the notice and is left in place.

### Item 6 — final schema and index review

`tests/integration/schema-review.test.ts` (32) lists every Phase 0 access path in words with the
constraint or index it depends on, and checks each against the **actual migrated catalog**
(`pg_index`/`pg_attribute`, not the Prisma schema): index name, table, column list in order,
uniqueness, and the predicate of partial indexes. Uniqueness is asserted against
`pg_index.indisunique`, so identity can never be quietly downgraded to an ordinary index.

All 13 required paths were already present; **no index was added**. Covered: tenant + date, card +
date, location + date, customer-business-profile + date and transaction-group lookup on the ledger;
one reversal per original operation (partial unique); external event de-duplication; idempotency by
business + key; the three global card tokens; one card per profile per template; UTM public token
and name-per-template; staff membership and staff-location lookups; audit log by business and by
actor with date; the rate-limit window and its expiry sweep; one ACTIVE version per template;
version numbering per template; one default location per business; customer phone identity;
merchant email. Also asserted: the ledger has no `updatedAt` and its identity columns are NOT NULL;
`AuthRateLimit` has exactly the columns and timestamp types the atomic upsert relies on; every
application table has a primary key; all five protective triggers exist **and are enabled** —
a disabled trigger is a silent hole a presence-only check would miss.

---

## 4. Commands and results

Execution order; decisive lines only. Read-only unless stated.

| # | Command | Result |
|---|---|---|
| 1 | `docker info` | daemon **29.7.2** running |
| 2 | `git status --porcelain`; `git log --oneline -3` | clean at `5474e1e` |
| 3 | Read spec, phase plan, implementation guide, 0.2 evidence, decisions; inspected ledger, auth, role script, tests, gate, CI | baseline understood before any change |
| 4 | `grep -rn transactionGroupId src tests` | no production caller supplied it → removal is clean |
| 5 | item 2 implemented; `npx tsc --noEmit` | 0 errors |
| 6 | `npx vitest run --project integration tests/integration/transaction-group.test.ts` | **6 passed** |
| 7 | item 1 implemented; first run | 2 failures — the test helper set `countsAsVisit` for IMPORT/SYSTEM sources, which the visit policy forbids; helper corrected |
| 8 | `npx vitest run …/system-audit.test.ts …/transaction-group.test.ts` | **14 passed** |
| 9 | `npx vitest run --project integration` (regression check) | **136 passed**, 18 files |
| 10 | commits `c4ba65c`, `374ff3d` | intermediate ledger state reconstructed so item 2 compiles alone; `npx tsc --noEmit` verified on it |
| 11 | item 5 implemented | `decideMembershipAction` extracted to `scripts/lib/` |
| 12 | `node scripts/db-roles.mjs` ×3 | idempotent; `members: [none]` each time |
| 13 | `GRANT walaaplus_app TO walaaplus` then `node scripts/db-roles.mjs` | **NOTICE** printed, membership left in place, `members: [walaaplus]` |
| 14 | `REVOKE walaaplus_app FROM walaaplus` | test database returned to its clean state |
| 15 | `npx vitest run --project unit tests/unit/db-role-membership.test.ts` | **4 passed** |
| 16 | `npx vitest run --project integration tests/integration/runtime-role.test.ts` | **37 passed** |
| 17 | commit `f26d2cd` | — |
| 18 | item 4: schema model + migration `20260911130000_auth_rate_limit`; `npx prisma validate` | schema valid |
| 19 | `npx vitest run …/auth-rate-limit.test.ts` (first run) | **14 passed** |
| 20 | added the NextAuth-path tests | 2 failures — `providers[0].authorize` is next-auth's stub; the configured function lives under `provider.options` |
| 21 | accessor corrected; rerun | **18 passed** |
| 22 | `npx vitest run --project unit` | **32 passed** |
| 23 | commit `81cf103` | — |
| 24 | catalogue query of every index on the reviewed tables | all 13 required paths already present |
| 25 | `npx vitest run …/schema-review.test.ts` | **32 passed** |
| 26 | commit `a616f85` | — |
| 27 | `npm audit --json` | 3 high, 1 moderate, 1 low — all dev-only, all with a fix available |
| 28 | `npm view <pkg> versions` for each finding | first fixed release on each existing major identified |
| 29 | overrides applied; unused deps removed; `npm install` | added 1, **removed 41**, changed 26 |
| 30 | `npm audit` (full tree) | **found 0 vulnerabilities** |
| 31 | 18 lint warnings fixed at source; `npx eslint .` | **0 problems** |
| 32 | `--max-warnings=0` added to the gate and `npm run lint`; `npm run lint` | clean |
| 33 | `npm run gate` | **GATE PASSED 13/13 in 58.7 s** |
| 34 | commit `f356d75` | final code commit |
| 35 | **`npm run gate`** on `f356d75` | **GATE PASSED 13/13 in 56.0 s** — §5 |
| 36 | `npm audit` | **found 0 vulnerabilities** |
| 37 | `npm audit --omit=dev --audit-level=high` | **found 0 vulnerabilities** |
| 38 | `git diff --check`; `git status --porcelain` | clean; clean |
| 39 | `git rev-parse master prototype-baseline^{commit}`; `git for-each-ref refs/remotes`; branch upstream | `b9ee686`; `0aee6ee`; only `origin/master`; **no upstream** |

---

## 5. Final gate output (verbatim summary)

Run on `f356d75`, the final code commit.

```
=============================================================
GATE SUMMARY
=============================================================
PASS  dependency audit (prod, high+)             1010 ms
PASS  prisma generate                            1583 ms
PASS  lint                                       4468 ms
PASS  typecheck                                  2622 ms
PASS  prisma validate                            1493 ms
PASS  unit tests                                 1400 ms
PASS  test db up                                  946 ms
PASS  migrate deploy (test db, migrator role)    1732 ms
PASS  migrate status (test db)                   1928 ms
PASS  runtime role grants (test db)               161 ms
PASS  integration tests                         24334 ms
PASS  worker build                                129 ms
PASS  production build                          14214 ms
-------------------------------------------------------------
GATE PASSED in 56.0s (13/13 steps)
```

**CI run URL: none.** The workflow exists and is unchanged in intent, but pushing is forbidden
until owner decision A1. The local gate above is the witness for this prompt.

---

## 6. Test totals

| Project | Files | Tests | Database |
|---|---|---|---|
| unit | 5 | **32** | none |
| integration | 20 | **188** | real PostgreSQL 15, connected as the restricted runtime role |

New in this prompt: `transaction-group.test.ts` (6), `system-audit.test.ts` (8),
`auth-rate-limit.test.ts` (18), `schema-review.test.ts` (32), `db-role-membership.test.ts` (4,
unit), and 2 added to `runtime-role.test.ts`. Removed: `tests/unit/rate-limit.test.ts`, together
with the in-process limiter it covered.

---

## 7. Dependency audit

| View | Result |
|---|---|
| `npm audit --omit=dev --audit-level=high` (gate step, production dependencies) | **0 vulnerabilities** |
| `npm audit` (full tree, dev tooling included) | **0 vulnerabilities** |

There are therefore **no moderate or low findings left to document**. No allowlist, ignore list,
suppression file or `audit-level` relaxation exists anywhere in the repository, and
`npm audit fix --force` was not used. Every fix is a pinned override in `package.json`, listed in
§3 item 3, verified by the full gate on the upgraded tree.

---

## 8. Manual checks

| Check | Result |
|---|---|
| `db-roles.mjs` grant-and-revoke path | `members: [none]` after the run |
| `db-roles.mjs` pre-existing membership path | NOTICE printed with the manual `REVOKE`; membership left in place |
| `db-roles.mjs` run three times in a row | idempotent, same OK line |
| Runtime role after a full gate | `20 public tables`, append-only on `LoyaltyOperation`, no access to `_prisma_migrations`, owns `pgboss`, cannot CREATE in `public`, `members: [none]` |
| `next build` with the reduced dependency tree | succeeds (gate step 13) |
| `.env.example` | variable names only; the five new rate-limit variables documented with their defaults |

---

## 9. Remaining items, carried forward

Nothing critical or high remains. Each item below is recorded with severity, why it is accepted
now, who owns it, and where it lands.

| # | Sev | Item | Why accepted now | Owner | Follow-up |
|---|---|---|---|---|---|
| M-5 | Medium | Registration answers "an account with this email already exists" on conflict — an account-enumeration vector distinct from rate limiting | ~~Accepted pending an email-verification flow~~ — **that acceptance was rejected in review. Resolved in the remediation (`7f59eb1`): the route answers a duplicate exactly as it answers a new registration. See §11.** | — | closed |
| L-8 | Low | A rate-limited sign-in returns NextAuth's generic failure, with no `429`/`Retry-After` | NextAuth owns `/api/auth/callback/credentials`; returning a status from `authorize` is not possible. The limit is still enforced, and the genericity is also the enumeration defence | development agent | Phase 1a, with the real sign-in UI |
| L-9 | Low | Expired rate-limit windows are pruned opportunistically (2% of new windows), not on a schedule | Bounded batches behind an index; the table cannot grow without new windows being created. A scheduled job needs the job runner to take on business jobs | development agent | Phase 1.5 |
| L-10 | Low | `LoyaltyOperation` foreign-key columns `customerId`, `templateId`, `programVersionId`, `rewardTierId`, `performedByUserId` have no index | No Phase 0 access path queries them, and each index costs write throughput on the highest-volume table. Ledger rows are never deleted and non-DRAFT parents cannot be | development agent | Phase 1b, when reporting defines the real queries |
| L-11 | Low | `db-roles` needs a migrator that is superuser or holds CREATEROLE | Documented in the implementation guide §4; it is a provisioning fact, not a code limitation | owner | staging/production provisioning |
| — | — | L-2, L-3, L-4, L-6, L-7 from Prompt 0.2 | unchanged | — | as recorded there |

**Correction:** this table was written before review. M-5 is closed by the remediation in §11,
and one risk it did not identify at all — trusting a forgeable `X-Forwarded-For` while the app
was directly exposed — is recorded and fixed there too.

**Closed by this prompt:** M-1 and M-2 (sidebar, registration rate limit — M-2 fully, sign-in
included), M-4 (runtime role), L-1 (lint warnings), L-5 (unused dependencies), plus the six
architect findings from the 0.2 remediation.

---

## 10. Boundaries

- `master` is at `b9ee686`, untouched: not committed to, merged into, or pushed.
- Tag `prototype-baseline` → `0aee6ee`, unchanged.
- No commit amended, no history rewritten. Six focused code commits, one per item.
- **Nothing pushed**: the branch has no upstream and `origin/master` is the only remote ref.
  Nothing deployed, no cloud resource provisioned, repository visibility unchanged.
- No live credential requested, generated, held, logged or committed. `.env.example` contains
  variable names only. The runtime-role and CI passwords are dev/CI fixtures, not credentials to
  any real system. The rate-limit pepper defaults to a value derived from `NEXTAUTH_SECRET` and is
  never logged.
- Staging, CI, backups and deployment were **not** verified: none of them was run, and none could
  be without owner authority. No claim in this file depends on them.
- No Phase 1a functionality was built: no scanner, no enrollment, no card mechanics, no customer
  PWA. The prototype pages remain hidden from navigation.
- Owner decisions A1–A5, B1–B6, C1–C5 are unchanged and none is marked approved.

---

**Original status line, superseded by §11:** PASS — PHASE 0 PROMPT 3 ENGINEERING GATE COMPLETE.
Withdrawn in review; see §11 for the re-issued result.

---

## 11. Security remediation — Prompt 0.3 R

**Date:** 2026-09-11 · **Performed by:** development agent (Claude Opus 5) · **Branch:** `rebuild/phase-0-foundation`
**Trigger:** review of the record above. Everything in §1–§8 was independently confirmed, and two
security requirements were found unmet. Both were treated as blockers, not as debt.

### 11.1 Result

**GATE PASSED — 13/13 steps in 66.2 s** on `78a816b`, the final code commit. Unit **42/42**,
integration **197/197** against real PostgreSQL, every test connected as the restricted runtime
role. `npm audit`, full tree and production view: **0 vulnerabilities** each. `git diff --check`
clean; working tree clean. Nothing pushed, deployed or provisioned; no credential requested or held.

### 11.2 Commits

| Blocker | SHA | Subject |
|---|---|---|
| 1 | `7f59eb1` | fix(security): registration no longer reveals whether an email has an account |
| 2 | `78a816b` | fix(security): stop trusting forgeable forwarding headers; put the app behind a proxy |
| — | recorded in the final response | docs: this section |

### 11.3 Blocker 1 — registration revealed whether an email has an account

**Finding.** `registerBusinessOwner` raised `ConflictError("An account with this email already
exists")` and the route forwarded it verbatim, so a public endpoint answered "this address is
registered" to anyone who asked.

**Fix.** The route answers a duplicate exactly as it answers a new registration: `202` with the
same fixed body and the same header set. The service still raises `ConflictError` internally — the
seed and future admin paths need the truth — and the public boundary flattens it. Two details make
the paths indistinguishable rather than merely similar:

- the response carries **no identifier of anything created**. The old `201` returned `businessId`,
  which by itself was an oracle;
- `registerBusinessOwner` hashes the password **before** opening its transaction, so both paths pay
  the same bcrypt cost and the duplicate case is not measurably faster.

Malformed input keeps its own `400`: input shape describes the request, not the account. When the
email provider of decision D3 lands, this becomes the usual "check your inbox", and the
existing-account case is told by email instead of over HTTP.

**Proof.** `tests/integration/register-route.test.ts`, driving the real route handler: duplicate
and fresh submissions match on status, body and header set; the duplicate body contains no
"already", "exists", "conflict" or "duplicate", no email, no user or business id, and no
`businessId` property; the duplicate creates no rows while a fresh email creates exactly one
account; malformed input still returns 400.

### 11.4 Blocker 2 — the client address was forgeable, and the app was directly exposed

**Finding.** `clientIp()` believed any inbound `X-Forwarded-For` while `docker-compose.yml`
published `web` on port 3000. A caller could send a different forged header on every request and
walk past the per-address registration limit. A limit that looks present and is not is worse than
no limit, because it is trusted.

**Fix — application.** `TRUST_PROXY_HEADERS`, accepting exactly `"true"` or `"false"`, **defaults
to false**. With it off the forwarding headers are ignored entirely and the app reports no client
address: no address is better than a forgeable one. With it on, the value taken is the **last** hop
of `X-Forwarded-For` — anything earlier arrived with the request — and it must parse as an IPv4 or
IPv6 address, with ports and brackets stripped and case normalised, so arbitrary text can never
become a rate-limit key. NextAuth's `authorize()` carried its own copy of the old logic with the
same flaw; it now calls the shared helper, so there is one trust decision in the codebase.

**Fix — network.** A `proxy` service (Caddy, `deploy/Caddyfile`) is now the only published service,
on `WEB_PORT` (default 8080). It **sets** `X-Forwarded-For`, `X-Real-IP`, `X-Forwarded-Proto` and
`X-Forwarded-Host` from the connection it actually received, and strips `Forwarded`,
`X-Forwarded-Server`, `X-Client-IP`, `CF-Connecting-IP` and `True-Client-IP`. `web` moved from
`ports:` to `expose:`, so no path to the application bypasses the proxy — which is what makes
`TRUST_PROXY_HEADERS=true` defensible for that service.

**Fix — not depending on it.** Because a trustworthy address is not available in every deployment,
registration no longer depends on one: it also has a per-submitted-email window, so the endpoint
stays limited whatever the network boundary looks like.

**Manual proof of the proxy.** The real `deploy/Caddyfile` was run in Caddy against an echo
upstream on the project's Docker network:

| Sent by the client | Received by the application |
|---|---|
| `X-Forwarded-For: 6.6.6.6` | `172.25.0.1` — the real connection |
| `X-Real-IP: 6.6.6.6` | `172.25.0.1` |
| `True-Client-IP`, `CF-Connecting-IP`, `X-Client-IP`, `Forwarded`, `X-Forwarded-Server` | **absent** |
| `X-Forwarded-For: 1.1.1.1, 2.2.2.2` | `172.25.0.1` |

The forged value `6.6.6.6` appears nowhere in what the application receives. Both throwaway
containers were removed afterwards; no Compose service was left running.

**Proof — tests.** `tests/unit/client-ip.test.ts` (10): untrusted ignores every header and
collapses fifty forged addresses to one outcome; trusted takes the last hop out of two and of
three; `x-real-ip` is a fallback only; junk, out-of-range and unterminated values are refused;
ports and IPv6 forms normalise. `tests/integration/register-route.test.ts` (8 in total): with no
trusted proxy, three requests carrying three forged addresses create **zero** per-address windows
and three per-email ones; with the proxy trusted, three forged prefixes collapse to **one** window
keyed on the real address with three attempts counted; the caller is refused once that window is
exhausted, with a generic body naming neither window nor address; and registration stays limited
per email when there is no address at all. The NextAuth sign-in test asserts the same boundary in
both modes.

### 11.5 Verification

| # | Command | Result |
|---|---|---|
| 1 | Caddy + echo upstream with forged headers (table above) | forged values replaced or stripped |
| 2 | `npx vitest run --project unit tests/unit/client-ip.test.ts` | **10 passed** |
| 3 | `npx vitest run --project integration tests/integration/register-route.test.ts` | **8 passed** |
| 4 | `npx vitest run --project integration` | 1 failure: the old sign-in test asserted an address window built from a raw header. The assertion, not the code, was now wrong; it was updated to assert both modes |
| 5 | `npx vitest run --project integration tests/integration/auth-rate-limit.test.ts` | **19 passed** |
| 6 | `npm run gate` on `78a816b` | **GATE PASSED 13/13 in 66.2 s** |
| 7 | `npm audit`; `npm audit --omit=dev --audit-level=high` | **0 vulnerabilities** each |
| 8 | `git diff --check`; `git status --porcelain` | clean; clean |
| 9 | `git rev-parse master`; remote refs; branch upstream | `b9ee686`; only `origin/master`; **no upstream** |

```
=============================================================
GATE SUMMARY
=============================================================
PASS  dependency audit (prod, high+)             1092 ms
PASS  prisma generate                            1741 ms
PASS  lint                                       4497 ms
PASS  typecheck                                  5063 ms
PASS  prisma validate                            1545 ms
PASS  unit tests                                 1441 ms
PASS  test db up                                  948 ms
PASS  migrate deploy (test db, migrator role)    1508 ms
PASS  migrate status (test db)                   1543 ms
PASS  runtime role grants (test db)               158 ms
PASS  integration tests                         32528 ms
PASS  worker build                                186 ms
PASS  production build                          13942 ms
-------------------------------------------------------------
GATE PASSED in 66.2s (13/13 steps)
```

### 11.6 What an operator must keep together

`TRUST_PROXY_HEADERS` is false unless set. A deployment that exposes the application directly has
no per-address limiting — by design and visibly, rather than a limit that looks present and is not.
The Compose stack sets it to `true` for `web` only because `proxy` overwrites the headers and `web`
is not published. Staging and production must keep both halves together: if the application is ever
reachable without the proxy, `TRUST_PROXY_HEADERS` must go back to false. Documented in
`docs/PHASE-0-IMPLEMENTATION.md` §9, "Trusting the client address".

### 11.7 Remaining items after this remediation

M-5 is **closed**. L-8, L-9, L-10 and L-11 from §9 stand unchanged, as do L-2, L-3, L-4, L-6 and
L-7 from Prompt 0.2. Nothing critical or high remains, and no moderate item is outstanding.

One deliberate trade-off is worth naming: the per-email registration window means a caller can
consume another person's registration allowance for a chosen address, delaying that person's
sign-up by one window. The alternative — no email window — leaves registration unlimited wherever
no trusted address exists, which is the worse failure. Revisit when email verification lands in
Phase 1a.

### 11.8 Boundaries

Unchanged from §10: `master` at `b9ee686`, tag `prototype-baseline` at `0aee6ee`, no amend, no
rewrite, nothing pushed (the branch has no upstream), nothing deployed or provisioned, no live
credential requested, generated, held or committed. The proxy verification used throwaway local
containers on the project's existing Docker network, and both were removed. No Phase 1a
functionality was built.

---

**PASS — PHASE 0 PROMPT 3 ENGINEERING GATE COMPLETE — READY FOR PHASE 1A PROMPT 1**
