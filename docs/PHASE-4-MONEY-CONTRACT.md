# Phase 4 — the money and rounding contract

**Status:** implemented in Prompt 1 (domain, database, services, tests). No UI, no public route, no
provider, no external call. Companion to `docs/PHASE-4-MONEY-MATRIX.md`, which states what this
product may and may not claim about the numbers below.

This document is the single normative statement of **how an amount of money is represented,
calculated, rounded, bounded and recorded** in WalaaPlus. Where code and this document disagree, one
of them is a defect; they are written to be checkable against each other.

---

## 1. The unit

### 1.1 Every amount is an integer of MINOR UNITS

No amount anywhere in Phase 4 is a decimal, a float, or a string of a decimal. Every one is a whole
number of the currency's smallest unit — piastres for SYP, fils for JOD, yen for JPY.

| Layer | Type | Why |
|---|---|---|
| PostgreSQL | `BIGINT` | `int4` tops out at 2,147,483,647 minor units ≈ 21 million SYP, which a real customer reaches. Registered as **D33** for the pre-existing `int4` money columns this phase does not touch. |
| TypeScript domain | `bigint` | `number` is a double. It is exact for integers only up to 2^53−1, and the *intermediate* product `gross × rateBasisPoints` crosses that long before the result does. |
| Service boundary (JSON) | decimal **string**, or a safe-integer `number` | JSON has no bigint. `parseMinorAmount` accepts a `bigint`, a safe integer, or a string of digits, and **refuses** an unsafe-integer number, a fraction, and anything with a decimal point, sign, exponent or padding. |
| Returned to a caller | decimal **string** | A result is stored verbatim as the idempotency record's response and must survive a JSON round trip unchanged. |

**There is no "parse a price like `12.50`" function.** Converting a major-unit decimal to minor units
needs the currency's exponent, and the exponent belongs to a rule loaded inside the transaction — so
that conversion happens where the rule is known, never at an anonymous boundary. Guessing which unit
a caller meant is precisely the mistake this contract exists to prevent.

### 1.2 The exponent is DATA, never the constant 2

`SupportedCurrency(code, exponent)` is the only place this product states how many decimal places a
currency has. Seeded in migration 21:

| Currency | Exponent | | Currency | Exponent |
|---|---|---|---|---|
| SYP, USD, EUR, TRY | 2 | | JOD, KWD, BHD | 3 |
| JPY | 0 | | | |

A product that hard-codes `/ 100` shows a Kuwaiti merchant a bill ten times too large and a Japanese
merchant one a hundred times too small. So:

* the table is **read-only to the runtime role** (`GRANT SELECT` and nothing else, verified by
  `scripts/db-roles.mjs`);
* a trigger refuses `UPDATE` and `DELETE` **to the table owner as well** — an edited exponent would
  silently reinterpret every historical amount in that currency;
* `MonetaryRule` copies both the code and the exponent at creation, and a trigger refuses a rule
  whose exponent disagrees with the table;
* `MonetaryOperation` copies both again onto **every row**, so a row can always be read back in the
  unit it was written in, whatever anybody later changes.

### 1.3 One currency, the business's own, and no conversion

A programme is denominated in `Business.currency`, read once inside the transaction that creates the
rule, and frozen there. **A caller cannot supply a currency**, because there is no conversion layer,
no rate source, and no intention to add either. A programme that named its own currency would create
exactly one thing: a card whose balance is in a unit the till does not take.

`Business.currency` is plain `text` with no foreign key and no `CHECK` — defaulted to `'SYP'` at
registration and never written again (`docs/PHASE-4-MONEY-MATRIX.md` §1). This phase does **not**
alter that column; it validates against `SupportedCurrency` at rule creation instead, and a business
whose currency has no recorded exponent is told so by name rather than given a guessed two decimal
places.

---

## 2. Rates

A rate is an integer of **basis points**: 0..10000, where 10000 is 100%. Dimensionless, so no
currency is involved and nothing needs converting.

