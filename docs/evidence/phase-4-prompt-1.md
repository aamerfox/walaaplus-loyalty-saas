# Phase 4 Prompt 1 — cashback and invoice-based discount core

| | |
|---|---|
| Branch | `rebuild/phase-0-foundation` |
| Baseline | **`f87f3f259db799577f2ab996fc09d019886b76cc`** — the deployed Foundation Correction, itself built on `39fe9be` |
| Matrix written before any code | `docs/PHASE-4-MONEY-MATRIX.md` |
| Implementation record | `docs/PHASE-4-IMPLEMENTATION.md` |
| Money and rounding contract | `docs/PHASE-4-MONEY-CONTRACT.md` |
| `CardType` exhaustiveness audit | `docs/PHASE-4-CARDTYPE-AUDIT.md` |
| Migration | **20**, `20260926120000_cashback_and_discount_core`. Migrations 1–19 untouched — `git status` shows one new directory and no modification under `prisma/migrations/` |
| `public/` | **byte-identical** — `git status --porcelain public/` is empty |
| New secret, env var, Compose, Caddy, DNS, TLS, firewall, network or volume change | **none** |
| Staging | **not contacted.** No external network call, no provider, no device, no POS, no wallet, no real money, no customer data |
| Scope built | domain, database, server services, integrity rules, tests |
| Scope **not** built | owner config UI, cashier UI, customer UI, public routes, public API additions, wallet changes, deployment |

---

## 1. What the prompt asked to be checked first, and what was found

The prompt required stopping and reporting a blocker rather than assuming a decimal format, a
currency exponent or an accounting rule. Two things were found by inspection. **Neither is a blocker,
because both were designed around rather than assumed past** — and both are recorded.

| Found | Consequence | Where |
|---|---|---|
| **This product has no currency exponent anywhere.** `Business.currency` is `text NOT NULL DEFAULT 'SYP'` with no FK, no `CHECK` and no exponent; it is written once from a hard-coded constant at registration and never again | A new `SupportedCurrency` table (code → exponent) is the only place a currency's precision is stated. The rule copies it, every operation copies it again, a trigger refuses a mismatch, and a business whose currency has no recorded exponent **cannot configure a money program** and is told so by name. `Business.currency` itself is not altered | matrix §1.1, contract §1.2 |
| **`int4` is too narrow for money in SYP.** Every pre-existing money column is `integer`, capping at ≈21 million SYP. `LoyaltyOperation.purchaseAmountMinor` is live | Every Phase 4 column is `BIGINT` and the domain is `bigint` throughout, so the intermediate `gross × rate` (which overflows first) cannot reintroduce it. The pre-existing columns are registered as **D33** rather than widened inside a feature prompt. `CustomerCard.cashBalanceMinor` is deliberately left unused and a test asserts it stays zero | matrix §1.2, contract §7 |

---

## 2. Defects found and fixed

Adding two values to a live `CardType` enum broke four things, three silently. All four are the same
shape: **a two-valued dispatch written as `if (POINTS) … else STAMP`.**

