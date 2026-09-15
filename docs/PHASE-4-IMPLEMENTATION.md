# Phase 4 Prompt 1 — cashback and invoice-based discount core

**What this prompt built:** the domain, the database, the server services, the integrity rules and the
tests for two new card types that carry real money. **What it deliberately did not build:** owner
configuration UI, cashier counter UI, customer UI, public routes, public API additions, wallet
changes, and any staging deployment. Those are Prompt 2.

Read alongside:

* `docs/PHASE-4-MONEY-MATRIX.md` — what this product may and may not *claim* about these numbers.
  §0 names the sentence the whole design exists to prevent somebody saying.
* `docs/PHASE-4-MONEY-CONTRACT.md` — the normative statement of representation, rounding, bounds,
  caps, tier selection and least privilege.

---

## 1. What was found before anything was written

Two facts about the existing schema shaped every decision that followed. Both were established by
inspection rather than assumed, and neither was worked around silently.

### 1.1 This product had no currency exponent

`Business.currency` is `text NOT NULL DEFAULT 'SYP'` with **no** foreign key, **no** `CHECK`, and no
exponent anywhere. It is written once, from a hard-coded constant at
`src/app/[locale]/auth/register/page.tsx:40`, and never again.

"Minor units" means nothing without saying how many make a major unit, and that number is not two for
every currency — JOD, KWD and BHD use three, JPY uses none. So migration 21 adds `SupportedCurrency`
(code → exponent), the rule copies both at creation, every operation copies both again, and a trigger
refuses a rule whose exponent disagrees with the table. A business whose currency has no recorded
exponent **cannot configure a money program** and is told so by name.

This phase does **not** alter `Business.currency`. Changing a live column that every registration
writes is its own piece of work.

### 1.2 `int4` is too narrow for money in SYP

Every pre-existing money column is a PostgreSQL `integer`, capping at 2,147,483,647 minor units —
about 21 million SYP. `LoyaltyOperation.purchaseAmountMinor` is **live**; the scanner writes it on
every points award.

Phase 4's own columns are all `BIGINT`, and the domain uses `bigint` throughout so that an
intermediate product (`gross × rateBasisPoints`, which overflows long before the result does) cannot
reintroduce the problem. The pre-existing columns are registered as **D33** rather than widened inside
a feature prompt.

`CustomerCard.cashBalanceMinor` — an `int4` labelled "reserved: gift/cashback" — is **deliberately not
used**. A test asserts it stays at zero, so anything that starts writing a second copy of the balance
fails loudly. See the contract §7 for the second, larger reason: a projection column can disagree with
its history, and a chained row cannot.

---

## 2. What was added

### 2.1 Migration 21 — `20260926120000_cashback_and_discount_core`

Additive only. Migrations 1–19 untouched.

| Object | Purpose |
|---|---|
| `SupportedCurrency` | code → exponent, seeded with eight currencies. `CHECK` on exponent 0–4 and on the ISO code shape |
| `CardType` += `CASHBACK`, `DISCOUNT` | `ALTER TYPE … ADD VALUE`, legal inside a transaction on PG12+ provided the new value is not *used* in the same one — which is why every comparison in the triggers is via `::text` |
| `MonetaryRuleKind`, `MonetaryOperationKind` | new enums |
| `MonetaryRule` | one per program version (unique), carrying the frozen currency and exponent |
| `MonetaryTier` | threshold + rate in basis points; unique on `(rule, index)` **and** `(rule, threshold)` |
| `MonetaryOperation` | the financial record. Every amount `BIGINT`. `UNIQUE (customerCardId, cardSequence)` is the serialization point; `UNIQUE (reversalOfId) WHERE NOT NULL` makes a reversal happen once |
| 5 trigger functions | rule guard, tier guard, append-only guard, the operation validator, currency freeze |

### 2.2 Domain and services — `src/server/monetary/`

| File | What it owns |
|---|---|
| `money.ts` | the arithmetic. Half-up percentage, bounds, the boundary parser, the exponent-aware formatter, the three-way redemption cap |
| `mechanics.ts` | the CASHBACK/DISCOUNT mechanics contract — and the rule that **money is not in the JSON** |
| `rules.ts` | configuring a rate table: currency resolution, tier normalisation, program creation, tier selection |
| `engine.ts` | the four counter operations |

### 2.3 Touched elsewhere, and why

