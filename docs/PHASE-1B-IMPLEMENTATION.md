# Phase 1b — Merchant MVP: the server and domain core

Prompt 1 builds the server side of the Merchant MVP: points programs with reward tiers,
multi-location operations, full staff management, named enrolment sources, and the read models a
real dashboard is derived from. **No merchant-facing UI, no dashboard pages and no deployment
changes** — those are Prompt 2.

Phase 1a's documentation is [PHASE-1A-IMPLEMENTATION.md](PHASE-1A-IMPLEMENTATION.md), and the rules
it records still hold unless a section below says otherwise and says why.

---

## 1. What is in scope, and what is deliberately not

| In | Out, and which phase owns it |
|---|---|
| Points mechanics contract, reward tiers, the points engine | Template/settings UI, manager and location screens, dashboard pages, source-link UI (Prompt 2) |
| Multi-location for authenticated staff operations | Wallet passes, push, offline caching (1.5) |
| Managers, configurable permissions, active/inactive staff, location assignment | SMS OTP, public self-enrolment (blocked by decision **B7** until phone ownership can be proved and independently audited) |
| Named source links as server-side attribution records | CSV, campaigns, GHL, billing, cashback, discounts, coupons, gift and membership cards |
| Tenant-scoped dashboard read models derived from the ledger | Production deployment |

**No HTTP route changed in this prompt.** The API surface is still Phase 1a's, and
`assertNoLocationInRequest` still refuses a location at that boundary. The location parameter this
phase adds lives on the SERVICES; Prompt 2 opens it at the edge together with the picker that makes
it usable. A service that accepts a location while the only route to it refuses one is not an
inconsistency — it is the order the two prompts were split in.

---

## 2. Points, and why they are a second engine rather than a flag

A stamp card **converts**: reach `stampsRequiredPerReward` and a reward appears in `rewardBalance`,
waiting to be handed over. A points card does not convert at all. Points accumulate and the customer
chooses what to spend them on.

| | Stamp card | Points card |
|---|---|---|
| Earning | stamps accumulate | points accumulate |
| Threshold | automatic conversion, remainder carried | none |
| Reward | sits in `rewardBalance` until handed over | chosen from configured tiers at redemption time |
| Redemption | `REWARD` −1, stamps untouched | `POINT` −`tier.requiredPoints`, no reward balance involved |

`src/server/points/engine.ts` is therefore a sibling of `src/server/stamp/engine.ts`, not a
generalisation of it. Threading `if (cardType === POINTS)` through threshold conversion is how a
stamp card ends up paying out a points reward.

What they genuinely share lives in `src/server/program/card-actions.ts`: what a transactable card is,
what the daily limit counts, what an idempotency key must look like, and what counts as money. Both
engines call the same `appendOperationGroup`, take the same card lock, and run under the same
`runIdempotent`.

**Neither engine can touch the other's card.** Each reads its own discriminator from the version's
pinned mechanics (`kind: "POINTS"` / `"STAMP"`) and refuses the other with a `LedgerInvariantError`
before any arithmetic happens. That is a 422, not a 400: a points version handed to the stamp engine
is a corrupt or mis-routed row, and guessing a threshold would hand out the wrong number of rewards.

### 2.1 Integers, everywhere

Every quantity in the points contract is `z.number().int()`, every money field is integer minor
units, and both earning rules floor-divide. A merchant who wants "1.5 points per 1,000" configures
3 points per 2,000. There is no path where a float can enter a balance — `tests/unit/points-mechanics.test.ts`
asserts it for every amount it tries, and the integration suite re-asserts it on the rows themselves.

### 2.2 The tier-redemption ledger contract

Stated before it was implemented, and implemented exactly as stated. One redemption is **one row** in
one transaction group:

```
kind:                 REWARD_REDEEMED
unitType:             POINT
quantity:             -tier.requiredPoints          (negative, integer, never a fraction)
rewardTierId:         tier.id                       (verified against the card's PINNED version)
redemptionValueMinor: tier.rewardValueMinor ?? null (what the reward cost the merchant)
balanceAfter:         the POINT balance after the debit
```

