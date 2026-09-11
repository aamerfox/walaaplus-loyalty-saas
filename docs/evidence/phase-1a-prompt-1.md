# Evidence — Phase 1a, Prompt 1

**Prompt:** Stamp-Café Core — core domain logic, authorization, real-PostgreSQL tests
**Date:** 2026-09-11
**Performed by:** development agent (Claude Opus 5)
**Branch:** `rebuild/phase-0-foundation`
**Predecessor:** Phase 0 Prompt 3 + two remediations — PASS (`docs/evidence/phase-0-prompt-3.md` §12)
**Revision:** first submission returned by review for a scope breach — the stamp engine accepted a
`locationId`, which let an owner operate a second counter before Phase 1b. Fixed and re-verified; see §9.

---

## 1. Result

**GATE PASSED — 13/13 steps in 214.5 s** on `<<FINAL_SHA>>`, the final code commit. Unit
**119/119** (11 files), integration **309/309** (27 files) against real PostgreSQL 15, every
integration test connected as the restricted runtime role. `npm audit`, full tree and production view: **0
vulnerabilities** each. `git diff --check` clean; working tree clean.

**No migration was required.** Every field this phase needs already exists from Phase 0.

Nothing was pushed, deployed or provisioned. No Prompt 2 work was started: there are no pages, no
route handlers, no PWA or service worker, no camera scanning and no public customer pages.

---

## 2. Commits

On top of `e1b8346`. `master` untouched at `b9ee686`; tag `prototype-baseline` → `0aee6ee`. No
amend, no rewrite. Four commits, split by layer so each one compiles on its own — the five services
are mutually dependent, so splitting them further would have produced commits that do not build.

| # | SHA | Subject |
|---|---|---|
| 1 | `17513ca` | feat(program): typed stamp mechanics, business-day maths and opaque card tokens |
| 2 | `69f1fab` | feat(stamp): program, enrollment, lookup, cashier and stamp-engine services |
| 3 | `27b40e4` | test(stamp): real-PostgreSQL coverage for the Phase 1a café loop |
| 4 | `372fdeb` | docs: Phase 1a implementation guide, and resolve the card-issuance contradiction |
| 5 | `ea8f1df` | docs(evidence): Phase 1a Prompt 1 core gate record (first submission) |
| 6 | `<<FINAL_SHA>>` | fix(stamp): Phase 1a writes only at Main; the location is never a caller's input (§9) |

25 files changed in commits 1–4, 4,798 insertions; the scope fix in §9 touches 5 more.

---

## 3. What was built

Design detail lives in [PHASE-1A-IMPLEMENTATION.md](../PHASE-1A-IMPLEMENTATION.md); this section
records what exists and why each choice was made.

### 3.1 Versioned mechanics (`src/server/program/mechanics.ts`)

A strict Zod contract over `ProgramVersion.mechanics`, carrying exactly the Phase 1a settings the
prompt lists and nothing else. Two readers: `parseStampMechanics` for merchant input
(`ValidationError`, 400, with field issues) and `readStampMechanics` for a version already stored
(`LedgerInvariantError`, 422, naming the version). The second never falls back to a default —
guessing a threshold would hand out the wrong number of rewards.

**Deferred mechanics are refused, not ignored.** `pointsPerVisit`, `cashbackPercent`,
`cardExpiryMode`, `inactivityExpiryDays`, `birthdayStamps`, `referralBonusStamps`, `promotions`,
`utmCampaigns`, `availableLocations` and a plain typo all fail validation. A merchant who typed a
rule the engine silently dropped would believe it was in force.

A welcome bonus that alone completes a card is refused: otherwise enrolling earns a free coffee.

### 3.2 Program creation (`src/server/program/stamp-program.ts`)

Template, version 1, its reward tier and the `direct` source in one transaction, in the order the
triggers force: the tier is written while the version is DRAFT, the version is activated last. The
business row is locked with `SELECT … FOR UPDATE` first, so two owners clicking at once cannot both
pass the one-live-program check. That rule is a service rule, not a constraint, because Phase 1b
lifts it. The program resolves the business's default `Main` location and the phase operates there.

### 3.3 Card issuance is audited, not ledgered

The prompt asked for this to be resolved consistently with the non-zero ledger quantity invariant.

