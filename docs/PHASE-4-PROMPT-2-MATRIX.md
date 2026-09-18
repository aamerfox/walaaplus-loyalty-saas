# Phase 4 Prompt 2 — capability, authorization, money-flow and abuse matrix

Written **before any code**, as the prompt requires. §1 is the blocker that has to be settled first,
because the owner flow the prompt mandates is not currently possible.

---

## 1. BLOCKER FOUND FIRST: the draft lifecycle cannot work for money programmes

Prompt 2 requires owner UI for **creating and managing DRAFT** cashback and discount programmes.
Migration 21 froze `MonetaryRule` and `MonetaryTier` against `UPDATE` and `DELETE`
**unconditionally** — at INSERT, not at activation.

Probed against the real database, every statement inside a rolled-back transaction:

```
fixture: DRAFT version + rule + tier 0 created

Q1. Can an owner CORRECT a draft's rate before publishing?
  REFUSED  UPDATE MonetaryTier rate on a DRAFT version
           MonetaryTier is frozen; a tier change is a new program version
  REFUSED  DELETE MonetaryTier on a DRAFT version
  REFUSED  DELETE MonetaryRule on a DRAFT version

Q2. Can an owner DISCARD a money draft? (the lifecycle deletes the version row)
  REFUSED  DELETE ProgramVersion (the draft) with a rule attached
           violates foreign key constraint "MonetaryRule_programVersionId_fkey"

Q3. Does PUBLISHING a money draft work?
  ALLOWED  UPDATE ProgramVersion SET status='ACTIVE'

Q4. After activation, are the rule and tiers correctly frozen?
  REFUSED  INSERT a new tier on the now-ACTIVE version
```

**Q3 and Q4 are right. Q1 and Q2 are the defect.** An owner who mistypes a rate on a draft cannot
correct it, cannot delete the tier, and cannot even throw the draft away — the programme is stuck
with no path forward except publishing something wrong.

### 1.1 Why this is a defect and not a deliberate constraint

The rule migration 21 meant to enforce is *"a live rate never changes, because cards pin to a
version"*. Its own error text says so: **"a tier change is a new program version"**. That invariant is
about **ACTIVE** versions. A DRAFT version has no cards pinned to it — `CustomerCard.programVersionId`
can only reference a version that was ACTIVE when the card was issued — so editing a draft changes
nothing anyone agreed to.

Migration 21 implemented "frozen" as *frozen from the moment of writing* when it should have been
*frozen from the moment of activation*. The `INSERT`-side guard already gets this right: it refuses an
insert unless the version is `DRAFT`. The `UPDATE`/`DELETE` side was written as a blanket refusal.

### 1.2 Migration 22 — proposed, with the reason stated before applying

**Additive. No schema change. Two trigger function bodies replaced.**

`walaaplus_monetary_rule_guard` and `walaaplus_monetary_tier_guard` permit `UPDATE` and `DELETE`
**only while the owning `ProgramVersion` is `DRAFT`**, and refuse them otherwise with the message they
already use.

| | Today | Migration 22 |
|---|---|---|
| INSERT on a DRAFT version | allowed | allowed (unchanged) |
| INSERT on ACTIVE/RETIRED | refused | refused (unchanged) |
| UPDATE/DELETE on a **DRAFT** version | **refused — the defect** | **allowed, for rates and thresholds only** |
| UPDATE/DELETE on ACTIVE/RETIRED | refused | refused (unchanged) |
| Re-pointing a rule/tier at another parent | not checked | refused, on every version status |
| DELETE of a CASHBACK/DISCOUNT `ProgramVersion` | allowed once its rule was gone | **refused** — money versions retire |
| Activating an incomplete money version | service-only check | refused in the database |

**This relaxes exactly one window and narrows nothing.** Every guarantee that applies once a version
is live is byte-for-byte the same, and that is what the red proof must show: adding, editing or
deleting a tier on an ACTIVE version stays refused.

Migrations 14–21 are not amended. `MonetaryOperation` is untouched — the financial record remains
append-only, and nothing here lets a recorded operation change.

#### The draft window is for rates and thresholds, not for the unit

A DRAFT rule's `currency` and `currencyExponent` are **not** in the editable window, on either an
INSERT or an UPDATE. The guard derives the business currency through
`ProgramVersion → ProgramTemplate → Business` and refuses any rule that does not carry it — so a
merchant trading in SYP cannot denominate a programme in USD, and supplying USD's genuine exponent of
`2` does not help, because the currency itself is what is refused. The exponent is then checked
against `SupportedCurrency` as before.

This is `docs/PHASE-4-MONEY-CONTRACT.md` §1.3 made structural: there is no conversion layer and no
rate source anywhere in this product, so a programme denominated in anything but the business's own
currency has no defined meaning. **A first version of migration 22 permitted this edit and a test in
this repository asserted it as correct behaviour** — the contract violation was written down as a
passing test, which is the failure mode worth naming.

