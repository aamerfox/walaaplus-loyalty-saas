# Phase 1b — Merchant MVP

Phase 1b ships in two prompts. **Prompt 1** built the server side: points programs with reward
tiers, multi-location operations, full staff management, named enrolment sources, and the read models
a dashboard is derived from. **Prompt 2** built the merchant interface on top of it and rebranded the
product to **Zademi** (§10–§13).

Phase 1a's documentation is [PHASE-1A-IMPLEMENTATION.md](PHASE-1A-IMPLEMENTATION.md), and the rules
it records still hold unless a section below says otherwise and says why.

---

## 1. What is in scope, and what is deliberately not

| In | Out, and which phase owns it |
|---|---|
| Points mechanics contract, reward tiers, the points engine | Wallet passes, push, offline caching (1.5) |
| Multi-location for authenticated staff operations | SMS OTP, public self-enrolment (blocked by decision **B7** until phone ownership can be proved and independently audited) |
| Managers, configurable permissions, active/inactive staff, location assignment | CSV, campaigns, GHL, billing, cashback, discounts, coupons, gift and membership cards |
| Named source links as server-side attribution records | Publishing a new program version, location management, source-link mutation from the UI (§12) |
| Tenant-scoped dashboard read models derived from the ledger | Production deployment |
| The merchant interface and the Zademi brand system (§10, §11) | |

**Sections 2 to 9 describe Prompt 1 and were written when no HTTP route had changed.** Prompt 2 then
opened the location parameter at the edge, together with the picker that makes it usable — §10.2 says
exactly which routes and under what guard. Everything else in those sections still holds.

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

---

## 10. The merchant interface (Prompt 2)

Prompt 1 deliberately shipped no screens. Prompt 2 builds them, and the rule it works under is that
**a control exists only when the server behind it does**: no greyed-out promises, no settings the
domain does not have, and no button whose only possible outcome is a refusal.

| Screen | What it does | Server behind it |
|---|---|---|
| `/business` | Ledger-derived dashboard over the last 30 days, with per-program and per-location rows | `getBusinessMetrics` |
| `/business/programs` | Every program, stamp or points, with status, reward count and locations | `listBusinessPrograms` |
| `/business/programs/[id]` | One program: earning rule, daily limit, welcome bonus, locations, rewards, its own activity, and where its cards came from | `getProgramDetail`, `getBusinessMetrics`, `listSourceLinks` |
| `/business/programs/new` | Create an additional program, stamp or points, with a tier editor | `POST /api/staff/programs` |
| `/business/locations` | The counters the business operates, read-only | `listBusinessLocations` |
| `/business/team` | Staff, roles, extra permissions, assignments, activate/deactivate | `listBusinessStaff`, `POST /api/staff/membership` |
| `/scanner` | Both card kinds, with a location choice where the program has one | `/api/scanner/*` |

### 10.1 Three things the screens refuse to do

**They never decide access.** Every page resolves the membership from the database on the request
and every route re-checks it. A hidden button is a courtesy; the refusal is in the service.

**They never guess a location.** Where a program runs at several counters the actions stay disabled
until the cashier chooses, because the server refuses to guess and a default would attribute revenue
to the wrong branch silently. The picker is built from a scope the server resolved from the member's
own assignment, so it cannot offer an option the write would refuse.

**They never publish a capability.** No owner screen carries an enrolment link or QR (B7), and the
customer's card link appears only after staff press reveal — which is audited, without the token.

### 10.2 New routes

| Route | Shape |
|---|---|
| `POST /api/staff/programs` | Strict discriminated union on `cardType`. Creates an additional program; the name rule protects the double-click. Returns no source token |
| `POST /api/staff/membership` | Strict union on `action`: role, permissions, locations, deactivate, reactivate. OWNER is not an option the schema offers. Returns `{ok:true}` and nothing else, so the screen re-reads the list |
| `POST /api/scanner/points` | Strict union on `mode`: manual, visit, purchase, redeem |

`/api/scanner/award`, `/redeem` and `/reverse` were rewritten with strict schemas in the same prompt.
They used to read `String(body.x ?? "")` field by field, which accepted anything and coerced it.

**`locationId` is now accepted on the scanner write routes and nowhere else.** `readJsonObject` gained
an `allowLocation` option that permits a top-level `locationId` while still refusing a nested one;
the value is then validated against the card's pinned `availableLocations` and the member's own
assignment inside the write transaction. A reversal still refuses it outright.

### 10.3 Two defects found and fixed in Prompt 2

| What | Why it mattered |
|---|---|
| **The scanner lookup read every card through the STAMP contract.** One points card in a business made a phone lookup throw — and it took that customer's stamp cards down with it, because the lookup maps over every card the number matched | The engines were isolated; the read that feeds the counter was not. `CardSearchResult` is now a union on `cardType`, read through whichever contract owns the version |
| **The sidebar's sign-out button had no handler.** It looked like a button, sat on every merchant screen, and did nothing | The only way to end a session on a shared till was to clear cookies, and the person who pressed it walked away believing they were signed out |