PRODUCT-SPEC §6.1 sketched a `CARD_ISSUED` operation. The ledger refuses zero-quantity rows — that
invariant is what makes every ledger row a real movement of value — and issuing a card moves none.
A `+0` row would break the invariant; a `+1` row would be exactly the "fake zero-value award" the
prompt rules out. **There is no `CARD_ISSUED` row.** Issuance is evidenced by
`CustomerCard.issuedAt`, `CustomerCard.utmSourceLinkId` and an `AuditLog` `card.issued` entry
carrying template, version, profile and source — and neither the phone number nor any card token.
The `CARD_ISSUED` enum value stays unused. A welcome bonus, which does move value, is a real
`WELCOME_BONUS` operation. The spec now records this resolution rather than contradicting it.

### 3.4 Phone identity (`src/server/customers/phone.ts`)

Accepts `+963…`, `00963…`, `963…`, `0…` and bare national forms with any separators, plus
Arabic-Indic digits. Refuses foreign numbers with a distinct message — truncating `+9715…` into a
Syrian-looking number would merge two different people — refuses Syrian **landlines** (see §7,
L-1), and refuses ambiguous lengths rather than choosing an interpretation.

### 3.5 Enrollment (`src/server/customers/enrollment.ts`)

Public: no session, no tenant context, no merchant login in the path. Written with
`INSERT … ON CONFLICT DO NOTHING RETURNING` rather than `upsert`, because `upsert` is
read-then-write and loses the race, and catching `P2002` inside a transaction is useless once the
transaction is poisoned. Inserts always run customer → profile → card, so concurrent enrollments
queue rather than deadlock.

**The card insert arbitrates the welcome bonus.** `RETURNING id` yields a row only to the
transaction that actually inserted the card, so exactly one caller writes the welcome stamps, in
the same transaction. No idempotency key is involved, so the bonus cannot be duplicated by a retry
that forgot one, nor lost by a retry that reused one.

A repeat enrollment returns the existing card and **does not overwrite the stored name or
consent** — anyone can open a public form and type someone else's number.

### 3.6 Stamp engine (`src/server/stamp/engine.ts`)

Five verbs: manual award, visit award, purchase award, redemption, reversal. Each runs under
`runIdempotent`, **locks the card row before** reading balances or counting today's awards, reads
mechanics from the version pinned to the card, and writes one atomic group through
`appendOperationGroup` — which derives business and actor from the verified context and refuses a
caller-supplied transaction group id.

Conversion is immediate and atomic, the remainder carries forward, and one award may complete
several rewards; quantities carry the multiplicity, so a 25-stamp award on a 10-stamp program
writes `STAMP_CONVERTED −20` and `REWARD_EARNED +2`. Purchases earn whole blocks only,
floor-rounded, remainder discarded — two separate 5,000 purchases earn nothing at 10,000 per block.
Redemption decrements `rewardBalance` by one and never touches stamps. `PAUSED`, `EXPIRED` and
`DELETED` cards are refused, as is any card whose `expiresAt` has passed regardless of status.

Daily limits count award **operations** per card per **business-timezone day**, computed as
absolute UTC instants so the query stays on the ledger's `(customerCardId, createdAt)` index.

### 3.7 Cashiers (`src/server/staff/cashiers.ts`)

Owner-only, checked on the **role** so it cannot be widened by granting `EDIT_STAFF` to a manager.
Role defaults only (empty explicit permissions), assigned to `Main` and nowhere else.

### 3.8 Lookup (`src/server/customers/lookup.ts`)

QR, phone and serial lookup, the customer directory, and a card's history. Every query is
**filtered** by `businessId`, so another business's identifier is `NotFoundError` — the same answer
as something that does not exist. The directory is closed to cashiers (their `VIEW_CUSTOMERS` is
scoped to the scanned or searched customer); a card's operations are narrowed to a cashier's
assigned locations, and an unassigned cashier sees nothing.

---

## 4. Commands and results