There is no second row. A `+1 REWARD` row would invent a balance nobody can spend; a
`STAMP_CONVERTED` row would claim a conversion that did not happen.

- **Auditable** through `rewardTierId`. The tier row carries the name, the price in points and the
  merchant value **as they were when the version was frozen**, so a tier renamed in a later version
  cannot rewrite what a customer redeemed last month.
- **Reversible** through the ordinary compensating group: `+tier.requiredPoints`, carrying
  `reversalOfOperationId` and the same `rewardTierId`. The partial unique index on
  `reversalOfOperationId` means it happens at most once, and the redemption stops counting against
  the tier's `usageLimit` because the customer never received the reward.
- **Idempotent** through the same `runIdempotent` wrapper every counter action uses.
- **Never negative.** The affordability check runs under the card lock, and the ledger's own
  non-negative invariant is the backstop beneath it. Two concurrent redemptions of a balance that
  can only pay for one: exactly one commits.

`usageLimit` is per CARD, lifetime, counted as redemptions minus their reversals.

### 2.3 Welcome bonuses

`welcomePoints` must be **fewer than the cheapest tier**, the points equivalent of the stamp rule
that a welcome bonus may not complete a card. Enforced in the program service rather than the
mechanics schema, because tiers are rows and the schema cannot see them.

Enrolment grants the bonus in whichever unit the program uses, branching once, in one place
(`enrollCustomer`). Each engine refuses a card pinned to the other kind, so a mis-branch fails loudly
rather than writing points onto a stamp card.

---

## 3. Several programs per business

Phase 1a allowed exactly one live program, enforced behind a business row lock. That was a pilot
restriction, not a domain truth, and it is lifted here.

**It is not lifted for callers that did not ask.** `allowAdditionalProgram` defaults to `false`, so
the Phase 1a owner screen keeps its exact contract: a second submission conflicts and the route hands
back the program that already exists. That screen has no program picker and no way to say which
program a cashier is enrolling into; letting its double-click create a second live program would give
one customer two cards, two QR codes and two balances, and the merchant would find out weeks later.

Two rules apply whatever the flag says:

- **No two live programs with the same name** (case-insensitive, trimmed). Names are how staff tell
  programs apart, and a repeated submission is the likeliest way to end up with two.
- **At most 20 live programs**, which bounds the picker and the metric breakdowns.

What stays immutable:

| Invariant | Enforced by |
|---|---|
| Card type pinned per template and per version | `ProgramTemplate.cardType`, `CustomerCard.programVersionId` |
| Mechanics frozen once a version leaves DRAFT | `program_version_freeze` trigger (Phase 0) |
| Exactly one ACTIVE version per template | partial unique index (Phase 0) |
| One card per customer **per template** | `@@unique([customerBusinessProfileId, templateId])` |
| Reward tier names unique within a version | `@@unique([programVersionId, name])` (this phase) |

Several programs means several cards for one person — one per program, never two on one, all hanging
off the same `CustomerBusinessProfile`.

**Counter enrolment** now resolves a target: with one live program it is that program, exactly as
before; with several the caller names one, and a template id that is not this business's is "not
available for enrolment" — the same answer as one that does not exist. A `PAUSED` template is never a
target, because `PAUSED` means "no new enrolment, existing cards keep working". The enrolment token
is still resolved server-side and never accepted from a caller (**B7**).

---

## 4. Multi-location

### 4.1 The version decides, not the caller

`availableLocations` lives inside the version's immutable `mechanics` (PRODUCT-SPEC §5.1, §5.2), so a
card can never have its location rules changed underneath it. A merchant who opens a second branch
publishes a new version; cards issued before it keep the rules they were sold under.

**Absent means Main-only, and absent is what every Phase 1a version says.** No migration backfills
anything and no existing card changes behaviour.

| Version says | Caller says | Result |
|---|---|---|
| nothing | nothing | Main |
| nothing | a location, **Main included** | refused — the Phase 1a rule, unchanged |
| one location | nothing | that location |
| several | nothing | **refused**: the caller must choose |
| several | one of them | that location, if the member may act there |
| several | another business's, inactive, or not offered | refused, with one answer for all three |

