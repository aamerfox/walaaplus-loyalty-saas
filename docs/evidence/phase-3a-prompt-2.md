# Phase 3A, Prompt 2 — staff-assisted referral attribution

Baseline `015b5fcbf69d3a77c386ce573f62e570f2cbcc2f`. Branch `rebuild/phase-0-foundation`.
Local work only: nothing contacted OCI, staging, Freebuff, Caddy, DNS, Docker infrastructure, a real
customer, or any external service. No provider, wallet signing, Apple/Google credential, email, SMS,
WhatsApp, payment, queue, webhook, schedule, public registration or deployment configuration was
added, and the official Zademi assets in `public/brand/` are byte-identical.

---

## 1. What this phase records, and the sentence it is not

One fact: **this newly issued card was enrolled at a counter where a member of staff saw a valid
invitation from that link.**

It is an attribution. It does not award, promise, send, schedule or calculate anything, and the
schema cannot be read as though it did — `ReferralAttribution` has no column for an amount, a
currency, points, stamps, a reward reference, an eligibility flag, an expiry or a campaign. Each
would be a policy nobody decided, written into a schema, and **D15** owns that policy.

Proven rather than asserted: the integration suite records an attribution and then compares all five
of the referrer's balances, the newly enrolled card's three, the ledger and the campaign table
against their values before. Nothing moved. A second test walks the table's own column names and
fails on any that looks like money.

---

## 2. The capability: seen once, discarded

**It reaches the server in exactly one place** — the body of `POST /api/scanner/enroll`, behind a
verified staff session. The scanner strips everything before the `#` **on the device**, so a
capability never enters a path, a query string, an access log, a proxy log or a `Referer` header.

**Then it is forgotten.** Hashed, looked up, and the row id kept. The raw value is not stored, not
returned, not logged and not written to an audit row — and neither is its digest, because a digest in
an audit log is still a way to confirm a guess.

Proven at four layers:

| where | how |
|---|---|
| request URLs | the browser suite records every request made while enrolling and asserts the token is in none of their URLs |
| the database row | the row is serialised and searched for the token, its digest, the referrer's QR/share/serial, the phone and both names |
| the audit row | the same search over `metadata` |
| the response and the rendered page | the same search over the counter's JSON and the till's HTML |

A source-level test asserts that **exactly two route files in the whole application** mention a share
token: the public resolver, which writes nothing, and the counter enrolment. A third would be a new
way for a capability to reach the server, and the phase that adds one has to come and say so.

### One generic refusal

Invalid, revoked, malformed, another business's, the customer's own, and a card that already carries
an attribution all answer `NOT_ACCEPTED`. A member of staff who could tell "revoked" from "never
existed" would be holding a probe, and the referring customer is never named, shown or implied.

An unusable invitation never turns a successful enrolment into an error: the customer is at the till
and has their card, so the invitation is a second sentence in the feedback rather than a failure.
That is also why the route bounds the field but does not shape-check it — a malformed value must not
produce a 400 for the enrolment. The service applies the real shape rule.

---

## 3. Integrity, and what was deliberately not invented

| rule | how |
|---|---|
| one attribution per enrolled card, **ever** | partial unique index on `ATTRIBUTED` rows |
| voiding does **not** free the slot | the withdrawn row is still there; re-attributing afterwards is retrospective attribution |
| only a card this call issued | a customer who already had one was not referred today |
| no direct self-referral | refused when the same profile, or the same underlying customer, is on both sides |

**Not invented**: household matching, reward eligibility, expiry, monetary value, campaign
attribution, retrospective attribution. None has a column, a code path or a placeholder.

Self-referral detection stops exactly where certainty does. Household matching would wrongly refuse
two flatmates, name similarity would refuse two brothers, and shared-device detection would refuse a
phone handed across a counter. **D19** asks whether a card is a person or a household, and an
implementation does not get to answer it.

---

## 4. Append-only, and a void as a second row

`ReferralAttribution` is strictly append-only — the same shape `CampaignApproval` uses. An
`ATTRIBUTED` row is never modified; voiding writes a `VOIDED` row pointing at it.