| File | Change |
|---|---|
| `prisma/schema.prisma` | the new models, enums and back-relations |
| `scripts/db-roles.mjs` | the three new append-only tables; a new `READ_ONLY_TABLES` class for `SupportedCurrency` |
| `src/server/audit/audit.ts` | two actions: `monetary.rule_configured`, `monetary.operation_reversed` |
| `src/server/customers/enrollment.ts` | **defect fix** — see §3.1 |
| `src/server/program/versions.ts` | **defect fix** — see §3.2 |
| `src/server/program/program-detail.ts` | **defect fix** — see §3.3 |
| `messages/{en,ar}.json` | `cardType.CASHBACK` / `.DISCOUNT` labels in all six blocks, plus two `cardTypeHint` entries |
| `tsconfig.json` | `target` ES2017 → ES2020 — see §3.4 |
| `tests/setup/fixtures.ts` | the money fixtures, and the three new tables in the reset lists |

---

## 3. Defects found and fixed

Adding two values to a live enum is not a neutral act. Four things broke while building this prompt,
three of them silently, and all four were the same shape: **a two-valued dispatch written as
`if (POINTS) … else STAMP`.**

Four of one shape is not four bugs; it is one systemic risk with four symptoms. A repository-wide
audit followed and found **five more** - four reachable, one latent - and produced a compile-time
guard so the next card type cannot inherit stamp behaviour silently.
**`docs/PHASE-4-CARDTYPE-AUDIT.md`** is the full record; §3.7 below summarises it.

### 3.1 A money program could not issue a card at all

`resolveSource` in `enrollment.ts` read the version's mechanics as
`cardType === POINTS ? readPointsMechanics : readStampMechanics`. A cashback version went to the
**stamp** contract, failed as a corrupt-row invariant error, and the message blamed the data.

Now an exhaustive `switch` over all four card types. The same change closes a second hole: a money
programme has no welcome bonus, and `welcomeUnits` is forced to zero for one regardless of what the
source row says — a welcome cashback would be the business handing real money to anyone who enrols,
with no invoice and no member of staff present.

### 3.2 A cashback draft would have been published as a stamp program

`validateDraft` in `versions.ts` had the same shape. A cashback template's draft would have been
validated against the **stamp** contract and published.

Now `DRAFT_EDITABLE_CARD_TYPES` names the two kinds this flow implements, `assertDraftEditable`
refuses the others at `createDraftVersion` (so a money draft never exists), again inside
`validateDraft` (so the `else` branch cannot be reached by a new caller), and again in
`getProgramDraft` — which is what narrows the type the editor screen consumes.

The refusal is a `ValidationError`, not a `NotFoundError`: the program genuinely exists and the owner
can see it in their list, so pretending otherwise would send them looking for a bug. A money
programme's rates are frozen to the version they were configured on; changing a rate is a new version.

### 3.3 The counter screen would have offered a program every write refuses

`getScannerScope` returned every ACTIVE template. A money programme would have appeared in the
cashier's picker with no engine behind it — the worst version of this failure, because the cashier
would have a customer in front of them and no way to tell why nothing worked.

`SCANNER_CARD_TYPES` now filters the query and narrows the returned type. When the money counter
arrives in Prompt 2, that set grows and the compiler names every place that has to change.

### 3.4 `tsconfig.json` target

BigInt literals (`0n`) need ES2020; the project was on ES2017. This file sets `noEmit: true`, so
`target` governs only what TypeScript **accepts** — Next/SWC transpile the app against their own
browser targets and are unaffected. `lib` is explicitly set, so nothing else changed.

### 3.5 Two bugs in migration 21 itself, found while testing it

Both fixed in migration 21 rather than in a follow-up migration 22: at the time it was new,
unreleased, and had never been applied anywhere.

* **`MonetaryTier` was append-only but not immutable.** Freezing `UPDATE` and `DELETE` still allowed a
  tier to be **added** to a live version — a new top rate, or a threshold moving existing customers
  into a worse band — and every card pinned to that version would have started earning at a rate its
  holder never agreed to. Both guards now require the owning `ProgramVersion` to be `DRAFT`.
* **Two `plpgsql` variables holding `minCumulativeSpendMinor` were declared `INTEGER`.** The column is
  `BIGINT`; a threshold above 2^31 would have overflowed inside the very trigger that exists to keep
  the tier order well-defined.

### 3.6 Five more of the same shape, found by auditing rather than by tripping over them

