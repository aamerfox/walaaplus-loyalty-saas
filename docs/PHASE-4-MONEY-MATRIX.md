# Phase 4 — cashback and discount: capability, money-safety, threat and deferred-scope matrix

**Written before any code, and used to constrain it.** Baseline `39fe9be`.

Companion to `docs/PHASE-4-MONEY-CONTRACT.md`, which is the arithmetic; this is the scope, the
authority boundaries and what is deliberately not built.

---

## 0. The sentence this document exists to prevent

> *"Zademi tracks your revenue."*

It does not, and nothing in Phase 4 brings it closer to doing so. Every monetary figure in this
subsystem originates as **a number a member of staff typed into a till screen**. There is no
point-of-sale connection, no receipt, no payment processor, no tax record and no way to check that
the amount entered matches what the customer actually paid — or that they paid at all.

What the product can honestly say is narrower and still useful: *this is what a member of staff said
the purchase came to, this is the discount or cashback the rules produce from that number, and this
is what the staff member was told to collect.* Every label, column name, document and later screen
has to survive being read by somebody who assumes the stronger claim.

---

## 1. Two findings from inspecting the existing money model

The prompt asked for a blocker report rather than a silent assumption if the current structures
cannot carry this safely. **Neither finding blocks the work**, but both change the design, and
neither was written down anywhere before now.

### 1.1 There is no currency exponent in this product. Anywhere.

`Business.currency` is `text NOT NULL DEFAULT 'SYP'`, with **no CHECK, no foreign key, no
enumeration and no exponent column**. The schema comment says "ISO 4217; all amounts are integer
minor units", and nothing defines how many minor units make one major unit.

It is set from a hardcoded `const CURRENCY = "SYP"` at registration
(`src/app/[locale]/auth/register/page.tsx`) and is **never written again** — no service, route or
screen updates it. So every business is SYP today by construction, not by validation.

That is enough to work with and not enough to build money on: "minor units" without an exponent is
an amount without a unit. §3 is what this subsystem does about it.

### 1.2 `integer` is too narrow for money in this product's own default currency

Every existing monetary column is PostgreSQL `integer` (int4), confirmed against the live schema:

| Column | Type | Live today? |
|---|---|---|
| `LoyaltyOperation.purchaseAmountMinor` | `integer` | **yes** — written by the scanner award and points routes |
| `LoyaltyOperation.monetaryDeltaMinor` | `integer` | no — reserved |
| `LoyaltyOperation.redemptionValueMinor` | `integer` | no — reserved |
| `LoyaltyOperation.balanceAfter` | `integer` | yes, as a unit projection |
| `CustomerCard.cashBalanceMinor` | `integer` | no — commented "reserved: gift/cashback" |

int4 tops out at **2,147,483,647 minor units**. At exponent 2 that is **21,474,836.47 SYP**. The
Syrian pound has traded in the region of 13,000–15,000 to the US dollar in recent years, which puts
the ceiling at roughly **USD 1,400–1,700**.

That is an ordinary large purchase — a laptop, a phone, furniture, a bulk grocery order — and it is
nowhere near large enough for the figure this subsystem's tiers actually depend on: **cumulative
qualified spend over a customer's lifetime.** A customer spending 2,000,000 SYP a month reaches the
int4 ceiling inside a year.

**Consequences, and what this prompt does about each:**

| Consequence | Response |
|---|---|
| New financial rows must not use int4 | Every monetary column added in migration 21 is `BIGINT`, with CHECKs bounding it far below the int8 ceiling (§3.3) |
| The cashback balance cannot live in `CustomerCard.cashBalanceMinor` | It is **not stored there**, and that column stays untouched and unused. The balance is derived from append-only rows — which is what §4.2 wanted anyway |
| Cumulative spend must not be an int4 aggregate | Derived by `SUM` over append-only `BIGINT` rows; no editable running total exists |
| `LoyaltyOperation.purchaseAmountMinor` carries the same ceiling **today**, on the live stamp and points path | **Reported, not fixed here.** It is pre-existing, outside this prompt's scope, and widening a live column is a table rewrite that belongs in its own change with its own window. Registered as **D33** |

