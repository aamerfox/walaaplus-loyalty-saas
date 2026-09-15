# Phase 4 — repository-wide `CardType` and mechanics exhaustiveness audit

**Why this document exists.** Four defects surfaced while building Phase 4 Prompt 1, and all four were
the same shape. That is not four bugs; it is one systemic risk with four symptoms, and the right
response is to audit every path rather than fix the four that happened to trip over.

The audit found **eight more reachable defects and one latent trap** — twelve in total, every one the
same shape. Two (A10, A11) were found only on a **second** sweep after the first round of fixes, and
one (A12) only on a **third**, after the Foundation-Correction rebase. That progression is itself the
finding: a single pass over a systemic problem is not enough, and neither is two.

The risk, stated once:

```ts
if (cardType === CardType.POINTS) { …points… }
return { …stamp… };                              // everything that is not POINTS is now STAMP
```

```ts
isPointsMechanics(m) ? … : isStampMechanics(m) ? … : undefined   // money falls off the end
```

**Neither form fails when a value is added to the enum.** The first silently routes the new type into
the stamp engine. The second silently drops it — which in one case meant a live money programme could
have its only counter closed without anything reporting it stranded.

---

## 1. Method

Every source, worker, route, UI selector, serializer, analytics query, template/version lifecycle,
card-rendering path and test helper that names `CardType`, or that reads `ProgramVersion.mechanics`,
was read. **20 files** reference `CardType`; **9** dispatch on it or on a mechanics contract. Every
place that renders a balance, a threshold or an award figure in the UI was read separately, because a
*plausible* number is worse than an error.

The sweep was run twice: once after the first round of fixes, and again after consolidating the
dispatches, because the consolidation itself introduced a regression (§2.4).

For each reachable path the requirement was to prove it either

1. **handles** `CASHBACK` and `DISCOUNT` through the monetary engine, or
2. **refuses** them explicitly and safely, because that capability is Prompt 2.

"Refuses safely" means: fails closed, does not route into the stamp engine, and does not put a
plausible wrong number in front of anybody.

---

## 2. Findings

### 2.1 Reachable defects, fixed

| # | Path | What happened with a money card | Fix |
|---|---|---|---|
| **A1** | `customers/enrollment.ts` `resolveSource` | mechanics read through the **stamp** contract → **a money program could not issue a card at all**, with an error blaming the data | exhaustive `switch`; `welcomeUnits` forced to 0 for money |
| **A2** | `program/versions.ts` `validateDraft` | a cashback draft validated against the **stamp** contract → would have been **published as a stamp program** | `DRAFT_EDITABLE_CARD_TYPES` + `assertDraftEditable` at three entry points |
| **A3** | `program/program-detail.ts` `getScannerScope` | a money program appeared in the **cashier's picker** with no engine behind it | `SCANNER_CARD_TYPES` filters the query and narrows the type |
| **A4** | `tenant/locations.ts` stranded-program check | money version parsed as neither contract → `continue` → **closing its only counter stranded it silently** | `readVersionAvailableLocations`, exhaustive over contracts |
| **A5** | `program/programs.ts` `locationsOf` | returned `null` → a branch-pinned money program **displayed as Main-only** | same resolver |
| **A6** | `customers/lookup.ts` | else-is-STAMP → refused with *"does not hold valid stamp mechanics"*, which reads as **data corruption** | `assertCounterSupportsCardType` first, refusing by name |
| **A7** | `business/customers/[profileId]/page.tsx` | rendered the **stamp tile** → "Stamps: 0" on a customer's record for a cashback card | tile gated on the type that **owns** that balance |
| **A8** | `business/programs/[templateId]/page.tsx` | metric labelled **"Stamps awarded: 0"** for a money program | tile rendered only for the two types that award units |
| **A10** | `program/program-detail.ts` `getProgramDetail` | same `POINTS ? … : STAMP` ternary → the **detail page an owner reaches by clicking their own programme** failed with *"does not hold valid stamp mechanics"* | money returns the common fields with `earnRule`, `stampReward`, `pointsLabel` and `dailyAwardLimit` **null**; the page omits the whole "how it works" block rather than filling it |
| **A11** | `business/customers/[profileId]/page.tsx` rewards tile | rendered **"Rewards: 0"** beside a cashback card, implying a reward mechanic it does not have | tile rendered only for the two types that have rewards |
| **A12** | `business/programs/[templateId]/page.tsx` rewards **section** | rendered a **"The reward"** heading above an **empty tier list** for a money programme | the whole card is rendered only for the two kinds that have rewards |