| # | Command | Result |
|---|---|---|
| 1 | `git status --porcelain`; `docker info` | clean at `e1b8346`; daemon 29.7.2 |
| 2 | Read spec, phase plan, Phase 0 guide, Prompt 0.3 evidence, decisions | scope and existing invariants established before any change |
| 3 | Schema and service inspection (models, enums, ledger, visits, permissions, reconciliation) | confirmed **no migration needed**: every field already exists |
| 4 | Smoke-ran the pure helpers through `tsx` | phone spellings, day ranges, floor rounding and conversion verified before writing tests |
| 5 | `npx vitest run --project unit` | 3 failures, all mine: two asserted on `ValidationError.message` where the detail lives in `.issues`, one miscounted a year's local days at the zone boundary. Assertions corrected |
| 6 | `npx vitest run --project unit` | **119 passed** |
| 7 | `npx vitest run --project integration tests/integration/stamp-program.test.ts` | 1 failure: asserted the trigger's wording as `/DRAFT/`, actual text is "immutable after activation". Assertion matched to the trigger |
| 8 | same, re-run | **15 passed** |
| 9 | `npx vitest run --project integration tests/integration/enrollment.test.ts` | 2 failures: concurrent enrollments exceeded Prisma's 2 s `maxWait`. Enrollment queues by design, so `CONTENDED_TX` (10 s wait, 20 s statement timeout) was added for enrollment, program and cashier creation |
| 10 | same, re-run | **18 passed** |
| 11 | `npx vitest run --project integration tests/integration/stamp-engine.test.ts` | 1 failure, assertion wrong not code: twelve concurrent +1 awards legitimately repeat `balanceAfter` because the tenth converts and resets the stamp balance. Replaced with the exact multiset `[1,1,2,2,3,4,5,6,7,8,9,10]`, which no lost update can produce |
| 12 | same, re-run | **34 passed** |
| 13 | `npx vitest run --project integration tests/integration/daily-limit.test.ts` | 1 failure: assumed two zones always differ in local date; they share one for part of each day. Replaced with a deterministic same-zone window check |
| 14 | same, re-run | **9 passed** |
| 15 | `npx vitest run --project integration` (lookup + cashier) | **33 passed** first run |
| 16 | `npx tsc --noEmit`; `npx eslint . --max-warnings=0` | 0 errors; 0 warnings |
| 17 | `npm run gate` | **GATE PASSED 13/13 in 231.4 s** |
| 18 | four commits (`17513ca`, `69f1fab`, `27b40e4`, `372fdeb`) | each layer compiles on its own |
| 19 | **`npm run gate`** on `372fdeb` | **GATE PASSED 13/13 in 230.1 s** — §5 |
| 20 | `npm audit` | **0 vulnerabilities** |
| 21 | `npm audit --omit=dev --audit-level=high` | **0 vulnerabilities** |
| 22 | `git diff --check`; `git status --porcelain` | clean; clean |
| 23 | `ls prisma/migrations` | 5 migrations, **unchanged** from Phase 0 |
| 24 | `git rev-parse master prototype-baseline`; remote refs; branch upstream | `b9ee686`; `0aee6ee`; only `origin/master`; **no upstream** |

---

## 5. Final gate output

```
=============================================================
GATE SUMMARY
=============================================================
PASS  dependency audit (prod, high+)             1097 ms
PASS  prisma generate                            1531 ms
PASS  lint                                       5565 ms
PASS  typecheck                                  4924 ms
PASS  prisma validate                            1672 ms
PASS  unit tests                                 1687 ms
PASS  test db up                                  958 ms
PASS  migrate deploy (test db, migrator role)    5876 ms
PASS  migrate status (test db)                   5594 ms
PASS  runtime role grants (test db)               152 ms
PASS  integration tests                        170614 ms
PASS  worker build                                122 ms
PASS  production build                          14709 ms
-------------------------------------------------------------
GATE PASSED in 214.5s (13/13 steps)
```

`migrate status (test db)` reports the schema up to date against the five existing migrations. The
*development* database on port 5433 is empty and unmigrated — its container was recreated during
the Prompt 0.3 network cleanup — which affects nobody: every test and every gate step runs against
the disposable test database.

**CI run URL: none.** Pushing is still forbidden until owner decision A1. The local gate is the
witness.

---

## 6. Test totals

| Project | Files | Tests | Database |
|---|---|---|---|
| unit | 11 | **119** | none |
| integration | 27 | **309** | real PostgreSQL 15, as the restricted runtime role |

New in this prompt — 71 unit and 112 integration tests:

| File | Tests | Covers |
|---|---|---|
| `unit/stamp-mechanics.test.ts` | 38 | contract validation, strictness against 10 deferred mechanics, spend-block floor rounding, conversion invariant swept over 350 combinations |
| `unit/syrian-phone.test.ts` | 12 | 12 spellings collapsing to one value, Arabic-Indic digits, foreign/landline/ambiguous/injection refusals |
| `unit/business-day.test.ts` | 10 | Damascus boundaries, half-open days, 23- and 25-hour DST days, gapless year in a half-hour zone |
| `unit/card-tokens.test.ts` | 11 | entropy, uniqueness over 2,000 draws, no shared prefixes, per-position alphabet spread, QR ≠ page token |
| `integration/stamp-program.test.ts` | 15 | the four rows created together, version/tier/cardType frozen, one program per business, authorization |
| `integration/enrollment.test.ts` | 18 | pinned version, phone normalisation, opaque tokens, **6 concurrent enrollments → one customer/profile/card**, welcome bonus exactly once, one person in two businesses, issuance audited not ledgered |
| `integration/stamp-engine.test.ts` | 37 | manual/visit/purchase awards, conversion group, multiple rewards, remainder, redemption, reversal, idempotency, **12 concurrent awards with no lost update**, card-status refusals, tenant isolation, **one-location enforcement (§9)**, reconciliation |
| `integration/daily-limit.test.ts` | 9 | limit enforced and unslippable under a burst, operations not stamps, per card, **business-timezone day boundary** |
| `integration/customer-lookup.test.ts` | 19 | QR/phone/serial tenant isolation, page token refused as scan token, directory closed to cashiers, operations narrowed by location |
| `integration/cashier.test.ts` | 14 | role defaults and Main assignment, owner-only creation unwidenable by `EDIT_STAFF`, location restriction, deactivation takes effect at once |

Every concurrency, enrollment, idempotency, ledger and timezone test runs against real PostgreSQL.
None of them is mocked.

---

## 7. Findings and limitations

Nothing critical or high. Each item below carries severity, owner and follow-up phase.

| # | Sev | Item | Why it is acceptable now | Owner | Follow-up |
|---|---|---|---|---|---|
| **M-6** | **Medium** | **The enrollment service has no rate limiting or honeypot.** PRODUCT-SPEC §6.1 requires both, because a welcome bonus makes enrollment an abuse target | The service is not reachable: no route handler exists yet, and this prompt is forbidden from adding one. Rate limiting needs the client address, which belongs at the route, not inside a domain service | development agent | **Phase 1a Prompt 2 — the enrollment route must not ship without it.** The database-backed limiter from Prompt 0.3 already exists and needs only an enrollment scope |
| L-1 | Low | Syrian **landlines are refused**; only mobile numbers enrol | The product delivers the card, and later its restore link, over mobile messaging: a landline creates an identity that cannot receive what identifies it. Refusing is safer than storing an unusable contact | owner (product call) | Phase 1b, if pilot merchants ask |
| L-2 | Low | A manual award is allowed in **every** earn mode, not only `MANUAL` | A café always needs "the tablet was down, give them their stamp". The earn mode governs the automatic paths | development agent | none planned; revisit if merchants want it locked |
| L-3 | Low | A visit award grants exactly **one** stamp; there is no per-visit multiplier | Not in the Phase 1a settings list | development agent | Phase 1b |
| L-4 | Low | Customer directory search uses `contains` with no trigram index | A pilot café has hundreds of customers, not millions | development agent | Phase 1b, with the real customers screen |
| L-5 | Low | Directory paging orders by opaque profile id, not by name or recency | Stable and gapless, which is what paging needs; presentation order is a UI decision | development agent | Phase 1a Prompt 2 |
| L-6 | Low | Card status never moves `ISSUED` → `ACTIVE`; both transact | Nothing opens a card yet — the card page is Prompt 2, and it owns `firstOpenedAt` | development agent | Phase 1a Prompt 2 |
| L-7 | Low | `UtmSourceLink.welcomeUnitQuantity` supports per-source overrides, but only the `direct` source exists | Named campaigns are deferred; the override path is implemented and tested through the direct source | development agent | Phase 3a |
| — | — | Phase 0 items L-2, L-3, L-4, L-6, L-8 … L-12 | unchanged | — | as recorded |

---

## 8. Boundaries