That differs from `CardShareLink`, which permits one narrow UPDATE, and the difference is the point:
revoking a capability has to change the thing that is looked up, while voiding an attribution changes
only what a reader concludes. Nothing needs to be mutable.

Two layers, as everywhere else: `scripts/db-roles.mjs` lists the table under `APPEND_ONLY_TABLES` so
the runtime role holds only `SELECT` and `INSERT`, and `referral_attribution_append_only` refuses
`UPDATE`, `DELETE` and `TRUNCATE` for anyone with more rights. `tests/integration/runtime-role.test.ts`
asserts the privilege set and adds four bypass attempts.

---

## 5. Authorization

| action | bar | reasoning |
|---|---|---|
| record | `EDIT_CUSTOMERS` — **a cashier may** | it happens at a till, in the request that issues the card, and enrolling a customer is already their job |
| read a card's attribution | `VIEW_CUSTOMERS`, **not a cashier** | reading a record is not serving somebody — the same bar as the consent history |
| void | `EDIT_CUSTOMERS` **and owner or manager** | deciding a record of what happened was wrong is a correction to the business's own history |

Every read and write resolves through the caller's own `businessId` in the `WHERE`. Cross-tenant
attribution, cross-tenant voiding and a cross-tenant invitation are each tested: the first two answer
404, and the third answers the same generic `NOT_ACCEPTED` as an unknown token, revealing nothing
about the other business.

---

## 6. What an owner may see

A card's own record says the customer arrived with an invitation, when, how, and who recorded it. It
says **nothing about the referring side** — not a name, a card, a link id or a count.

The business-wide figure is a **count**. There is no function anywhere that lists attributions, ranks
referrers or counts them per customer, and a test asserts nothing exported from the module is named
like a listing. That report is a list of customers ordered by how many friends they brought, which
belongs to a reward programme that does not exist.

Both screens state, every time, that nothing is awarded. A merchant looking at a record like this
would otherwise reasonably assume it must be worth something.

---

## 7. B7, unchanged

- `GET`/`POST /api/enroll` still answer a constant `410`.
- `/join/<anything>` is still the static withdrawal notice with no form.
- The public `/share` page still has **no form, no input**, still writes nothing, and still enrols
  nobody — asserted by counting cards, customers, attributions and audit rows before and after three
  resolutions.
- No public referral-claim route, no public phone lookup, and no customer account creation from
  `/share`. `/api/referrals`, `/api/referral/claim` and `/en/referral` reveal nothing.

---

## 8. Verification

| check | result |
|---|---|
| `node scripts/gate.mjs` | **PASS 15/15**, 518.5 s |
| `npx playwright test` (run 1) | **80 passed**, 2.4 m |
| `npx playwright test` (run 2) | **80 passed**, 2.4 m |
| `npx vitest run` | **82 files, 1074 tests, all passed**, 378 s |
| `npm audit` | 0 vulnerabilities |
| `npm audit --omit=dev` | 0 vulnerabilities |
| `node scripts/db-migrate.mjs status` | **12 migrations**, schema up to date |
| `prisma migrate diff` (schema ↔ database) | only the two pre-existing `ConsentRecord` name differences |
| `git diff --check` | clean |
| secret scan | only the committed `.env.production.example` placeholders |
| raw-capability scan | see below |
| `public/` | 0 changed files |

Tests added: 23 integration, 10 browser, plus 4 bypass attempts and 1 privilege assertion in the
runtime-role suite, and the wording guard widened to cover both new message groups.

### The raw-capability scan, honestly

A repository-wide search for `/share#<long token>` returns **one** hit:
`tests/e2e/referral-attribution-ui.spec.ts` contains the literal
`https://zademi.example/share#not-a-real-invitation-at-all-xxxx`. That is a deliberately invalid
fixture for the refusal path, not a capability. No real token appears in any migration, fixture,
snapshot, document or committed test output.

### Failures on the way, reported rather than hidden

1. **The gate failed once on lint** — a test variable named `module`, which Next forbids. Renamed;
   the passing run is the one quoted.