**A12 was found on a third sweep**, after the Foundation-Correction rebase. It is the same judgement
as A7, A8 and A11 and it survived two earlier passes: an empty section under a confident heading
describes a different programme just as a zeroed stamp tile does. Three sweeps found three more
instances of one mistake — the count is recorded because it is the honest measure of how easily this
class hides.

**A10 is the worst of the second batch**, for the same reason A3 was the worst of the first: it is
reachable by an owner doing the ordinary thing, and the error blames the data rather than the screen.

The fix for A10 is worth stating precisely, because the tempting fix is wrong. Returning
`earnRule: { mode: "MANUAL", unitsPerAward: null }`, `dailyAwardLimit: null`, `welcomeUnits: 0` would
make the page render without error - and every one of those rows is *individually true* of a money
programme. Together they describe a **stamp programme with no rules configured**. Null, and a block
that is not rendered at all, is the honest shape.

### 2.2 Latent, hardened

| # | Path | Status |
|---|---|---|
| **A9** | `program/counter.ts` `reverseCounterOperation` | else-is-STAMP. **Unreachable today** — `cardTypeOfGroup` resolves a `LoyaltyOperation`, and the monetary engine writes only `MonetaryOperation`, so a money group id is simply not found. Converted to an exhaustive `switch` ending in `assertNeverCardType`, so the day anything writes a `LoyaltyOperation` for a money card it is a **compile error** rather than a stamp-engine write |

### 2.3 Already safe, verified rather than assumed

| Path | Why it is safe |
|---|---|
| `wallet/wallet-pass.ts` | explicit `cardType !== STAMP` refusal with a stated reason. Points cards have always been refused here too |
| `segments/definition.ts` | `z.enum([STAMP, POINTS])` — an unknown value is refused by the schema. A money card cannot be segmented; that is a capability gap, not a wrong answer |
| `customers/customer-360.ts` | guarded `isStampMechanics` / `isPointsMechanics` with `null` fallbacks. Version-derived figures come back `null` rather than guessed; balances shown are the ledger's own projections, which are genuinely zero for a money card |
| `api/staff/programs/route.ts` | `z.discriminatedUnion("cardType", …)` refuses `CASHBACK`/`DISCOUNT` outright |
| `api/staff/program-version/route.ts` | `z.discriminatedUnion("kind", …)` refuses money mechanics outright |
| `business/programs/new/NewProgramForm.tsx` | a local `"STAMP" \| "POINTS"` union; the form offers two options and cannot submit a third |
| `analytics/metrics.ts` | passes `cardType` through; aggregates `LoyaltyOperation` rows, of which a money card has none |
| `customers/counter-enrollment.ts` | see §2.4 |
| `program/stamp-program.ts` `getActiveStampProgram` | the query filters `cardType: STAMP`, so the Phase-1a single-programme screen can never select a money template |
| `business/customers/page.tsx` (the customer LIST) | the three columns are per-CUSTOMER totals across all their cards. A money card contributes 0 stamps, 0 points and 0 rewards, which is **true**, not a placeholder. The missing cashback column is Prompt 2 |
| `business/page.tsx` (the dashboard) | "Stamps awarded" / "Points awarded" are business-wide aggregates over `LoyaltyOperation`, of which a money programme has none. Genuinely zero rather than wrongly attributed; a money figure is Prompt 2 |
| `card/[shareToken]/page.tsx` | stamp-only **since Phase 1a** - a POINTS card already gets the same refusal - so money inherits an existing limitation rather than meeting a new one. Fails closed, does not mislabel. Left alone deliberately: changing it would alter points behaviour, which is outside this prompt |
| `program/versions.ts` `parseStored` | returns `null` for a money version. Nothing renders it - the version-history table shows numbers, dates and card counts, all true of a money version. The comment saying "parses as neither" was corrected, because that used to mean "corrupt" and no longer does |
| `src/worker/`, `src/egress/` | **no `CardType` reference at all** |