Rates live in `MonetaryTier` — real columns with real constraints — and **never in
`ProgramVersion.mechanics`**, which is a `Json` column. A rate stored as JSON can be `0.05`, `"5%"`,
`5` or `500`, three of which pay the customer the wrong amount, and a JSON column has no foreign key,
no `CHECK` and no trigger to stop a live rate being edited. `assertNoMoneyInMechanics` refuses a
mechanics object carrying any money-shaped key **by name**, so the mistake produces an explanation
rather than a bare "unrecognized key".

---

## 3. Rounding

> **A percentage of an amount is rounded HALF-UP to the smallest valid unit of the currency.**

Computed, in both the service and the database, as the same expression:

```
  (gross × rateBasisPoints + 5000) / 10000        integer division, truncating
```

Both operands are guaranteed non-negative by the callers, so truncation equals flooring and the
expression is exactly round-half-up. There is no "half away from zero versus half up" ambiguity to
resolve because no negative value can reach it.

**Why half-up and not banker's rounding.** Half-up is what a person doing this on paper does, and a
cashier standing in front of a customer has to be able to check the number by hand. Banker's rounding
would round 2.5 to 2 and 3.5 to 4 — correct in a spreadsheet, indefensible at a counter.

**Why the same expression twice.** `walaaplus_validate_monetary_operation` recomputes it and refuses
the row if the service's answer differs — in either direction, one unit high or one unit low. Written
identically in both places, the two cannot drift: change one without the other and every write fails
loudly, rather than a mismatch surfacing in a balance months later.

Worked examples, all asserted in `tests/unit/monetary-money.test.ts`:

| Gross | Rate | Exact | Recorded | |
|---|---|---|---|---|
| 10 | 5% | 0.5 | **1** | an exact half goes up |
| 1 | 50% | 0.5 | **1** | |
| 5 | 50% | 2.5 | **3** | banker's rounding would give 2 |
| 10 | 4.99% | 0.499 | **0** | below a half goes down |
| 900,000,002,906,273 | 3.26% | 29,340,000,094,744.xx | **29,340,000,094,744** | the float version gives …745 |

---

## 4. Bounds

| Bound | Value | Enforced |
|---|---|---|
| Maximum any amount | 10^15 minor units | domain (`MAX_MINOR_AMOUNT`) **and** `CHECK` |
| Minimum any amount | 0 | domain **and** `CHECK` |
| Cash effect | −10^15 .. 10^15 | `CHECK` |
| Rate | 0 .. 10000 bp | domain **and** `CHECK` |
| Currency exponent | 0 .. 4 | domain **and** `CHECK` |
| Tiers per rule | 10 | domain |

The ceiling is a sanity limit, not a currency limit: an invoice of a quadrillion minor units is a typo
or an attack. The domain bound and the `CHECK` are deliberately **equal** — a domain bound that were
larger would turn a user's mistake into a 500 instead of a sentence.

---

## 5. What each operation records

Every row carries the three figures separately, and none is derived from another at read time.

| Field | Meaning |
|---|---|
| `grossAmountMinor` | **A STAFF ASSERTION.** The pre-discount invoice total as typed at the counter. Not a receipt, not verified, not revenue. |
| `requestedRedemptionMinor` | What the staff member asked to redeem, *before capping*. Redemption only. |
| `discountMinor` | The discount the rate produced. Discount rows only. |
| `cashEffectMinor` | Signed change to the cashback balance: **+** earned, **−** redeemed, **0** on a discount, the exact inverse on a reversal. |
| `netCounterAmountMinor` | **What the staff member was told to collect.** Calculated, never entered. |
| `rateBasisPoints`, `monetaryTierId` | The rate and the tier that produced it, copied so the row outlives the tier. |
| `cashBalanceAfterMinor`, `cardSequence` | The chain. See §7. |
| `currency`, `currencyExponent` | The unit, frozen per row. |

### 5.1 Per-kind arithmetic, recomputed by the database