---

## 11. The brand system

`docs/BRAND.md` is the authority. In short: one token file (`globals.css`) carries the palette and
the semantic colours, components address the semantic tokens, and a unit test fails the build if a
brand hex value appears in a component. Nunito and Inter for Latin, **Cairo for Arabic** — because
Inter and Nunito carry no Arabic glyphs and the fallback on a Windows till is a stiff Naskh face at
the wrong size. All three are downloaded at build time by `next/font`, so no request reaches a font
CDN from a merchant's browser.

**There is no approved logo asset in the repository.** The product ships a text wordmark and a
neutral geometric mark; BRAND.md §1 lists the exact files needed and §6 records that installed PWA
cards keep their cached icon until re-installed.

---

## 12. The contracts Prompt 2 needed and did not have

Reported rather than invented, as the prompt requires. None of these was worked around with a
schema change or a direct database write from a screen.

| Missing contract | What it blocks | Consequence in the UI today |
|---|---|---|
| **Publish a new program version** | Editing a live program's mechanics, or editing/reordering its reward tiers. `reward_tier_protect` and `program_version_freeze` refuse every write once a version is ACTIVE — by design, so a card keeps the rules it was sold under | The program screen is read-only after creation and says so. Tiers are ordered at creation |
| **Create, rename, deactivate a location** | Everything a locations screen would do beyond listing | `/business/locations` is read-only and says so |
| **Create and deactivate a named source from the UI** | A source-link management screen | The program screen lists sources read-only |

---

## 13. Tests added in Prompt 2

| File | Covers |
|---|---|
| `tests/integration/merchant-routes.test.ts` | Every new route at the HTTP boundary: strict schemas, unknown and privileged fields, tenant and permission boundaries, self-edit and grant-ceiling refusals, idempotent retry, location refusals, the reversal dispatch, and the points-card lookup regression |
| `tests/e2e/merchant-ui.spec.ts` | An owner creating a points program with tiers and reading it back; invalid input that sends no request; the Arabic RTL interface; a points card served at a chosen counter; the card link staying hidden until revealed; and the rebrand |
| `tests/unit/brand-scan.test.ts` | No old brand name in the user-facing tree, one product name in both locales, no brand hex outside the token file |

---

## 14. The visual remediation (Prompt 2, second pass)

The first pass shipped every screen the prompt asked for and was **rejected on how it looked**: the
pages did not read as one product, the logo arrived as disconnected fragments on authenticated
surfaces, and the staging tenant's name — `TrueBiznes` — was being used as the platform's.

What that failure was, in engineering terms, is worth keeping: **there was a component library, and
screens were not obliged to use it.** Each screen had been recoloured into the new palette while
keeping its own spacing, its own control heights, its own card. A palette is not a design system.

The second pass changed three things structurally.

**One vocabulary, and no way around it.** `src/components/ui/index.tsx` owns every surface, control,
table and status primitive. `PageHeader` deliberately has **no prop** that could carry a business
name, because the previous `subtitle={businessName}` was one prop repeated across twelve screens, and
a prop that can be misused across twelve screens will be.

**One brand surface.** The navy rail carries the whole white lockup; the top bar carries nothing. No
screen may reference an asset path — everything asks `Wordmark` for a treatment.

**The platform/tenant rule, in tests rather than in review.** A tenant's name in source is a defect by
definition, because the real ones come from `Business.name`. `tests/unit/platform-identity.test.ts`
enforces that, the one-lockup rule, the absence of a lettered placeholder, and the navigation
vocabulary in both locales.

### 14.1 What the tests could not have caught

Several defects passed every assertion and were found only by opening the rendered screenshots: the
sign-in page's `"W"` placeholder, an Arabic rail reading *geofencing (your branches)*, a landing page
that was still the previous product advertising four unbuilt features, and an Arabic word shown as a
price to English readers. Two lessons are now encoded rather than remembered:

1. `tests/e2e/zademi-visual.spec.ts` writes 40 screenshots — every merchant and public surface, two
   widths, two locales — so a review can look rather than infer.
2. `brand-scan.test.ts` strips Arabic diacritics before matching, because the old product name had
   survived in `messages/ar.json` transliterated and vocalised, invisible to a Latin-only scan.

Full record: `docs/evidence/phase-1b-prompt-2-visual-remediation.md`. The design rules themselves are
in `docs/BRAND.md` §4A–§4C.

---

## 15. The operational lifecycle (Prompt 3)

Prompt 2 finished the merchant interface and recorded three things it could not do, because the
server had no contract for them: create a location, change a live program, and manage named sources.
This is those three contracts, plus the four deferred findings that sit on the same paths.

### 15.1 Locations: closed, never deleted

`src/server/tenant/locations.ts` grew `createLocation`, `updateLocation` and `setLocationActive`.
There is no delete and there will not be one: a location id is a column on every ledger row written
at that counter, and the ledger is append-only by trigger precisely so that history cannot be
rewritten. Deactivation means one thing — **no new value may be written here** — and it is enforced
by code that already existed: `requireLocationAccess` filters on `active: true` inside the
transaction of every scanner write, so a closure takes effect on requests already in flight.