---

## 2. Authority: who asserts what

The single most important table in this document. Every row of Phase 4 data falls into exactly one
of these columns, and no label may blur them.

| | The system calculates | Staff manually enter | Staff physically honour | Ledger-authoritative | Unverifiable — no POS |
|---|---|---|---|---|---|
| Gross invoice total | | **✓** | | recorded as an assertion | **✓** cannot be checked |
| Which tier applies | **✓** from pinned rules | | | **✓** | |
| Cashback earned | **✓** | | | **✓** | |
| Cashback balance | **✓** derived from rows | | | **✓** | |
| Requested redemption | | **✓** | | recorded as asked | |
| Allowed redemption | **✓** capped | | | **✓** | |
| Discount percentage | **✓** from pinned tier | | | **✓** | |
| Discount amount | **✓** | | | **✓** | |
| Net amount to collect | **✓** | | **✓** the staff member takes it | **✓** as a calculation | **✓** that it was collected |
| That money changed hands | | | **✓** | **never** | **✓** |
| That the invoice is real | | | | **never** | **✓** |

**Read the last two rows twice.** Zademi records a calculation and an instruction. It never records
a payment. A `MonetaryOperation` row is evidence that a staff member asked the system to compute
something and was shown an answer — not that a customer was charged, discounted, or refunded.

---

## 3. Money safety

### 3.1 Integers only, and where the boundary is

All arithmetic is on JavaScript `bigint` and PostgreSQL `BIGINT`. No `number`, no `float`, no
`Decimal`, no string-based decimal library. The boundary where a wire value becomes money is one
parser that accepts a digit string or a safe integer and rejects everything else; past that point
the type system carries `bigint` and a stray `number` will not compile.

### 3.2 Currency and precision, frozen per record

Since the product has no exponent (§1.1), this subsystem introduces one and then refuses to trust it
later:

* a small validated table of supported currencies and their ISO 4217 exponents — **not** a free
  string, and not a number a merchant types;
* the currency **and its exponent are copied onto the monetary rule when it is created, and onto
  every financial row when it is written**, and both are frozen by trigger.

Freezing matters more than validating. If `Business.currency` were ever changed, or an exponent
were ever corrected, a historical row that read the value live would silently change meaning — the
same number of minor units becoming a different amount of money. A row that carries its own unit
cannot be reinterpreted by a later edit.

### 3.3 Bounds

| Bound | Value | Enforced |
|---|---|---|
| Minimum any amount | `0` | CHECK, and the service |
| Maximum gross invoice | `10^15` minor units | CHECK — three orders of magnitude below int8, so no arithmetic on a valid row can overflow |
| Rate | `0 … 10000` basis points (0–100 %) | CHECK on the tier |
| Discount | `≤` gross invoice | CHECK on the row, plus the service |
| Redemption | `≤` min(balance, gross invoice) | service, and CHECK against gross on the row |

The maximum is deliberately a round bound well inside the type rather than the type's own limit: a
sum of several valid rows must also be valid, and `10^15` leaves room for thousands of them.

### 3.4 Rounding

**Half-up to the smallest unit of the record's own currency**, computed in integers:

```
amount = (gross × rateBasisPoints + 5000) / 10000     -- integer division, both operands bigint
```

Half-up is stated as a decision rather than inherited from a language default: banker's rounding is
defensible in accounting but surprises a merchant who checks 10 % of 5 on paper, and JavaScript's
`Math.round` is floating point and therefore excluded by §3.1. The exponent does not appear in the
formula because the calculation is already in minor units — the exponent's job is to render and to
validate, never to scale arithmetic.

---

## 4. What is built now

### 4.1 Program rules, pinned