### 2.4 A weakening I introduced, and caught

Consolidating the two-contract ladders replaced this in `counter-enrollment.ts`:

```ts
const parsed = isPoints ? … : isStamp ? … : null;
if (!parsed) throw new NotFoundError("Card not found");   // fail closed
```

with a call to `readVersionAvailableLocations`, which returns `null` for **both** "Main only" and
"parses as no contract". That silently turned a fail-closed capability check into the most permissive
reading: a version nobody can parse would have been treated as Main-only rather than refused.

Fixed by adding `versionContractOf`, which keeps the two apart, and restoring the explicit
fail-closed check ahead of the location logic. It has its own test, because a distinction that was
lost once inside a refactor will be lost again inside the next one.

### 2.5 Pre-existing stamp-only paths, unchanged

`customers/card-view.ts` (`getPublicCardView`) calls `readStampMechanics` unconditionally. A **points**
card already gets the same refusal there, so this is a Phase 1a limitation that money cards inherit
rather than something Phase 4 introduced. It fails closed and does not mislabel. Left alone
deliberately: changing it would alter behaviour for points cards, which is outside this prompt.

---

## 3. The guard against the next card type

`src/server/program/card-type-support.ts` is now the one place that knows how many card types exist.

* **`CARD_TYPE_SUPPORT: Record<CardType, …>`** — adding a fifth enum value **fails to compile** until
  somebody states which engine owns it and whether the counter, the draft editor and wallet passes
  support it.
* **`assertCounterSupportsCardType`** — refuses by name, with a sentence about the *screen* rather
  than about the data.
* **`readVersionAvailableLocations`** — exhaustive over all three mechanics contracts. Replaces the
  ladder that appeared in four places.
* **`versionContractOf`** — keeps "Main only" and "unparseable" apart for the one caller that hands
  over a capability.
* **`assertNeverCardType`** — compile-time exhaustiveness for a `switch`, and it throws too, because
  `strict` can be turned off and a generated client can be stale.

**Every remaining dispatch now goes through it.** The final sweep found and closed three leftovers:
the last `POINTS ? … : STAMP` ternary in `getProgramDetail` (now an exhaustive `switch` ending in
`assertNeverCardType`), the two-contract ladder still inside `getScannerScope` (unreachable for money
because the query filters, but the shape is the one that caused every other defect), and a stale
comment on `parseStored`.

`grep -rn "isPointsMechanics" src --include=*.ts -A3 | grep -B2 "isStampMechanics"` now returns
nothing outside `card-type-support.ts` itself.

`tests/unit/card-type-support.test.ts` (20 tests) holds the same line at runtime and adds a narrow
source-level sweep: the five modules that dispatch must import this one, and none of them may still
contain the two-contract ladder. The sweep is deliberately **not** a general pattern match on style —
that would go stale or cry wolf.

---

## 4. What is still absent for money cards, by design

None of these is a defect; each is Prompt 2 or later, and each is now a **refusal** rather than a
silent fallback.

* no owner configuration screen, no cashier counter screen, no customer card view;
* no wallet pass;
* no segment targeting;
* no public route and no public API exposure;
* no draft-version editing — a money rate is frozen to the version it was configured on, and a rate
  change is a new version.