2. **A malformed invitation returned a 400 for the whole enrolment.** The route's schema enforced the
   token's length, so a mis-scan would have refused to enrol a customer standing at the till. Caught
   by the integration suite's "malformed" case. The route now bounds the field and the service
   applies the shape rule, answering `NOT_ACCEPTED` like every other refusal.
3. **Two assertions from Prompt 1 had to move.** One required that *no* referral table existed, so
   that the phase adding one had to come and say so — this is that phase, and it now holds the part
   that still matters: the table can record an arrival and can credit nobody. The other expected the
   trigger's message on a `TRUNCATE`; PostgreSQL now refuses it earlier on the foreign key
   `ReferralAttribution` holds, which is the stronger refusal, and the test accepts either.
4. **Two browser tests had the wrong targets.** The phone lookup lives behind its own tab, and a
   reward-word scan over the whole customer page matched the card's own rewards balance — which is
   the product, not a promise. Both now target what the claim is actually about.

### What was NOT tested, and is not claimed

No staging deployment, no real device, no Apple Wallet, no Google Wallet, no signed pass, no
provider, no infrastructure, and no network beyond localhost. No message was sent and no reward was
granted, because no code exists here that could do either. The wallet device gate in
`docs/WALLET-CAPABILITY-MATRIX.md` §6 remains entirely unticked.

---

## 9. Screenshots inspected

| file | what reading it confirmed |
|---|---|
| `phone-en-referral-till.png` | the enrol form with "Invitation (optional)" last, its hint reading "Only if the customer is showing one. Nothing is given for it yet.", and the feedback "Invitation recorded." with no referrer anywhere |
| `phone-ar-referral-till.png` | the same in Arabic RTL on a phone: "دعوة (اختياري)", placeholder "الصق أو امسح رابط الدعوة", hint "لا يُمنح شيء مقابلها بعد", all right-aligned with the phone number left-to-right isolated |
| `desktop-en-referral-record.png` | "HOW THEY ARRIVED", the green "Recorded as arriving with an invitation" badge, "Shown at the counter · Recorded 2026-09-13 · By Test Owner", and both standing notes — "Who sent the invitation is not shown here" and "Nothing is awarded for this" — above the aggregate count |

### What the screenshot found

The aggregate notice ran its heading into its sentence — *"Referral records 1 customer has been
recorded as arriving with an invitation."* — which reads as one garbled line. The heading is now its
own block. Small, and the kind of thing only reading a rendered page catches.

---

## 10. Known limitations

- **A repeat visit can never be attributed.** Only a card the enrolment actually issued may be
  attributed, so somebody who was invited, forgot, and enrolled themselves last month cannot be
  credited afterwards. That is the safe reading; fixing it means deciding what evidence is
  sufficient, which is retrospective attribution with a policy attached (**D21**).
- **Voiding is final for that card.** The slot is never freed, so a mistaken attribution cannot be
  replaced with the right one — only withdrawn. Deliberate, for the same reason.
- **No retention rule.** Nothing deletes an attribution, and the row names two people by internal id,
  so erasing one customer would leave a dangling half (**D20**).
- **The invitation is typed, pasted or scanned into a field**, not captured by the camera. The
  scanner's camera is bound to the card-QR flow, and adding a second capture target to it is a
  change to the scanner contract this phase should not make.
- **Self-referral detection stops at certain identity.** Two people sharing a household are two
  customers here, and will be until **D19** says otherwise.
- **Nothing is rewarded**, which means the feature has no value to a merchant yet beyond knowing a
  number. That is the intended state of this phase, not an oversight.

---

## 11. Open decisions

| # | what |
|---|---|
| **D15** (narrowed) | The reward half: who is credited, with what, when, within what limits, and what happens when an attribution is voided after a reward was given |
| **D19** | Whether a card is a person or a household — which is also what would let self-referral detection go further |
| **D20** (new) | How long an attribution is kept, and what happens when either customer asks to be erased |
| **D21** (new) | Whether a repeat visit can ever be attributed, and on what evidence |