Three refusals, each of which protects a business from turning a tidy-up into an outage:

| Refusal | Code | Why |
|---|---|---|
| Never the main counter | `LOCATION_IS_MAIN` | It is where enrolment writes its welcome bonus and where every version that names no locations operates |
| Never the last active one | `LOCATION_LAST_ACTIVE` | A business with no open counter cannot take a stamp |
| Never the last active counter of a live program | `LOCATION_STRANDS_PROGRAM` | A version pins its locations immutably; if all of them close it can never be transacted at again |

Reactivation keeps the row, so a branch that reopens keeps its history rather than starting again
under a new id. Every verb is audited (`location.created`, `location.updated`,
`location.deactivated`, `location.reactivated`) with the counter's label and never its address.

### 15.2 Versions: draft, review, publish

`src/server/program/versions.ts`. The database already had everything this needed —
`ProgramVersionStatus.DRAFT`, a trigger that freezes mechanics the moment a version leaves DRAFT,
another that refuses to delete one that has, and a partial unique index permitting one ACTIVE
version per template. What was missing was the services over them.

```
  v1 ACTIVE  ──create draft──▶  v2 DRAFT  ──edit──▶  v2 DRAFT  ──publish──▶  v2 ACTIVE
      │                             │                                            │
      │                          discard                                  v1 RETIRED
      ▼                                                                          │
  cards keep v1 forever ◀───────────────────────────────────────────────────────┘
```

**There is no `UPDATE` against `CustomerCard` anywhere in the file.** That is the whole guarantee:
publishing changes which version new cards pin, and nothing about the cards already issued.

Publishing is one transaction under the template's row lock: validate the draft again (a location it
names may have closed since the last edit), retire the live version, activate the draft, write the
audit row carrying the published mechanics in full. The order is forced by
`ProgramVersion_one_active_per_template` — retire first, or the index rejects the second ACTIVE row.
`expectedVersionNumber` is the draft the merchant reviewed, so a publish made stale by somebody
else's publish is refused (`DRAFT_STALE`) rather than applied to a draft nobody read.

One additive migration, `20260913120000_phase_1b_lifecycle`: `ProgramVersion.retiredAt` (not
backfilled — a version retired before the column existed reads "not recorded" rather than borrowing
its successor's date) and a partial unique index giving each template at most one DRAFT.

Pausing is `TemplateStatus.PAUSED` and means **no new sign-ups**. Every issued card keeps earning,
redeeming and being reversible; `resolveEnrollmentTarget` already excluded paused templates, so the
verb needed no special case anywhere else.

### 15.3 Sources stay internal

`updateSourceLink` renames a source and corrects its campaign fields. `utmSource` and the welcome
bonus are deliberately **not** editable: both are baked into cards already issued, and editing them
would rewrite the meaning of history. The built-in counter source is protected from renaming and
from deactivation, because it is what `enrollAtCounter` resolves.

No token, URL, slug or QR is returned by any of it, and the owner screen offers no control that
would produce one. B7 is unchanged.

### 15.4 The four findings this closed

| Finding | Fix |
|---|---|
| **M-10** attribution audit outside the enrolment transaction | `EnrollCustomerInput.counterActor` threads the actor in, so `CARD_ISSUED_AT_COUNTER` commits with the issuance. A repeat enrolment — which hands staff an existing card's link — is now recorded as `CARD_LINK_REVEALED` instead, which is what it is |
| **M-11** no per-actor limit on counter writes | `consumeStaffActionLimit`, keyed on the **membership**: 60 enrolments and 300 writes per hour, per person, per business. Constants rather than environment variables, because a new variable would need an environment-template change this prompt may not make. Enforced at the route, after the membership is verified and before the service, and answered as 429 with `Retry-After` |
| **L-15** dead public-enrolment limiter | `consumeEnrollmentLimit` and its two scopes are gone, and `env.ts` no longer parses the three `ENROLL_RATE_LIMIT_*` variables. The schema is `z.object`, so an environment that still sets them is unaffected |
| **L-17** card-link reveal not location-scoped | `revealCardLink` now checks the card's **pinned** version against the member's assignment. Owners and managers are unrestricted; a cashier sees a card whose version runs at a counter they are assigned to; a cashier with no assignment sees nothing. The refusal is a 404, matching the tenant miss |

### 15.5 What the counter screen had to learn

A card is served under the version it was ISSUED with, not the version its program has since
published. The scanner used to read the counters of the template's live version, which was right
while a program had one version for its whole life. `CardSearchResult` now carries the card's own
`pinnedLocations`, the scope carries `usableLocations` (open, and assigned to this member), and the
picker is the intersection. When that intersection is empty — every counter the card's version names
is closed, or none is assigned to this member — the screen says so and blocks the buttons, instead of
enabling them and letting the server refuse with a customer waiting.