**Consequence for the owner UI: there is no currency field and no exponent field, editable or
otherwise.** Both are displayed as the business's, and the only inputs on the rate-table editor are
tier thresholds and rates.

**Discarding a money draft** is the existing non-destructive `DRAFT → RETIRED` transition. Program
versions are retired, never deleted; `walaaplus_protect_money_program_version` refuses a `DELETE` of
any CASHBACK/DISCOUNT version even after its tiers and rule have been removed, and a retired draft can
never later be activated. Stamp and points versions keep their existing draft-discard flow unchanged,
which is a positive control in the suite rather than an assumption.

---

## 2. Capability matrix

| Capability | Who | Permission | Where |
|---|---|---|---|
| Create a money programme (template + v1 DRAFT + rule + tiers) | owner, manager | `EDIT_TEMPLATES` | owner UI + route |
| Edit a DRAFT's rate table | owner, manager | `EDIT_TEMPLATES` | owner UI + route |
| Discard a DRAFT | owner, manager | `EDIT_TEMPLATES` | owner UI + route |
| Publish a DRAFT (activate) | owner, manager | `EDIT_TEMPLATES` | owner UI + route |
| Open a new DRAFT from a live money version | owner, manager | `EDIT_TEMPLATES` | owner UI + route |
| **Edit a live version** | **nobody, ever** | — | refused by trigger and by service |
| Record cashback earned | cashier+ | `MAKE_ACCRUALS` | scanner |
| Redeem cashback | cashier+ | `MAKE_REDEMPTIONS` | scanner |
| Apply a discount | cashier+ | `MAKE_REDEMPTIONS` | scanner |
| Reverse any money operation | cashier+ | `MAKE_ACCRUALS` **and** `MAKE_REDEMPTIONS` | scanner |
| View a card's money history | owner, manager, cashier | `VIEW_CUSTOMERS` | customer record |
| View a programme's rule and tiers | owner, manager | `VIEW_TEMPLATES` | programme detail |

**D36 stated accurately, not papered over.** `effectivePermissions` is *role defaults ∪ explicit
grants* — the membership column adds and never restricts — and every `CASHIER` holds both
`MAKE_ACCRUALS` and `MAKE_REDEMPTIONS` by default. **No role this product currently defines can earn
without also being able to redeem.** The guards enforce the split; the roles do not yet exercise it.
The UI must not imply otherwise.

---

## 3. Money flow

| Step | Who supplies it | Who computes it |
|---|---|---|
| Pre-discount invoice total | **staff type it** — a staff assertion, never verified | — |
| Currency + exponent | — | **the business's** — never entered, never offered, never converted |
| Tier | — | server, from qualified spend **before** this invoice (D35) |
| Rate | — | server, from the pinned tier |
| Cashback earned | — | server, half-up |
| Redemption applied | staff request the amount | server caps at `min(requested, balance, invoice)` |
| Discount | — | server, half-up |
| **Amount to collect** | — | **server** — an instruction to a person |

Nothing here is a payment, a settlement, a receipt, a tax document, a POS sale, or verified revenue.
The UI must say what it is and must not imply any of those.

---

## 4. Abuse matrix

| # | Abuse | Control |
|---|---|---|
| B1 | Cashier inflates invoices to move a customer up the tiers | Bounded, append-only, attributed to the actor. Visible and traceable; not prevented. Reporting is out of scope |
| B2 | Cashier redeems more than the balance | `min(requested, balance, invoice)`, plus the non-negative CHECK and the chained balance |
| B3 | Cashback used as a cash machine | Redemption capped at the **invoice**. No withdrawal verb exists anywhere in the code |
| B4 | Double submission at the counter | Idempotency key reserved first inside the same transaction; a duplicate replays the original response |
| B5 | Two cashiers on one card at once | `SELECT … FOR UPDATE` on the card, plus the `(card, sequence)` unique index as the real guarantee |
| B6 | Owner edits a live rate to change what past cards agreed to | Refused by trigger; a rate change is a new version |
| B7 | Owner sets a 100% cashback rate | Allowed by the rate bound, and it is their money. Rates are `0..10000` bp |
| B8 | Cross-tenant card or operation | Every lookup tenant-scoped; "not found" never "forbidden" |
| B9 | Money card reached through the withdrawn public join flow | Refused today and must stay refused — B7 decision, unchanged |
| B10 | Staff correct a mistake by editing a balance | No edit path exists. Linked reversal only, and the reversal is refused if the value has been spent |
| B11 | Float arithmetic entering the UI | The form parses to `bigint` minor units through the exact parser; no `Number` arithmetic on money |

---

## 5. What Prompt 2 will NOT build

* fixed-amount discounts — **D34**, deferred;
* any public route, public lookup, or public enrolment for money cards;
* wallet passes for money cards — the existing refusal stands;
* cash withdrawal, transfer, payout or stored-value payment — no such verb will exist;
* POS, receipt, tax, payment provider, or any external call;
* a new permission, secret, dependency, Compose/Docker/Caddy/DNS/network change.