- `master` is at `b9ee686`, untouched. Tag `prototype-baseline` → `0aee6ee`, unchanged.
- No commit amended, no history rewritten.
- **Nothing pushed**: the branch has no upstream and `origin/master` is the only remote ref.
  Nothing deployed, no cloud resource provisioned, no account created, repository visibility
  unchanged.
- No live credential requested, generated, held, logged or committed. Test passwords are constants
  in test files and never leave the test process.
- **No migration was added**; the five Phase 0 migrations are byte-for-byte unchanged.
- **Not claimed and not verified:** staging, HTTPS, camera scanning, PWA installation,
  service-worker behaviour, deployment. None was run; all belong to Prompt 2 and to owner decisions
  B1–B3, especially real staging HTTPS.
- **No Prompt 2 work was started:** no pages, no route handlers, no public customer pages, no
  service worker, no scanner UI. The services exist for Prompt 2 to call.
- No deferred mechanics were implemented; the contract actively refuses them.
- **Multi-location work was not started.** Phase 1a writes only at `Main`, and the engine refuses a
  caller-supplied location entirely (§9). A second `Location` row may exist and receives nothing.
- Owner decisions A1–A5, B1–B6, C1–C5 are unchanged and none is marked approved.

---

## 9. Scope correction — one location, resolved by the server

**Finding (review of the first submission).** The stamp engine accepted an optional `locationId`
and fell back to `Main` only when none was given. `requireLocationAccess` stops a *cashier* acting
outside their assignment, but an `OWNER` is unrestricted across their own locations — so an owner
could create a second `Location` and award stamps there. A test in the first submission did exactly
that, which made the breach explicit rather than hypothetical.

This is not a cross-tenant risk: nothing could reach another business. It breaks the Phase 1a
promise of **one café, one counter**, and starts multi-location behaviour underneath screens that
Prompt 2 has not been designed to show it.

**Fix.** The location is no longer an input at any layer of this phase.

- `locationId` is removed from `StampActionInput` and `ReverseGroupActionInput`, so the type system
  rejects it at compile time — which is how the two offending tests were found.
- Every award, redemption and reversal resolves the business's default `Main` location inside the
  transaction. Reversals now attribute their compensating rows to `Main` explicitly rather than
  inheriting the original group's location.
- Supplying `locationId` anyway, which untyped JavaScript can still do, is **refused before
  anything is validated or written** — including when the value supplied is the correct `Main` id,
  because the rule is about who decides, not about which id arrives.
- The test that had an owner award at a second counter is **deleted**. Its replacement asserts the
  refusal and that the second counter receives no rows at all.

**Proof.** `tests/integration/stamp-engine.test.ts`, describe block "one location only" (3 tests):

- every operation of a full lifecycle — award, reversal, award, conversion, reward earned,
  redemption — carries the same `locationId`, and that location is the business's `isDefault`
  `Main`;
- all five verbs refuse a caller-supplied location with `ValidationError`, no row is written, the
  second counter has zero operations, and reconciliation stays clean;
- the correct `Main` id is refused too.

`tests/integration/cashier.test.ts` now asserts a cashier cannot reach a second counter because
nobody can name one. `tests/integration/customer-lookup.test.ts` still proves that a cashier's
operation list is narrowed by location, but seeds that row directly through Prisma — the engine can
no longer write it — with a comment saying why and the card projection moved to match, so
reconciliation stays clean. That narrowing logic must keep working for rows that legitimately exist
at other locations: imported history now, and Phase 1b's multi-location programs later.

**Verification after the fix**

| Command | Result |
|---|---|
| `npx tsc --noEmit` | caught both offending tests; 0 errors after they were rewritten |
| `npx vitest run --project integration` (three affected files) | 1 failure, mine: the new lifecycle test reversed a group whose reward had already been redeemed, which the engine correctly refuses. Sequence corrected |
| same, re-run | **37 + 14 + 19 passed** |
| `npm run gate` | **GATE PASSED 13/13 in 214.5 s**, integration 309/309 |
| `npm audit`; `npm audit --omit=dev --audit-level=high` | 0 vulnerabilities each |
| `git diff --check`; `git status --porcelain` | clean; clean |

Multi-location support remains **entirely deferred to Phase 1b**, where the parameter returns
deliberately alongside the program's `availableLocations` and a location picker.

---

**PASS — PHASE 1A PROMPT 1 CORE GATE COMPLETE — READY FOR PHASE 1A PROMPT 2**