| Kind | Rule the trigger enforces |
|---|---|
| `CASHBACK_EARNED` | `cashEffect = halfUp(gross, rate)`; `net = gross`; no redemption, no discount; tier and rate required; rule must be a CASHBACK rule |
| `CASHBACK_REDEEMED` | `cashEffect ≤ 0`; `−cashEffect ≤ requested`; `net = gross + cashEffect`; no tier, no rate, no discount; rule must be a CASHBACK rule |
| `DISCOUNT_APPLIED` | `discount = halfUp(gross, rate)`; `net = gross − discount`; **`cashEffect = 0`**; tier and rate required; rule must be a DISCOUNT rule |
| `REVERSAL` | `cashEffect = −original.cashEffect`; `gross = net = 0`; names its target; records a reason; target is not itself a reversal, is on the same card, in the same currency |

### 5.2 Caps

A redemption applies `min(requested, balance, invoice)`. Each cap is a separate promise:

* **requested** — staff asked for this much and must never be surprised by more coming off;
* **balance** — a balance cannot go below zero;
* **invoice** — **this is what keeps cashback from being a cash machine.** Redeeming more than the
  bill would hand the customer the difference in cash, which this product does not do and is not
  licensed to do. Capping at the invoice keeps a redemption a *discount on a purchase*.

An over-large request is **capped, not refused**: "you have 4,000 left, take it off this 3,000 bill"
is an ordinary thing for a cashier to say, and the row records both what was asked and what was
applied, so the difference stays visible.

A discount can never exceed the invoice: at 100% the net is zero and no further.

---

## 6. Which tier applies — **D35**

The tier is the **highest threshold at or below the card's cumulative qualified spend**. Tier 0 must
start at zero (the database refuses a rule whose first tier does not), so the selection is total and
there is no default branch to get wrong.

**Cumulative qualified spend** is the sum of `grossAmountMinor` over the card's operations that
**still stand**: every kind, excluding reversal rows themselves (which assert no invoice) and
excluding any row that has since been reversed. A withdrawn sale must not keep a customer in a higher
band — that is the whole reason a reversal is a linked row rather than a deletion.

> **The tier is selected from spend recorded BEFORE this invoice, not including it.**

A customer who has spent 900,000 and presents a 200,000 invoice earns at the rate for 900,000, and the
200,000 counts towards their next visit. A single 500,000 invoice on a brand-new card earns at the
*first* tier's rate.

