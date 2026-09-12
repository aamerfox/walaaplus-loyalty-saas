# Evidence — Phase 1b Prompt 1: Merchant MVP core

**Date:** 2026-09-12
**Performed by:** development agent (Claude Opus 5)
**Branch:** `rebuild/phase-0-foundation`
**Precondition:** the Phase 1a engineering gate passed at `f21ded92176066372b57ed1960cb70da481faee3`
(`docs/evidence/phase-1a-prompt-3.md` §13).
**Scope:** the Phase 1b **server and domain core** only. No merchant UI, no dashboard pages, no
deployment changes — those are Prompt 2.

---

## 1. Result

**Complete.** Points programs with reward tiers, multi-location staff operations, full staff
management, named source links and the dashboard read models are implemented, tested against a real
PostgreSQL, and documented in [PHASE-1B-IMPLEMENTATION.md](../PHASE-1B-IMPLEMENTATION.md).

**No Critical or High finding.** Five Medium and Low findings are recorded in §6 with an owner and a
phase. Three issues found while reviewing my own work were fixed inside this prompt (§5).

| Check | Result |
|---|---|
| `npm run gate` | **PASS — 15/15 steps in 421.5 s** |
| `npm run test:e2e` | **12 passed (46.0 s)** |
| unit / integration | **295 passed, 22 files** / **454 passed, 38 files** |
| `npm audit`, full tree | **0 vulnerabilities** |
| `npm audit --omit=dev --audit-level=high` | **0 vulnerabilities** |
| Migration status | **6 applied, none pending** |
| Secret scan | **clean** (§7) |
| Index and query review | **§8** |
| `git diff --check` | **clean** |
| Prisma outside server-owned code | **none** |

**What this prompt does not claim.** Nothing was deployed; staging still runs Phase 1a's commit.
No OCI contact, no Caddy, DNS, secret or Docker Compose change. No device testing was performed and
none is claimed. B7 is untouched: there is still no public route that accepts a phone number.

---

## 2. Points programs and reward tiers

The ledger contract for tier redemption was **written before the implementation** and is reproduced
in `src/server/points/engine.ts`'s header and in PHASE-1B-IMPLEMENTATION §2.2. One redemption is one
row: `REWARD_REDEEMED`, `unitType: POINT`, `quantity: -tier.requiredPoints`, carrying `rewardTierId`
and `redemptionValueMinor`. No second row, no intermediate reward balance, no floating point
anywhere in the contract or the engine.

| Required | Where |
|---|---|
| Valid mechanics, strict | `src/server/program/points-mechanics.ts` — `z.strictObject`, unknown keys refused |
| Per-visit / manual / spend-block earning | `PointsEarnMode`, with mode-specific fields required and the others refused |
| Integer-only calculations | every quantity `z.number().int()`; both earn rules floor-divide; asserted on the stored rows |
| Daily limits | shared `assertDailyAwardLimit`, counting operations per business-timezone day |
| Purchase requirements | `requirePurchaseAmount`, checked on every award kind |
| Welcome points | granted once by the card insert's arbitration; must be fewer than the cheapest tier |
| Configured reward tiers | `RewardTier` rows on the version, immutable once it activates |
| Immutable groups, `rewardTierId`, idempotency, reversal, no floats | §2.2 of the implementation doc; tested in `tests/integration/points-engine.test.ts` |
| Reuse the ledger, no parallel balance system | both engines call `appendOperationGroup`; `pointBalance` is a projection like every other |

**Stamp behaviour is preserved and the two cannot interfere.** Each engine reads its own
discriminator from the pinned mechanics and refuses the other kind with a `LedgerInvariantError`
before any arithmetic. Regression coverage: a stamp card handed to the points engine, a points card
handed to the stamp engine, and one customer holding both cards at one business with both balances
moving independently. The whole Phase 1a stamp suite still passes unchanged.

**The one-live-program rule is lifted deliberately**, with `allowAdditionalProgram` defaulting to
false so the Phase 1a owner screen keeps its exact double-click contract. Card type and version
pinning, one ACTIVE version per template and one card per customer per template are all unchanged
and re-asserted by tests.

---

## 3. Multi-location

Location selection returns for **authenticated staff services only**. No public route gained a
location, and `assertNoLocationInRequest` still refuses one at the HTTP boundary — the API surface is
unchanged in this prompt, and Prompt 2 opens it together with the picker.

- The card's **pinned version** decides, through `availableLocations` inside its immutable mechanics.
  Absent means Main-only, which is what every Phase 1a version says, so **no existing card changes
  behaviour**: a supplied location is still refused, including Main itself.
- Both checks run **inside the write transaction**: the program's own list, then
  `requireLocationAccess` for that member. A location deactivated after publication stops accepting
  awards without anyone republishing.
- Several locations and a silent caller is **refused**, not defaulted. A default would attribute
  revenue to the wrong branch silently.