Cashback and discount are **separate program types**, added to the existing `CardType` enum, so a
card is pinned to a version exactly as stamp and point cards already are.

Monetary rules are **typed tables, not `ProgramVersion.mechanics` JSON.** The prompt forbids a
generic money JSON field and the product already has the precedent: `IntegrationEvent` was given
typed columns and no JSON bag specifically so there would be nowhere for an unvalidated value to go.
A rate in JSON is a rate nothing can constrain.

* `MonetaryRule` — one per program version, carrying kind, currency and exponent. Frozen once the
  version is active.
* `MonetaryTier` — ordered rows per rule: a cumulative-spend threshold and a rate in basis points.

### 4.2 Tiers

* thresholds strictly increasing, the first at zero, no duplicates, no gaps by construction — a tier
  applies from its threshold until the next one;
* rates bounded `0…10000`;
* selection uses **cumulative qualified spend strictly before the current transaction**, so reaching
  a tier affects the next transaction and never the one that reached it. Both readings are arguable
  and they pay different amounts of money, so this one is **registered as D35**, documented in
  `docs/PHASE-4-MONEY-CONTRACT.md` §6, and asserted by a test rather than left to be discovered;
* cumulative spend is `SUM(grossAmountMinor)` over **every row on that card that still stands** —
  earnings, redemptions and discounts alike, excluding reversal rows (which assert no invoice) and
  excluding any row that has since been reversed.

  Redemption and discount rows are counted because they carry a real invoice the customer really
  presented: a customer who spends part of every bill from their balance is still spending, and
  excluding those rows would quietly stall their progress up the tiers. A withdrawn sale stops
  counting, which is the whole reason a reversal is a linked row rather than a deletion.

  It is DERIVED on every read, never stored as an editable aggregate, and therefore incapable of
  drifting from the history.

### 4.3 Operations

| Operation | Records |
|---|---|
| Cashback earn | gross, tier, rate, earned amount, balance after, actor, location, version |
| Cashback redeem | gross, requested, allowed, net to collect, balance after, actor, location, version |
| Discount apply | gross, tier, rate, discount, net to collect, actor, location, version |
| Reversal | a **new row** linked to the original, carrying the exact inverse effect |

All append-only. No UPDATE, no DELETE, no balance edit, no amount correction — a mistake is undone
by a linked reversal that leaves both rows visible.

**The balance is the chain, not a column.** `CustomerCard.cashBalanceMinor` exists, is an `int4`, and
is deliberately left at zero (§1.2, D33). Each row's `cashBalanceAfterMinor` is its predecessor's plus
this row's effect and its `cardSequence` is its predecessor's plus one, both recomputed by trigger —
so a forged balance cannot be inserted without contradicting the row before it, and the unique index
on `(customerCardId, cardSequence)` is what makes that safe when two writers race.

Idempotency uses the product's existing `IdempotencyRecord` pattern: the record is inserted first,
inside the same transaction as the work, so a concurrent duplicate loses on the unique index rather
than doing the work twice.

---

## 5. Threat matrix

| # | Goal | What stops it |
|---|---|---|
| M1 | Award cashback on another business's card | `businessId` from the authenticated context is in every lookup; trigger re-checks card, profile, template and version all belong to it |
| M2 | Redeem more than the balance | Service caps at `min(balance, gross)`; the balance is derived from rows, not from a mutable column |
| M3 | Discount more than the invoice | Service caps; CHECK constraint refuses the row regardless |
| M4 | Get a better rate by picking a tier | The tier is never an input. It is selected server-side from the pinned rule and derived spend |
| M5 | Reach a tier and have it apply to the transaction that reached it | Spend is summed **before** the current row |
| M6 | Double-award by resubmitting | Idempotency record inserted first, in-transaction, on a unique index |
| M7 | Edit a past amount, tier or balance | Append-only: no UPDATE or DELETE for the runtime role, and a trigger refusing both |
| M8 | Reverse twice, or reverse a reversal | Trigger: one reversal per operation, and a reversal cannot itself be reversed |
| M9 | Overflow an amount | `BIGINT` plus a `10^15` CHECK, three orders of magnitude of headroom |
| M10 | Change a currency and reinterpret history | Currency and exponent frozen on every row by trigger |
| M11 | Write a row from a cashier of another location | Location checked against the actor's assignment |
| M12 | Use a stale program version | Version pinned on the card; rule read from the pinned version, not the live one |
| M13 | Reach this from the public API, a share link or a QR token | None of them touch these services; no route is added in this prompt at all |
| M14 | Have a negative amount cancel a cap | CHECK `>= 0` on every monetary column |