The alternative reading — include today's invoice — is equally arguable and produces different money.
Two reasons for this one: a cashier can explain it ("you're on the gold rate because of what you've
spent with us"), and it is monotonic, so a customer's rate never depends on how a purchase happened to
be split across receipts. **Recorded as D35 for the owner to confirm or overturn**; overturning it
changes one line in `monetary/engine.ts` and nothing else in the design. Asserted explicitly in
`tests/integration/monetary-core.test.ts` so it cannot change silently.

---

## 7. The balance is the chain, not a column

`CustomerCard.cashBalanceMinor` exists, is an `int4`, and **is deliberately not used**:

1. **`int4` is too narrow for money in SYP** — registered as **D33** rather than widened quietly
   inside a feature. A test asserts the column stays at zero, so anything that starts writing a
   second copy of the balance fails loudly.
2. **A projection column can disagree with its history.** Here, `cashBalanceAfterMinor` is the
   previous row's balance plus this row's effect, and `cardSequence` is the previous row's plus one —
   both recomputed by the trigger. A forged balance cannot be inserted without contradicting its
   predecessor, and a row cannot be slipped in out of order.

### 7.1 Concurrency, in two layers

* The card row is locked `FOR UPDATE` first, so two cashiers on the same card queue rather than race.
  This is what makes "there is enough balance to redeem" a decision that cannot be made twice against
  the same number.
* The **unique index on `("customerCardId", "cardSequence")`** is the backstop for any writer that did
  not take that lock — a direct Prisma write, a future service, a bug. Two writers computing the same
  next sequence collide on the index; one commits, one is refused.

The lock is the ergonomics. The index is the guarantee, and it is the one that is red-proved.

---

## 8. Corrections are linked rows, never edits

There is **no balance adjustment screen, no manual credit, and no generic money JSON field.** A
mistake is undone by a `REVERSAL` row that names what it reverses and why. Both rows stay visible.

* A reversal can happen **exactly once** — `reversalOfId` carries a partial unique index.
* A reversal **cannot itself be reversed** — undoing an undo is a new forward operation.
* A reversal is attributed to the **original's** counter; a caller may not name a location.
* A reversal works on a card that has since been **paused or expired**, because refusing to fix a
  mistake when the customer's card lapsed afterwards leaves the mistake standing forever.
* **A reversal can be refused for lack of balance, and that is correct.** Taking back an award the
  customer has already spent would drive the balance below zero; the honest answer is that the value
  is gone, not a negative balance the customer must pay off.

---

## 9. Least privilege

| Action | Permission | Why that one |
|---|---|---|
| Configure a rate table | `EDIT_TEMPLATES` | Rates live on a program version. The same permission that configures every other program. A cashier can apply a rate and cannot set one — the person at the counter is the one with a customer in front of them. |
| Record cashback earned | `MAKE_ACCRUALS` | "Give the customer what they earned", like a stamp or a point. |
| Record cashback redeemed | `MAKE_REDEMPTIONS` | Spends value. |
| Record a discount | `MAKE_REDEMPTIONS` | A discount gives value away at the counter. A cashier who may award points but not hand out rewards should not be able to take money off a bill either. |
| Reverse any of them | `MAKE_ACCRUALS` **and** `MAKE_REDEMPTIONS` | A reversal both removes and restores value depending on what it undoes. Matches the existing ledger's `REVERSAL` rule exactly. |

**No new `Permission` enum value was added**, and that is a decision rather than an omission: a new
permission would need a screen to grant it, that screen is Prompt 2's, and an ungrantable permission
is worse than a reused one. The reuse is exact rather than approximate — each action maps to the
permission the equivalent non-money action already needs.

**Known limitation, stated rather than implied.** `effectivePermissions` is *role defaults ∪ explicit
grants* — the membership column **adds**, it does not restrict — and every `CASHIER` holds both
`MAKE_ACCRUALS` and `MAKE_REDEMPTIONS`. So **no role this product currently defines can earn without
being able to redeem.** The tests establish that the *guard* enforces the split; they do not establish
that a real role can be in that state, and they say so in a comment rather than implying otherwise.

### 9.1 Database roles

| Table | Runtime role | Table owner |
|---|---|---|
| `SupportedCurrency` | `SELECT` only | trigger refuses `UPDATE`/`DELETE` |
| `MonetaryRule` | `INSERT`, `SELECT` | trigger refuses `UPDATE`/`DELETE`; `INSERT` only on a `DRAFT` version |
| `MonetaryTier` | `INSERT`, `SELECT` | same |
| `MonetaryOperation` | `INSERT`, `SELECT` | trigger refuses `UPDATE`/`DELETE`/`TRUNCATE` |

Two independent layers, and the tests exercise them separately because they fail differently:
**privilege** protects against a bug in this product's code; the **trigger** refuses the table owner
too, protects against a careless operator at a `psql` prompt, and is the only one of the two that can
explain itself.

### 9.2 A rate table is frozen by ACTIVATION, not merely append-only

`MonetaryRule` and `MonetaryTier` may only be written while their `ProgramVersion` is `DRAFT`.

Freezing `UPDATE` and `DELETE` is **not** enough on its own. Without the draft check, a business could
*add* a tier to a live programme — a new top rate, or a threshold that moves existing customers into a
worse band — and every card already pinned to that version would start earning at a rate its holder
never agreed to. Append-only is not the same as immutable, and for a rate table it is the weaker of
the two. A rate change is a **new program version**.

---

## 10. What is NOT here

Nothing in Phase 4 Prompt 1 touches a POS, a receipt, an invoice document, a payment provider, a
cash-transfer provider, tax, accounting export, or any external financial system. There is no public
route, no customer self-service redemption, no owner or cashier UI, no wallet change, no webhook
event, and no staging change. `docs/PHASE-4-MONEY-MATRIX.md` §5 carries the threat matrix and §6 what
is deferred and why — including **D34**, why fixed-amount discounts are not built.