| # | Severity | Defect | Fix |
|---|---|---|---|
| F1 | **HIGH** | `enrollment.ts` `resolveSource` read a cashback version's mechanics through the **stamp** contract, so a money program **could not issue a card at all**, and the error blamed the data | Exhaustive `switch` over all four card types. Also forces `welcomeUnits` to zero for a money program whatever the source row says |
| F2 | **HIGH** | `versions.ts` `validateDraft` had the same `else`-is-stamp shape: a cashback draft would have been validated against the stamp contract and **published as a stamp program** | `DRAFT_EDITABLE_CARD_TYPES` + `assertDraftEditable`, applied at `createDraftVersion`, again inside `validateDraft`, and again in `getProgramDraft` (which narrows the screen's prop type) |
| F3 | MEDIUM | `program-detail.ts` `getScannerScope` returned every ACTIVE template, so a money program would have appeared in the **cashier's picker** with no engine behind it | `SCANNER_CARD_TYPES` filters the query and narrows the returned type |
| F4 | LOW | `tsconfig.json` `target: ES2017` rejects BigInt literals | ES2020. `noEmit: true`, so this governs only what TypeScript accepts; Next/SWC transpile against their own browser targets. `lib` is explicit, so nothing else moved |

### 2.1 The systemic audit that followed

Four defects of one shape is not four bugs. A repository-wide audit of every source, worker, route,
UI selector, serializer, analytics query, version-lifecycle and card-rendering path followed —
20 files reference `CardType`, 9 dispatch on it or on a mechanics contract — and found **five more**.

| # | Path | With a money card | Severity |
|---|---|---|---|
| A4 | `tenant/locations.ts` stranded check | parsed as neither contract → `continue` → **closing its only counter stranded a live programme silently** | MEDIUM |
| A5 | `program/programs.ts` `locationsOf` | `null` → a branch-pinned money programme **displayed as Main-only** | MEDIUM |
| A6 | `customers/lookup.ts` | else-is-STAMP → refused with *"does not hold valid stamp mechanics"*, which reads as data corruption when nothing is corrupt | MEDIUM |
| A7 | `business/customers/[profileId]/page.tsx` | rendered the stamp tile → **"Stamps: 0"** on a customer's record | MEDIUM |
| A8 | `business/programs/[templateId]/page.tsx` | metric labelled **"Stamps awarded: 0"** for a money programme | LOW |
| A9 | `program/counter.ts` reversal | else-is-STAMP, **unreachable today** (money writes no `LoyaltyOperation`); now a compile error if that changes | LATENT |
| A10 | `program/program-detail.ts` `getProgramDetail` | same ternary → the **detail page an owner reaches by clicking their own programme** failed with *"does not hold valid stamp mechanics"* | **HIGH** |
| A11 | `business/customers/[profileId]/page.tsx` rewards tile | **"Rewards: 0"** beside a cashback card, implying a reward mechanic it does not have | LOW |

**A10 and A11 were found on a SECOND sweep**, after the first round of fixes had been made and
verified. That is worth recording on its own: one pass over a systemic problem is not enough, and the
first pass felt complete at the time.

The A10 fix is the one worth defending. Returning `earnRule: { mode: "MANUAL" }`, `dailyAwardLimit:
null`, `welcomeUnits: 0` would have made the page render without error, and every one of those rows is
*individually true* of a money programme. Together they describe **a stamp programme with no rules
configured**. The page now omits that whole block rather than filling it with true-but-misleading
rows — which is the same judgement as A7 and A11, and the reason the instruction "no plausible stamp
placeholders" is the right test to apply rather than "no errors".

Verified safe **rather than assumed safe**: `wallet/wallet-pass.ts`, `segments/definition.ts`,
`customers/customer-360.ts`, both `api/staff/*` routes, `NewProgramForm.tsx`, `analytics/metrics.ts`,
`program/stamp-program.ts` (its query filters `cardType: STAMP`), the customer **list** and the
business **dashboard** (per-customer and business-wide totals over `LoyaltyOperation`, genuinely zero
for a money programme rather than wrongly attributed), `card/[shareToken]/page.tsx` (stamp-only since
Phase 1a — a POINTS card already gets the same refusal), and all of `src/worker/` and `src/egress/`,
which name `CardType` nowhere at all.

**Final state of the sweep:**
`grep -rn "isPointsMechanics" src --include=*.ts -A3 | grep -B2 "isStampMechanics"` returns nothing
outside `card-type-support.ts` itself, and no `POINTS ? … : STAMP` ternary remains in `src/server/`.

**The guard:** `src/server/program/card-type-support.ts` holds a `Record<CardType, …>`, so a fifth
enum value now **fails to compile** until somebody states which engine owns it and whether the
counter, the draft editor and wallet passes support it. `tests/unit/card-type-support.test.ts`
(20 tests) holds the same line at runtime and adds a narrow source-level sweep. Full record in
`docs/PHASE-4-CARDTYPE-AUDIT.md`.

### 2.2 A weakening the audit itself introduced, and caught

Consolidating the ladders replaced a **fail-closed** check in `counter-enrollment.ts` — a version
parsing as no contract was refused outright — with a resolver that returns `null` for both "Main only"
and "unparseable". On a path that hands a cashier a capability, that turned the safest reading into
the most permissive one. `versionContractOf` now keeps them apart, the explicit check is back, and it
has its own test.

### 2.3 Two defects in migration 21 itself

Both found by testing the migration, both fixed **in** migration 21 — at the time it was new,
unreleased, and had never been applied anywhere.

* **`MonetaryTier` was append-only but not immutable.** Freezing `UPDATE` and `DELETE` still allowed a
  tier to be **added** to a live version — a new top rate, or a threshold moving existing customers
  into a worse band — and every card pinned to that version would have started earning at a rate its
  holder never agreed to. Both guards now require the owning `ProgramVersion` to be `DRAFT`.
* **Two `plpgsql` variables holding `minCumulativeSpendMinor` were declared `INTEGER`.** The column is
  `BIGINT`; a threshold above 2^31 would have overflowed inside the very trigger that keeps the tier
  order well-defined.

### 2.4 Schema/migration drift, caught by `prisma migrate diff`

`migrate diff --from-migrations … --to-schema-datamodel …` against a real shadow database reported
**eleven** differences introduced by migration 21: eight objects where I had chosen short index and
foreign-key names (`MonetaryOperation_card_sequence_key`, `MonetaryTier_rule_index_key`, …) while
`schema.prisma` implied Prisma's longer defaults, plus two foreign keys reported as removed-and-added
rather than renamed.

Those last two are the ones worth reading twice. `monetaryTierId` and `reversalOfId` are **optional**
relations, and Prisma's default referential action for an optional relation is **`SetNull`** — while
migration 21 declares `ON DELETE RESTRICT`. The diff was reporting a genuine semantic disagreement,
not a cosmetic one, and `SetNull` is the wrong answer for both:

* nullifying `monetaryTierId` would erase which rate a customer was actually given;
* nullifying `reversalOfId` would sever a reversal from the row it reverses.

**Fixed by making both sides say the stricter thing**: migration 21's object names were aligned to
Prisma's defaults (it is unreleased, so renaming costs nothing and avoids adding permanent drift), and
`schema.prisma` now states `onDelete: Restrict, onUpdate: Cascade` explicitly on those two relations
with a comment saying why. `migrate diff` is clean of every Phase 4 object afterwards.

**One pre-existing drift remains and was NOT touched:**

```
[*] Changed the `ConsentRecord` table
  [*] Renamed the foreign key "ConsentRecord_profile_fkey" to "ConsentRecord_customerBusinessProfileId_fkey"
  [*] Renamed index `ConsentRecord_profile_scope_recordedAt_idx` to `ConsentRecord_customerBusinessProfileId_scope_recordedAt_idx`
```

That is Phase 2 work, `git status` shows the model unmodified, and it is name-only (no semantic
difference). Recorded rather than fixed, because renaming a deployed index is a migration of its own.

### 2.5 The harness

`resetDatabase` truncates with the append-only triggers disabled and did not know about the three new
tables, so every pre-existing integration test failed with *"MonetaryOperation is append-only;
TRUNCATE is not permitted"*. `SupportedCurrency` is deliberately **excluded** from the reset — it is
reference data seeded by migration, and wiping it would delete the exponents every later test needs.

---

## 3. Tests

| Suite | Count |
|---|---|
| `tests/unit/monetary-money.test.ts` | 27 |
| `tests/unit/card-type-support.test.ts` | 20 |
| `tests/integration/monetary-core.test.ts` | 48 |
| `tests/integration/monetary-integrity.test.ts` | 37 |
| `tests/integration/phase4-foundation-compat.test.ts` | 8 — permanent regression coverage that Phase 4 does not weaken the Foundation Correction |

Every test in the integrity suite writes **directly through the restricted runtime role**, bypassing
the engine entirely: the question is not whether the service is careful but whether the guarantee
survives the service being replaced.

### 3.1 Four tests that passed for the wrong reason, and were strengthened

Recorded because this is the failure mode a money feature exists to avoid, and it happened four times
inside one prompt. In every case the test was **green** and proving nothing.

1. **The float-divergence assertion.** The first version asserted that a large input diverges from the
   float calculation — and it did not; the test failed. **Not every large input diverges.** It now
   pins a specific pair (3.26% of 900,000,002,906,273) where the float answer is provably one minor
   unit high, and asserts *both* answers. A test that picked an arbitrary large number would have
   passed even with the implementation changed back to floats.
2. **The partial unique index on `reversalOfId`.** Reversing a cashback award twice cannot reach that
   index — the second attempt is stopped by the balance rules first — so the original test would have
   passed with the index dropped. It now uses a **discount** program, where both reversals have a cash
   effect of zero, so every other rule passes and the index is genuinely what refuses. The red proof
   below is what confirms that.
3. **The concurrency proof — four failed designs before one held.** This is recorded in full because
   the failures are more instructive than the fix, and because every one of them LOOKED like a passing
   test.

   The guarantee is `UNIQUE (customerCardId, cardSequence)`. It only ever matters when two
   transactions are **open at the same time**: both triggers then read only committed rows, both find
   `prev_seq = 0`, both compute sequence 1, both pass every coherence rule, and nothing but the index
   can separate them.

   | | Design | Why it proved nothing |
   |---|---|---|
   | **Test attempt 1** | `Promise.allSettled([insert(row), insert(row)])` | Two bare `create` calls are two **autocommit** transactions and do not overlap. The first commits before the second's trigger runs; the trigger sees `prev_seq = 1`, demands sequence 2, and refuses the duplicate **on its own**. The index was never consulted — the test passed with it dropped |
   | **Test attempt 2** | Two interactive transactions, A holding open for a fixed **750 ms** | A freshly constructed `PrismaClient` connects **lazily**, so B spent longer starting its query engine than A spent waiting. A committed first and B was refused by the sequence rule again — the diagnostic error was literally *"sequence 1 does not follow 1"*, which is the proof the two ran in order. Passed with the index dropped |
   | **Harness attempt 1** | Red-proof script spawning `npx.cmd` | **Node 24 on Windows refuses to spawn a `.cmd` shim** (`EINVAL`). Every case came back red — *including the controls*. Caught only because the with-the-guarantee half of each case did not come back green |
   | **Harness attempt 2** | Dropping each object and recreating it in place with the same DDL | Left residue: after the two unique-index cases the suite stayed **red with the index back**. The "restored" half was reporting a broken database rather than a restored guarantee |

   **What holds.** Both clients are WARMED with a trivial query so no connection handshake happens
   inside the race; A holds its transaction open until B has **settled** rather than for a guessed
   duration (deterministic in both worlds — with the index B blocks and A releases on a deadline,
   without it B finishes in milliseconds and A notices at once); the test asserts that the loser lost
   to the **index** and *not* to the sequence rule (`expect(reason).not.toMatch(/does not follow/)`),
   which is what would have refused it had the two merely run in order; and it observes the database
   directly — one row, one sequence — rather than inferring from which promise rejected.

   The red proof was re-run against it: **red with the index dropped, green with it restored.**
4. **The permission split.** `effectivePermissions` is *role defaults ∪ explicit grants* — the
   membership column **adds**, it never restricts — so writing a narrower set into a membership
   produced a context that still held both permissions and the call succeeded for the wrong reason.
   The tests now narrow a real context directly and **state in a comment what they do and do not
   establish**: the guard enforces the split; no role this product defines can currently be in that
   state. Registered as **D36** rather than dressed up.

---

## 4. Red proof

Every new database guarantee was removed in turn from a **freshly recreated** disposable database.
Each case runs the relevant tests twice: with the guarantee (must be **GREEN**) and without it (must
be **RED**).

| Guarantee | With it | Without it |
|---|---|---|
| `monetary_operation_append_only` trigger | GREEN | RED |
| `monetary_operation_no_truncate` trigger | GREEN | RED |
| `monetary_rule_guard` trigger | GREEN | RED |
| `monetary_tier_guard` trigger | GREEN | RED |
| `monetary_operation_validate` trigger | GREEN | RED |
| `supported_currency_frozen` trigger | GREEN | RED |
| runtime-role privilege grants (`db-roles.mjs`) | GREEN | RED |
| `UNIQUE (customerCardId, cardSequence)` | GREEN | RED |
| `UNIQUE (reversalOfId) WHERE NOT NULL` | GREEN | RED |

The grants row is proved differently, and deliberately so. Dropping a `GRANT` from the database does
nothing: `scripts/db-roles.mjs` runs in the integration globalSetup and re-applies every grant before
the first test executes, so the suite stays green and the proof would be meaningless. It is proved at
its **source** instead — removing the three money tables from `APPEND_ONLY_TABLES` took **six** tests
red — and a `has_table_privilege` assertion observes the catalog directly rather than inferring the
grant from an error message.

### 4.1 The proof script failed its own standard twice, and both times the check caught it

* It first spawned `npx.cmd`, which **Node 24 on Windows refuses** (`EINVAL`). Every case came back
  red — *including the ones with the guarantee present*. Only the baseline half of the check
  distinguished "the guarantee is being tested" from "the proof is broken".
* It then dropped each object and recreated it with the same DDL. That left residue: after the two
  unique-index cases the suite stayed red **with the index back**. Recreating the tmpfs database per
  case is slower and has no such failure mode.

**And it earned its keep:** the corrected run reported the sequence-uniqueness case as *not proved* —
the test passed with the index dropped. That was a real finding, and it took two further attempts to
fix (see §3.1 (4)). A red proof that only ever confirms what you already believe is not one.

A red proof that reports red for every case proves nothing at all, which is exactly why the
with-the-guarantee run is part of it.

---

## 5. Verification

| Check | Result |
|---|---|
| `npx tsc --noEmit` | clean |
| `npx eslint .` | clean |
| `npx prisma validate` | valid |
| Unit suite | 44 files, **665 passed** |
| `git diff --check` | clean |
| `git status --porcelain public/` | **empty** |
| `INTEGRATION_ENCRYPTION_KEY` in new code, tests, migration or docs | **absent** |
| Control or invisible characters in the 21 new/changed files | **none** |
| Migrations 1–19 | unmodified; one new directory only |

*(Full integration suite, Playwright, `npm audit`, `prisma migrate status` and `migrate diff` are
recorded in §6 with their actual output.)*

---

## 6. The failed gate, and how it was resolved

### 6.1 What happened

**The first full Phase 4 gate on a clean database FAILED — 10 of 16 steps.**

```
PASS  dependency audit (prod, high+)          PASS  migrate deploy (test db, migrator role)
PASS  prisma generate                         PASS  migrate status (test db)
PASS  lint (--max-warnings=0)                 PASS  runtime role grants (test db)
PASS  typecheck                               FAIL  integration tests
PASS  prisma validate                         ---- worker build            (never ran)
PASS  unit tests        686 passed            ---- egress build            (never ran)
PASS  test db up                              ---- production build        (never ran)
                                              ---- migrate image deps      (never ran)
integration: 1200 passed, 1 FAILED of 1201    ---- web image health        (never ran)

GATE FAILED in 769.9s (10/16 steps)
```

The failing test:

```
tests/integration/integration-events-integrity.test.ts
  > an event is written with the action, and never backfilled
  > refuses one written in a later transaction even seconds afterwards
```

A second run then reported 16/16. **That result was refused as evidence** — the step that failed is
non-deterministic, and passing it once is retrying until the timing is favourable.

### 6.2 It was not flakiness. It was a measured integrity gap.

An earlier draft of this document called it "a pre-existing flaky test". **That was wrong**, and the
correction matters more than the original claim.

`walaaplus_validate_integration_event` proved "written in the same transaction" by comparing the
event's `occurredAt` with the redemption's `recordedAt` — both assigned from `now()` (transaction
start) and both `TIMESTAMP(3)`. Migration 14 stated its own residual accurately: *"The residual window
is one millisecond."*

Measured — 400 consecutive **separate** transactions:

```
consecutive SEPARATE transactions sharing the same TIMESTAMP(3): 3 of 399 (0.8%)
```

About 1 attempt in 125, and a backfilling writer may retry, reaching ~99% in about 600 tries.
**Against a deliberate direct writer the rule was not a guarantee.** It did fully prevent accidental
backfill of *old* rows. The test is correct and failed exactly when the window opened.

### 6.3 What was done about it

**Nothing was papered over, and nothing was folded into Phase 4.** A sleep would have made the test
green and hidden a real window; a casual `xmin` change would have reintroduced a design Phase 3B had
already rejected for savepoint reasons.

Instead the gap was corrected as **separate, approved work** in an isolated worktree off the same
baseline:

| | |
|---|---|
| Commit | `f87f3f259db799577f2ab996fc09d019886b76cc` |
| Migration | `20260925130000_integration_event_transaction_identity` |
| Ordering | after deployed 19, **before** Phase 4's `20260926120000` — so staging could take it without incomplete Phase 4 work |
| Status | **deployed to staging** — 20 applied / 0 pending / 0 failed |
| Record | `docs/evidence/phase-3b-xact-identity-correction.md`, `docs/PHASE-3B-XACT-IDENTITY-DESIGN-MATRIX.md` |

The rule is now an exact `pg_current_xact_id()` identity comparison — savepoint-safe, where `xmin`
would not have been — with migration 14's timestamp rule retained alongside it at the owner's
direction. Legacy rows carry no identity and fail closed.

### 6.4 Phase 4 was then rebased onto the correction

The uncommitted Phase 4 work was moved from `39fe9be` onto `f87f3f2` without reset, checkout, stash or
overwrite: reverse-apply the Phase 4 patch, `git merge --ff-only`, reapply with `--3way`. Every
non-overlapping file verified byte-identical to a pre-move backup; the two genuinely overlapping files
(`prisma/schema.prisma`, `docs/BOOMERANGME-PARITY.md`) now carry both change sets; no conflict
markers. Two unrelated roadmap files belonging to another session were excluded from the patch
entirely and verified untouched by hash.

### 6.5 Phase 4 must not weaken the correction — proved, not assumed

`tests/integration/phase4-foundation-compat.test.ts` is **permanent regression coverage**. It asserts,
against a database with *every* migration applied including Phase 4's, that the guarantee is still the
one the correction installed — reading the function bodies back from `pg_get_functiondef`, i.e. the
catalog, which is where a later `CREATE OR REPLACE` would actually show up.

Static review first: the Phase 4 migration **never mentions `PromotionRedemption`** (0 matches),
replaces neither correction function, and every one of its six triggers is on one of its own four new
tables.

Red proof — the clobber a careless migration would cause, simulated:

| Damage | Intact | Clobbered |
|---|---|---|
| xid check removed, timestamp rule left intact | GREEN | **RED** |
| function wholesale reverted to migration 14 | GREEN | **RED** |

**Every verification below was re-run fresh against `f87f3f2`.** No pre-rebase result is carried
forward.

---

## 7. Full verification run

*(filled in below from the final run)*

---

## 8. What this evidence does NOT claim

* **Nothing was tested against staging, a provider, a device, a POS, a wallet, a payment rail or any
  external network.** No such call exists in the code.
* **No money moved.** `grossAmountMinor` is a number a member of staff typed. It is not a receipt, not
  a verified total, not settlement and **not revenue**. `netCounterAmountMinor` is an instruction to a
  person, not a charge.
* **Honouring is manual and unverified.** The product computes a discount; a person has to actually
  charge less, and nothing in the record proves they did.
* **The permission split is enforced but not reachable.** See §3.1 (3) and **D36**.
* **This prompt built no UI.** A merchant cannot configure a rate and a cashier cannot apply one until
  Prompt 2 — everything here is reachable only from a service call or a test.