- Owner and manager are unrestricted by role; a cashier is restricted to assignments, and `[]` is a
  denial everywhere rather than "unrestricted".

**Reversal attribution, documented and tested.** Compensating rows are written at the ORIGINAL
group's location, always; supplying a location to a reversal is refused rather than ignored. The
reason is that the only thing such a parameter can do is move value between branches while the totals
still balance. Who performed the correction is recorded on `performedByUserId`. The consequence is
tested: a cashier who cannot act at the original location cannot reverse the group.

---

## 4. Staff, sources and the dashboard

**Staff management** keeps global users with per-business memberships. Two new least-privilege rules
close the levers this phase opens: **nobody edits their own membership**, and **nobody grants what
they do not hold** — applied to the whole effective set, so a role's defaults cannot be used to step
over the ceiling. A cashier is refused every staff verb. Location assignment replaces the whole set.
Deactivation and reactivation take effect on the next request. Every change is audited with **ids
only**: the test asserts the audit row contains the location id and does not contain the staff
member's email or any credential field.

**Named source links** are tenant-scoped, uniquely named per program, activatable, and carry
per-source welcome overrides. **B7 remains binding**: the module never returns, logs or audits a
`publicToken`, no public route accepts one, and counter enrolment still resolves the program's own
`direct` source server-side. The `direct` source cannot be deactivated, because it is what staff enrol
through. Tests assert the token never appears in any returned object or audit row, and that another
business's sources can be neither created, listed nor switched off.

**Dashboard read models** are read-only, tenant-scoped, `VIEW_DASHBOARD`-gated and derived entirely
from ledger and card rows. Every definition is stated once in the code and re-checked in
`tests/integration/metrics.test.ts` against a hand count: transactions as counter events rather than
rows, rewards that stop counting when reversed, visits from the flag frozen at write time, new vs
repeat by `firstSeenAt`, and stamps and points reported separately. A location-restricted membership
sees only its own counters. Nothing is cached, incremented on write, or invented.

---

## 5. Fixed inside this prompt

Found while reviewing my own work, before the gate ran. None reached the branch as a defect; they are
recorded because the review that found them is part of the evidence.

| # | What | Fix |
|---|---|---|
| 1 | `getPointsCardSummary` opened one transaction **per reward tier** to count redemptions — a read that ran on every card scan and got slower as a merchant added rewards | Two queries for the whole card, counted in memory |
| 2 | The enrolment **welcome bonus** was always written at Main, even for a program whose version runs only at another counter — attributing the bonus to a location the program does not run at | `resolveEnrollmentLocationId`: a version listing exactly one location gets that location; several still gets Main, recorded as M-3 below |
| 3 | `listBusinessPrograms` read `availableLocations` **straight off the JSON column**, which is the habit the mechanics contracts exist to prevent | Read through whichever contract owns the row, falling back to "Main only" for a row that parses as neither — a list must not empty a merchant's picker because one program is corrupt |

Two Phase 1a tests changed, both because this phase deliberately changed the behaviour they pinned,
and both updated with the reason written next to them:

- `stamp-mechanics.test.ts` listed `availableLocations` among the mechanics that must be **refused**.
  It is implemented now, so the row moved out of that table and into a positive test that also keeps
  the validation (no empty list, no repeats).
- `memberships.test.ts` expected a `ConflictError` when the last owner demoted themselves. Phase 1b
  refuses earlier and for a broader reason — nobody edits their own membership — so the test asserts
  `ForbiddenError` and then asserts the owner is still an owner. The business still cannot lose its
  last active owner: only an owner may act on an owner, and no one may act on themselves.

---

## 6. Medium and Low findings — recorded, not fixed

Numbering continues from the Phase 1a register (`phase-1a-prompt-3.md` §7 and §13.6), which now runs
to M-11 and L-17.

| # | Sev | Finding | Rationale for deferring | Owner | Phase |
|---|---|---|---|---|---|
| M-12 | Medium | **The metric reads load every matching row for the range.** `liveRedemptions` and the transaction-group counts fetch rows and group in memory, bounded only by the 400-day range cap | Correct and fast at pilot and early-MVP volume, and correctness is what a first dashboard needs most. The fix is a daily rollup table, which is its own design with its own backfill and reconciliation story | development agent | 2 |
| M-13 | Medium | **An enrolment into a multi-location program attributes the welcome bonus to Main.** Enrolment carries no counter, so a program listing several locations cannot know where the customer signed up | Narrowed in §5 so the single-location case is exact. The general fix is for counter enrolment to carry the staff member's location, which arrives with the picker | development agent | 1b Prompt 2 |
| M-14 | Medium | **`availableLocations` holds ids with no foreign key**, because it lives inside the mechanics JSON the spec puts it in. A location deleted outright would leave a dangling id | Locations are deactivated, not deleted, and every write re-checks the location is active and the member may use it — so a dangling id fails closed. A join table would be mutable, which would break version immutability | development agent | 1b Prompt 2 |
| L-18 | Low | **`assertNotLastActiveOwner` is now unreachable** through the services: only an owner may act on an owner, and nobody may act on themselves | Defence in depth for a future verb that does not exist yet. Removing it would be the wrong direction | development agent | 1b |
| L-19 | Low | **A tier's `usageLimit` is per card and lifetime**, with no per-period option, and nothing yet surfaces "already used" to the customer | It is the shape the column implies and the one a merchant asked for; per-period limits belong with campaigns | development agent | 2 |