"Several locations, caller silent" is refused rather than defaulted because a default is wrong
*silently*: every award lands at whichever branch sorted first, discovered weeks later when a manager
asks why one counter has all the traffic.

### 4.2 Two checks, in two places, answering two questions

1. **At publish time** — are these locations yours, and active? (`assertLocationsBelongToBusiness`)
2. **At write time, inside the transaction** — is this location still active, and may THIS member act
   there? (`requireLocationAccess`)

Both are needed. A location deactivated after a program was published must stop accepting awards
without anyone remembering to republish, and a cashier's assignment can change between the two.

`ctx.locationIds` keeps its Phase 0 meaning exactly: `null` is unrestricted (owner, manager), `[]` is
**no access anywhere** and never "unrestricted", and a list is exactly those locations.

### 4.3 A reversal corrects the place the mistake was made

The compensating rows are written at the **original group's** location. Always. There is no parameter
to change it, and supplying `locationId` to a reversal is refused rather than ignored.

The reason is narrow and specific: the only thing such a parameter can do is move value between
branches. Award ten stamps at the airport counter, reverse them "at" the mall counter, and the ledger
says the airport gave away ten and the mall took ten back. Every per-location figure a merchant uses
to pay staff, judge a site or reconcile a till is then wrong, and nothing looks irregular because the
totals still balance.

Who fixed it is recorded separately, on `performedByUserId` of the compensating rows — which is where
that question belongs.

The consequence, stated plainly: **a member who cannot act at the original location cannot reverse
the group.** A cashier assigned to one branch cannot reach into another's ledger to undo something;
the manager or owner who can act anywhere is the person who fixes a cross-branch mistake.

---

## 5. Staff management

Phase 1a could not be escalated because there was nothing to escalate with: the only staff mutation
was "owner creates a cashier". Phase 1b adds a permission editor, a role changer, location assignment
and reactivation — four levers — so it adds the two rules that make them safe.

| Rule | What it closes |
|---|---|
| **Nobody edits their own membership** | A manager with `EDIT_STAFF` adding `EDIT_BILLING` to themselves. Contexts are rebuilt from the database every request, so self-promotion would take effect immediately |
| **Nobody grants what they do not hold** | The same manager granting it to a cashier they control, or to a second account of their own, and acting through it |

The grant ceiling applies to the whole **effective** set a membership would end up with, not only to
the explicit list a caller typed — otherwise the ceiling is stepped over by choosing a role whose
defaults carry the permission instead.

The self rule applies to owners too, deliberately: an owner who removes their own last permission or
deactivates their own membership locks the business out of its own account. A second owner does it,
or support does. Together with "only an owner may act on an owner", that is also what now keeps a
business from losing its last active owner; the explicit last-owner check remains beneath it.

Other properties, unchanged from Phase 0/1a and re-asserted by tests: staff are **global users with
per-business memberships**, never identities embedded in a business; every mutation is tenant-scoped,
so another business's membership id is "not found"; and every change is audited with **ids only** —
no email, no name, no phone, no credential.

**Location assignment replaces the whole set** rather than adding to it, so the caller's intent is the
end state and there is no "remove" verb to forget. Clearing a cashier's locations stops them working,
which is a legitimate thing to do and must never be confused with giving them everything.

---

## 6. Named source links

Every card already carries `utmSourceLinkId` and every profile keeps the UTM triple it arrived with,
so attribution is a property of the data rather than a report reconstructed later. This phase adds
the tenant-scoped service to create, list and deactivate named sources, with per-source welcome
overrides.

**B7 remains binding, and named links are exactly the feature that would quietly undo it** — a link
per campaign, each one a public page with a phone field. So:

- a named link is a **server-side attribution record**;
- its `publicToken` is minted (the schema requires one, and a later phase will need it) and **never
  returned by this module**, never logged, never written to an audit row;
- there is no public route that accepts one, no screen that prints one, and no QR that encodes one;
- counter enrolment still resolves the program's `direct` source itself.

When phone-ownership verification is authorized and independently audited, revealing the token
belongs in that change, with that review.