| Path | With a money card |
|---|---|
| `tenant/locations.ts` stranded check | parsed as neither contract → `continue` → **closing its only counter stranded a live programme silently** |
| `program/programs.ts` `locationsOf` | returned `null` → a branch-pinned money programme **displayed as Main-only** |
| `customers/lookup.ts` | else-is-STAMP → refused with *"does not hold valid stamp mechanics"*, which reads as **data corruption** when nothing is corrupt |
| `business/customers/[profileId]/page.tsx` | rendered the stamp tile → **"Stamps: 0"** on a customer's record for a cashback card |
| `business/programs/[templateId]/page.tsx` | metric labelled **"Stamps awarded: 0"** for a money programme |
| `program/counter.ts` reversal | else-is-STAMP. **Unreachable today** - money writes no `LoyaltyOperation` - and now a compile error if that ever changes |
| `program/program-detail.ts` `getProgramDetail` | same ternary → the **detail page an owner reaches by clicking their own programme** failed with *"does not hold valid stamp mechanics"* |
| `business/customers/[profileId]/page.tsx` rewards tile | **"Rewards: 0"** beside a cashback card, implying a reward mechanic it does not have |

The last two were found on a **second** sweep, after the first round of fixes was made and verified.
One pass over a systemic problem is not enough, and the first pass felt complete at the time.

The `getProgramDetail` fix is the one worth defending: returning `earnRule: { mode: "MANUAL" }`,
`dailyAwardLimit: null`, `welcomeUnits: 0` would have made the page render, and each of those rows is
*individually true* of a money programme — but together they describe **a stamp programme with no
rules configured**. The block is omitted instead. "No plausible stamp placeholders" is a stricter and
better test than "no errors".

Verified safe rather than assumed safe: `wallet/wallet-pass.ts`, `segments/definition.ts`,
`customers/customer-360.ts`, both `api/staff/*` routes, `NewProgramForm.tsx`, `analytics/metrics.ts`,
and the whole of `src/worker/` and `src/egress/` (which name `CardType` nowhere at all).

### 3.7 A weakening introduced by the audit itself, and caught

Consolidating the ladders replaced a **fail-closed** check in `counter-enrollment.ts` - a version
that parsed as no contract was refused outright - with a resolver that returns `null` for both
"Main only" and "unparseable". That silently turned the safest reading into the most permissive one on
a path that hands a cashier a capability.

`versionContractOf` now keeps the two apart, the explicit fail-closed check is back ahead of the
location logic, and it has its own test - because a distinction lost once inside a refactor will be
lost again inside the next one.

### 3.8 Schema/migration drift

`prisma migrate diff` against a real shadow database reported eleven differences introduced by
migration 21. Eight were naming: I had chosen short index and foreign-key names while `schema.prisma`
implied Prisma's defaults. Two were **semantic** and are the ones that mattered: `monetaryTierId` and
`reversalOfId` are optional relations, so Prisma's default referential action is `SetNull`, while the
migration declares `ON DELETE RESTRICT`. `SetNull` would erase which rate a customer was given, and
would sever a reversal from the row it reverses.

Both sides now say the stricter thing — migration 21's names aligned to Prisma's defaults (it is
unreleased, so this adds no permanent drift), and `onDelete: Restrict, onUpdate: Cascade` stated
explicitly in `schema.prisma` with the reason. A pre-existing `ConsentRecord` name-only drift from
Phase 2 remains and was deliberately not touched.

### 3.9 The test harness wiped the new tables

`resetDatabase` truncates with the append-only triggers disabled, and did not know about the three new
tables — so every pre-existing integration test failed with
*"MonetaryOperation is append-only; TRUNCATE is not permitted"*. `SupportedCurrency` is deliberately
**absent** from the reset: it is reference data seeded by migration, not per-test state, and wiping it
would delete the exponents every later test needs.

---

## 4. Tests

| File | Count | What it establishes |
|---|---|---|
| `tests/unit/monetary-money.test.ts` | 27 | The arithmetic, against values a person could check by hand: the exact half, the three-decimal currency, the zero-decimal currency, the amount past 2^53 |
| `tests/integration/monetary-core.test.ts` | 48 | The engines through the real services: tier boundaries, currency precision, caps, idempotency, concurrency on independent connections, reversals, card state, daily limits, tenancy, permissions, configuration |
| `tests/integration/monetary-integrity.test.ts` | 37 | What the **database** refuses, written directly through the **restricted runtime role** — bypassing the engine entirely |
| `tests/unit/card-type-support.test.ts` | 20 | That every `CardType` is accounted for, that money types are kept out of the counter, the draft editor and wallet passes, and that the dispatching modules route through the shared vocabulary |

### 4.1 Three tests that were deliberately made harder

Each of these first passed for the wrong reason, and was strengthened rather than kept:

1. **The float-divergence assertion.** The first version claimed a large input where the float
   calculation diverges — and it did not; the test failed. **Not every large input diverges**, so the
   test now pins a specific pair (3.26% of 900,000,002,906,273) where the float answer is provably one
   minor unit high, and asserts *both* answers. A test that picked an arbitrary large number would
   have passed even if the implementation were changed back to floats.
2. **The partial unique index on `reversalOfId`.** Reversing a cashback award twice cannot reach that
   index — the second attempt is stopped by the balance rules first — so the original test would have
   passed with the index dropped. It now uses a **discount** program, where both reversals have a cash
   effect of zero, so every other rule passes and the index is genuinely what refuses.
3. **The permission split.** `effectivePermissions` is *role defaults ∪ explicit grants* — the column
   **adds**, it never restricts — so writing a narrower permission set into a membership produced a
   context that still held both permissions, and the call succeeded for the wrong reason. The tests
   now narrow a real context directly and **say in a comment what they do and do not establish**: the
   guard enforces the split; no role this product defines can currently be in that state. Recorded as
   **D36** rather than dressed up.
4. **The concurrency proof — four failed designs before one held.** Two failed *test* designs and two
   failed *proof-harness* designs; `docs/evidence/phase-4-prompt-1.md` §3.1 (3) has the table. In
   short: two bare `create` calls are autocommit and do not overlap, so the sequence rule refuses the
   second and the index is never consulted; two interactive transactions with a fixed 750 ms hold
   still failed to overlap, because a fresh `PrismaClient` connects lazily and B spent longer starting
   its engine than A spent waiting. What holds warms both clients first, holds A open until B has
   **settled**, and asserts the loser lost to the **index** rather than to the sequence rule.

### 4.2 Red proof

Every new database guarantee was removed in turn from a **freshly recreated** disposable database. Each
case runs its tests twice: with the guarantee (must be **green**) and without it (must be **red**). A
guarantee whose removal leaves the tests green is not being tested.

**The proof script failed its own standard twice, and both times the with-the-guarantee half caught
it.** First it spawned `npx.cmd`, which Node 24 on Windows refuses (`EINVAL`), so every case came back
red — including the controls. Then it restored each dropped object in place with the same DDL, which
left residue: after the two unique-index cases the suite stayed red **with the index back**. It now
recreates the tmpfs database per case.

The grants guarantee cannot be proved by dropping it from the database: `scripts/db-roles.mjs` runs in
the integration globalSetup and re-applies every grant before the first test executes, so the suite
stays green. It is proved at its **source** instead — the three money tables removed from
`APPEND_ONLY_TABLES`, which took six tests red — and a direct `has_table_privilege` assertion observes
the catalog rather than inferring the grant from an error message.

---

## 5. Two-layer defence, and why the tests exercise the layers separately

| | Protects against | Refuses whom | Can explain itself |
|---|---|---|---|
| **Privilege** (`scripts/db-roles.mjs`) | a bug in this product's own code | the runtime role | no — `permission denied for table …` |
| **Trigger** (migration 21) | a careless operator at a `psql` prompt | the **table owner** too | yes |

A test that accepted either message would not notice if one layer disappeared, so they are asserted
separately and by exact message.

One consequence worth stating: a `BEFORE` trigger runs before a row's `CHECK` constraints, so several
`CHECK`s (`discount_within_gross`, for instance) are backstops the coherence rules shadow. The tests
assert the message that actually fires, and say which layer that is, rather than matching loosely.

---

## 6. Open decisions registered

| # | Question |
|---|---|
| **D33** | Widening the pre-existing `int4` money columns |
| **D34** | Fixed-amount discounts ("200 off" rather than "5% off") |
| **D35** | Whether today's invoice counts towards the tier that prices it — **implemented one way, documented, and asserted by a test** |
| **D36** | Whether a role should exist that can earn but not redeem |

---

## 7. What this is not

Stated here because the *first* thing that will happen to these numbers is somebody describing them to
a merchant.

Nothing here talks to a till, a card scheme, a bank, a payment provider, a cash-transfer provider or a
tax authority. `grossAmountMinor` is **a staff assertion** — a number a person typed — not a receipt,
not a verified total, not settlement, and **not revenue**. `netCounterAmountMinor` is an **instruction
to a person**, not a charge. There is no cash withdrawal verb anywhere in the code, and a redemption is
capped at the invoice precisely so that the most that can happen is a customer pays nothing today.

`docs/PHASE-4-MONEY-MATRIX.md` §2 is the authority table those sentences come from.
