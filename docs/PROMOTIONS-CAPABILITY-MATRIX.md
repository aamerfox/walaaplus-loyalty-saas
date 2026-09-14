# Promotions and coupons — capability audit

Written **before** the Phase 3A Prompt 3 implementation and used to constrain it. Every row below was
decided first; the code that followed implements the "Supported now" column and nothing else.

The shape of this phase in one sentence: **a member of staff types a coupon code at the counter, and
the product records that the customer is entitled to something a human will hand over.** It does not
calculate, discount, charge, credit, message or issue anything.

Four buckets, used consistently:

| bucket | means |
|---|---|
| **Supported now** | built in this phase, testable locally, with no provider, credential or device |
| **Later provider / business policy** | needs a payment or messaging provider, or a commercial decision nobody has made |
| **Out of scope** | ruled out by B7, by privacy, or because it would make this phase something else |
| **Manual / device gate** | must be checked by a person before any production claim |

---

## 1. The promotion definition

| capability | bucket | notes |
|---|---|---|
| Owner or manager creates a promotion within their own business | **Supported now** | Name, code, window, limits. Tenant-scoped in the `WHERE`, never checked afterwards. |
| Lifecycle: `DRAFT → ACTIVE → PAUSED → EXPIRED` | **Supported now** | Four states, one table of legal transitions, enforced in the service **and** by a database trigger. `EXPIRED` is terminal. |
| Start and end time | **Supported now** | Both optional. A redemption outside the window is refused, and the refusal is the same generic one as every other. |
| Global redemption limit | **Supported now** | Optional. Enforced under a row lock and re-checked by a trigger at insert. |
| Per-customer redemption limit | **Supported now** | Optional. Same enforcement. |
| Editing a promotion's code after creation | **Out of scope** | The digest and its salt are frozen at insert by trigger. A merchant who wants a different code makes a different promotion — rotating a code under a live promotion silently invalidates every printed copy. |
| Deleting a promotion | **Out of scope** | Redemptions reference it. `EXPIRED` is how a promotion ends. |
| Per-branch promotions | **Later business policy** | The location model exists; whether a coupon is business-wide or per-branch is a merchant decision nobody has made. |
| Per-programme or per-card-type promotions | **Later business policy** | Same. |
| Scheduling a promotion to activate itself | **Out of scope** | That is a scheduler, and this phase adds none. A merchant activates a promotion. |

## 2. The code

| capability | bucket | notes |
|---|---|---|
| Owner-chosen code, stored as a **salted digest** | **Supported now** | See §6. The raw code is never stored, logged, audited, returned or rendered after the request that carries it. |
| Recovering a forgotten code | **Out of scope — and a real consequence** | Nothing can. The owner chose it and must keep it; otherwise they expire the promotion and make another. Stated in the UI rather than discovered. |
| Auto-generated codes | **Later business policy** | Would change who is responsible for distributing it. |
| One code, many promotions | **Out of scope** | Codes are unique per business by digest, so a lookup has one answer. |
| QR or barcode coupons | **Out of scope for now** | A scannable coupon is a capability in an image, and it needs the same treatment `CardShareLink` got — a fragment URL, a revocation path, and its own audit. Worth doing; not by extending a typed-code feature sideways. |

## 3. Redeeming

| capability | bucket | notes |
|---|---|---|
| A member of staff types a code for an existing card, at the authenticated counter | **Supported now** | The only redemption path there is. |
| A redemption records a durable **entitlement** row | **Supported now** | Promotion, card, profile, business, time, actor. It is the record that the customer is owed something. |
| Atomic limit enforcement under concurrency | **Supported now** | Row lock on the promotion, count, insert — all in one transaction. Two tills pressing at once cannot exceed a limit. |
| One generic refusal for every ineligible code | **Supported now** | Invalid, malformed, unknown, draft, paused, expired, out of window, exhausted, per-customer exhausted, cross-tenant. A cashier who could tell them apart would be holding a probe. |
| An invalid coupon never blocks the underlying workflow | **Supported now** | The card lookup or enrolment completes; the coupon is a second sentence in the feedback. |
| **Automatically applying a discount** | **Out of scope — the defining exclusion** | No amount, percentage, currency, tax, invoice or total. The row says a customer is entitled to something; a human hands it over. |
| Awarding points, stamps or loyalty balance | **Out of scope** | Nothing in this phase touches the ledger. |
| Referral reward on redemption | **Out of scope** | D15 is not decided here. |
| Public coupon lookup, claim page, or QR claim flow | **Out of scope — B7** | No public route is added. |
| Redeeming for a customer who has no card | **Out of scope** | Redemption attaches to a card. Enrol first, at the counter, as B7 requires. |
| Stacking several coupons in one transaction | **Later business policy** | Needs a rule about precedence that nobody has written. |

## 4. Voiding