The `direct` source **cannot be deactivated**: it is the source counter enrolment resolves, so
switching it off from a screen that looks like it is tidying a list would be a program-wide outage.

---

## 7. Dashboard read models

`src/server/analytics/metrics.ts` is read-only, tenant-scoped and gated on `VIEW_DASHBOARD`. Every
number is derived from the ledger and the cards. Nothing is stored as a counter and nothing is
incremented on write: a cached metric is a second source of truth, and the first time it disagrees
with the ledger the merchant has to choose which of their own screens to believe.

| Metric | Exactly |
|---|---|
| transactions | distinct `transactionGroupId` of non-reversal rows. An award that also completed a reward is ONE transaction, not three rows |
| reversals | distinct groups whose rows are `REVERSAL` |
| visits | rows with the `countsAsVisit` flag frozen at write time — never re-derived on read |
| rewardsRedeemed | `REWARD_REDEEMED` rows **minus** those since reversed |
| rewardValueMinorRedeemed | sum of `redemptionValueMinor` over those same rows |
| unitsAwarded | positive award quantities per unit. Stamps and points are reported separately, because adding them would be meaningless |
| newCustomers | profiles whose `firstSeenAt` is inside the range |
| repeatCustomers | profiles that transacted inside the range and were first seen before it |
| cardsIssued | cards whose `issuedAt` is inside the range |

"New vs repeat" counts **people, not cards**: one customer holding a stamp card and a points card
from the same business is one customer, because both hang off one `CustomerBusinessProfile`.

A location-restricted membership sees only its own counters. Today only a cashier is restricted and a
cashier holds no `VIEW_DASHBOARD`, so that is defence in depth — and it becomes live the moment this
phase's permission editor grants the dashboard to a restricted membership.

---

## 8. The migration

`20260912120000_phase_1b_core` is additive only: five indexes and one unique constraint. No column
changes, no type changes, no data movement, so an old build and a new build both run against a
database in either state.

| Statement | Why |
|---|---|
| `CustomerBusinessProfile(customerId)` | Phase 1a finding **M-4**: the scanner's phone lookup sequential-scanned profiles |
| `CustomerBusinessProfile(businessId, id)` | Phase 1a finding **M-5**: the customer list's keyset page |
| `LoyaltyOperation(businessId, templateId, createdAt)` | per-program metrics over a date range |
| `CustomerCard(businessId, issuedAt)` | cards issued in a range — the acquisition figure |
| `RewardTier(programVersionId, name)` unique | a customer picks a reward by name; two with one name make both the picker and the redemption record a guess |

The ledger's existing `(businessId, createdAt)` index drives every range scan; these narrow the two
new grouped reads. Safe on existing data: Phase 1a creates exactly one tier per version.

---

## 9. Tests

| File | Covers |
|---|---|
| `tests/integration/points-engine.test.ts` | earning by all three modes, integer-only arithmetic, welcome bonus exactly once, daily limit, the one-row redemption contract, affordability, usage limits and their reversal, foreign tiers, idempotent retry, concurrent redemption, reversal of award and of redemption, refusal to reverse spent value, and both engines refusing the other's card |
| `tests/integration/multi-location.test.ts` | Phase 1a Main-only preserved, version-listed locations, cashier assignment, cross-tenant and unlisted locations, reversal attribution and who may perform one |
| `tests/integration/staff-management.test.ts` | self-edit, grant ceiling, role-default ceiling, cashier refusals, owner protections, assignment replacement, tenant scoping, audit content, active/inactive |
| `tests/integration/programs-and-sources.test.ts` | the Phase 1a one-program contract preserved, opt-in second program, name collisions, card-type and version pinning, one card per template, enrolment targeting, paused programs, tier-name uniqueness, and the source-link rules including the token never leaving the server |
| `tests/integration/metrics.test.ts` | every definition in §7, tenant isolation, permission gate, location restriction, range validation |
| `tests/unit/points-mechanics.test.ts` | the contract's refusals and its integer arithmetic |
| `tests/unit/available-locations.test.ts` | the decision table in §4.1 |

Browser tests are unchanged: no HTTP route or screen changed in this prompt, and a browser test that
exercised nothing new would only slow the suite down.