---

## 7. Secret scan

Tracked files matching `.env`, `secret`, `credential`, `*.pem`, `*.key` or `id_rsa` are exactly two —
`.env.example` and `.env.staging.example` — both variable names with empty values. A pattern search
for assigned literals after `password|secret|token|api_key` across `src`, `scripts`, `prisma`, the
compose files and the workflows returns nothing, and so does a search for fallback secrets. No new
code logs anything: the only `console` call in `src` is Phase 0's narrowed unhandled-error line.

`publicToken` is the one capability this prompt handles, and the source-link module never returns,
logs or audits it. An integration test asserts that for both the returned object and the audit row.

**Prisma outside server-owned code:** none. Every file added by this prompt is under `src/server`.

---

## 8. Index and query review

One migration, `20260912120000_phase_1b_core`, additive only: five statements, no column or type
change, so an old build and a new build both run against a database in either state.

| Statement | Serves |
|---|---|
| `CustomerBusinessProfile(customerId)` | Phase 1a **M-4**: the scanner's phone lookup, which sequential-scanned profiles |
| `CustomerBusinessProfile(businessId, id)` | Phase 1a **M-5**: the customer list's keyset page |
| `LoyaltyOperation(businessId, templateId, createdAt)` | the per-program metric breakdown over a range |
| `CustomerCard(businessId, issuedAt)` | cards issued in a range — the acquisition figure |
| `RewardTier(programVersionId, name)` unique | the new tier-name invariant, beneath the service check |

New query shapes and what drives them:

- **Points engine reads** are all primary-key or `(id, businessId)` lookups under `SELECT … FOR
  UPDATE`, plus a tier read by `(id, programVersionId)` served by `RewardTier(programVersionId)`.
- **`countTierRedemptions`** filters `(customerCardId, rewardTierId, kind)` on
  `LoyaltyOperation(customerCardId, createdAt)` and then in memory; bounded by one card's history.
- **`resolveDirectSourceToken` / `resolveEnrollmentTarget`** join `UtmSourceLink` to
  `ProgramTemplate`, served by `ProgramTemplate(businessId, status)` and the
  `UtmSourceLink(templateId, name)` unique index's prefix. Bounded by 20 live programs.
- **Metrics** drive every range scan off `LoyaltyOperation(businessId, createdAt)` and narrow per
  program with the new composite. Grouped counts are assembled in memory — recorded as **M-12**.

**Not claimed:** no `EXPLAIN` output is presented, because the test and development databases hold a
few hundred rows and the planner correctly prefers sequential scans at that size. The statements
above are a review of query shape against available indexes, not a measurement.

---

## 9. Tests

| Suite | Added |
|---|---|
| `tests/integration/points-engine.test.ts` | 20 tests — lifecycle, integer arithmetic, welcome bonus, daily limit, the redemption contract, usage limits, foreign tiers, idempotency, concurrency, reversals, engine isolation |
| `tests/integration/multi-location.test.ts` | 7 — Phase 1a preservation, version-gated locations, cashier assignment, cross-tenant refusal, reversal attribution |
| `tests/integration/staff-management.test.ts` | 13 — self-edit, grant ceiling, role ceiling, cashier refusals, owner protection, assignment, tenant scoping, audit content, active/inactive |
| `tests/integration/programs-and-sources.test.ts` | 15 — the preserved one-program contract, opt-in second program, pinning, one card per template, enrolment targeting, tier uniqueness, source-link isolation and token secrecy |
| `tests/integration/metrics.test.ts` | 10 — every metric definition, tenant isolation, permission gate, location restriction, range validation |
| `tests/unit/points-mechanics.test.ts` | 8 — the contract's refusals and its integer arithmetic |
| `tests/unit/available-locations.test.ts` | 7 — the location decision table |

Browser tests are unchanged and still pass: no HTTP route and no screen changed in this prompt, so a
new browser test would exercise nothing this suite does not already cover.

---

## 10. Delivery

- Committed on `rebuild/phase-0-foundation`.
- `master` untouched at `b9ee686`.
- Only `rebuild/phase-0-foundation` pushed, to the private deploy remote, with `git ls-remote`
  confirmed against the final HEAD.