| capability | bucket | notes |
|---|---|---|
| Owner or manager voids a redemption | **Supported now** | An append-only `VOIDED` row referencing the original. Nothing is edited or deleted. |
| A cashier voiding one | **Out of scope** | Recording happens at a till; deciding a record was wrong is a correction to the business's own history. |
| **A void restores the customer's entitlement** | **Supported now, and deliberate** | Voided rows do not count toward either limit. A void here means "that did not happen", so the customer can use their coupon — the opposite of `ReferralAttribution`, where voiding does not free the slot because re-attributing would be retrospective. Two tables, two meanings, both written down. |
| Reversing a void | **Out of scope** | Redeem again. The history keeps both rows. |

## 5. Authorization

| action | who | bucket |
|---|---|---|
| create, edit, activate, pause, expire a promotion | **owner or manager** | **Supported now** |
| redeem a code | **any staff with `MAKE_REDEMPTIONS`, cashiers included** | **Supported now** |
| void a redemption | **owner or manager** | **Supported now** |
| read the promotion list and counts | **owner or manager** | **Supported now** |
| a cashier seeing which promotions exist | **Out of scope** | A cashier types a code a customer presents. A list of live codes on a till screen is a list of codes to hand out. |

## 6. Database integrity

| guarantee | bucket | how |
|---|---|---|
| The raw code is never stored | **Supported now** | `sha256(salt ‖ businessId ‖ normalised code)`, with a **random 32-byte salt per promotion**. |
| Precomputation is useless against a stolen database | **Supported now** | The salt is why. A coupon code is short and human-typed — a plain unsalted digest of `AUTUMN10` is a dictionary lookup. A keyed HMAC would be stronger still and needs a secret this phase may not add, so the salt is the honest ceiling here, and it is stated rather than glossed. |
| Lookup stays tenant-scoped | **Supported now** | Candidate promotions are read for the caller's business only, then compared by digest. Bounded by a promotion cap per business. |
| Business, promotion, card and profile must agree | **Supported now** | Trigger, `BEFORE INSERT`. Foreign keys check that ids exist; nothing in a foreign key checks that they agree. |
| Only an `ACTIVE` promotion may be redeemed | **Supported now** | Trigger. |
| Limits cannot be exceeded | **Supported now** | Row lock in the service, re-counted by the trigger at insert. |
| A `VOIDED` row names one existing `REDEEMED` row, in the same business, repeating its fields | **Supported now** | Trigger, plus a partial unique index: one void per redemption. |
| Redemptions are append-only | **Supported now** | Trigger refuses `UPDATE`, `DELETE`, `TRUNCATE`; runtime role holds `SELECT`/`INSERT` only. |
| Promotions are no-delete, with a constrained `UPDATE` | **Supported now, and justified** | A lifecycle is a state change, so `UPDATE` is unavoidable. It is constrained by trigger to a legal transition plus the mutable settings, with the code digest, salt, business and creation facts frozen. `DELETE` and `TRUNCATE` are refused. |

## 7. Explicitly out of scope, named so nobody has to ask

Payment of any kind — Stripe, PayPal, a POS provider, a card reader, an invoice, a tax line, a cash
value, a currency. Messaging of any kind — email, SMS, WhatsApp, push, a campaign, a reminder that a
coupon is about to expire. Wallet — no pass carries a coupon, nothing is signed, nothing is pushed.
Public surfaces — no claim page, no share link, no QR flow, no phone lookup; B7 is unchanged. And no
analytics script, anywhere.

Two open decisions are **not** touched: **D15** (referral reward policy) and **D19** (whether a card
is a person or a household). A per-customer limit here counts per `CustomerBusinessProfile`, which is
what the schema already means by "a customer" — that is not an answer to D19 and is not treated as
one.

## 8. Manual / device gate — before any production claim

Nothing below has been done. None of it can be done locally.

- [ ] A real cashier types a real code on a real till device, in Arabic and in English.
- [ ] The refusal wording is understood by somebody who is not a developer, at speed, with a queue.
- [ ] A merchant confirms that "recorded for manual fulfilment" matches what they will actually do.
- [ ] Two tills redeem the last remaining coupon at the same moment on real hardware.
- [ ] Arabic RTL is usable on the actual phone the counter uses, not only at an emulated width.
- [ ] A merchant confirms the consequence of an unrecoverable code before relying on one.

---

## 9. Roadmap, in the order the gates open

| # | work | blocked on |
|---|---|---|
| 1 | Per-branch and per-programme promotions | a merchant decision |
| 2 | Scannable coupons (QR) | its own capability design, like `CardShareLink` |
| 3 | Discount calculation and totals | a payment or POS integration, and a tax decision |
| 4 | Coupon expiry reminders | a messaging provider, and the existing consent contract |
| 5 | Stacking rules | a precedence decision |
| 6 | Auto-generated codes and distribution | who is responsible for handing them out |