---

## 6. Deferred, and why

### 6.1 To Prompt 2

Owner configuration UI, cashier counter UI, customer-facing display, HTTP routes, permissions proved
through routes, and any screen that shows a balance. **This prompt adds no route.**

### 6.2 BoomerangMe-like capabilities deliberately not built

Named so that "not built" is a decision rather than an omission. None of these is started, stubbed,
or made easier by this work.

| Capability | Status |
|---|---|
| Multipass / package cards | Deferred. `CustomerCard.visitBalance` remains reserved and unused |
| Gift cards | Deferred. No issuance, no transfer, no bearer value |
| Membership / subscription | Deferred |
| Coupon-linked conversion to money | Deferred. Promotions stay non-monetary — `benefitDescription` is a sentence, and Phase 3A deliberately gave it no amount |
| Public card actions | Refused. No public enrolment, no customer self-redemption |
| POS integration | Refused, and §0 is why |
| Payments, transfers, refunds of money | Refused. Zademi computes; staff honour |
| Tax, invoicing, accounting export | Refused |
| Wallet delivery of balances | Deferred |
| Referral rewards | Deferred — **D15** is unresolved and this prompt does not resolve it |
| Provider integrations, GHL, OAuth | Refused |
| Fixed-amount discounts | **Deferred explicitly**, §6.3 |

### 6.3 Why fixed-amount discounts are deferred rather than included

The prompt permits them only if they add no monetary surface and weaken no validation. They do add
one: a fixed discount is a **second currency-denominated amount living on the rule**, which needs
its own bounds, its own exponent agreement with the row it is applied to, and its own cap semantics
when the invoice is smaller than the discount. Percentage tiers need none of that — a rate is
dimensionless and bounded `0…10000` by a single CHECK.

So they are deferred rather than simulated with a nullable amount column that most rows ignore.
Registered as **D34**.

---

## 7. Residual risk, stated plainly

* **The invoice total is a staff assertion.** It is not verified, cannot be verified, and may be
  mistyped or invented. Every downstream number inherits that.
* **Honouring is manual.** Zademi computes a discount; a person has to actually charge less. Nothing
  in the record proves they did.
* **A reversal is a record, not a refund.** If money changed hands, returning it is a physical act
  outside this system.
* **Tiers reward asserted spend.** A member of staff who inflates invoice totals moves a customer up
  the tiers. Bounds and append-only history make that visible and attributable; they do not prevent
  it. Detection is a reporting question and is not in this prompt.
* **No role can currently earn without also being able to redeem.** Each money action is guarded by
  the permission its non-money equivalent already needs, and the guards are tested — but
  `effectivePermissions` is *role defaults ∪ explicit grants*, and every `CASHIER` holds both
  `MAKE_ACCRUALS` and `MAKE_REDEMPTIONS` by default. The separation is real in the code and absent in
  practice. Registered as **D36**.
* **A rate is only as frozen as the version it belongs to.** Rules and tiers may be written only
  while their `ProgramVersion` is `DRAFT`, so a live rate cannot be edited or added to. What that
  does not stop is a merchant publishing a new version with worse rates; cards already issued keep
  the deal they were sold under, and new cards get the new one. That is the intended behaviour and it
  is stated here so nobody reads "frozen" as "a merchant can never change a rate".
