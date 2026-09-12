# Evidence — Phase 1a Prompt 3: Release Engineering Gate

**Date:** 2026-09-12
**Performed by:** development agent (Claude Opus 5)
**Branch:** `rebuild/phase-0-foundation`
**Scope:** release-engineering review of the completed Phase 1a café pilot. No features added.

---

## 1. Result

**PASS — the Phase 1a engineering gate passes**, at commit
`bdd8731b53b4ed352e82573c79b41a6ebc7cc853`. The audit that establishes it is **§13**, which is the
authoritative result for this document.

This section previously read BLOCKED, and §§2–12 are kept exactly as they were written: they are
the historical record of the first pass, of the correction that blocked it, and of why the block
was a decision rather than a defect. Reading order is chronological — §§1–11 the first audit, §12
the correction that blocked it, §13 the re-run that closes it.

| | |
|---|---|
| First pass (§§2–11) | Five High findings found and fixed with regression tests; no Critical. Twenty-two Medium and Low recorded in §7 |
| Correction (§12) | §3.1 was reported closed when it was only narrowed: the public enrolment form still distinguished an existing customer from a new one. **BLOCKED** |
| Owner decision B7 | Option 3, authorized 2026-09-12: public self-service enrolment withdrawn; cards issued by staff at the counter. Implementation evidence: [phase-1a-b7-option-3.md](phase-1a-b7-option-3.md) |
| **Re-run (§13)** | **The oracle is closed structurally. No Critical or High finding. Every check green on the exact deployed commit. PASS** |

**Final result table — §13's run, not the first pass's:**

| Check | Result |
|---|---|
| `npm run gate` | **PASS 15/15 in 285.9 s** |
| `npm run test:e2e` | **12 passed (38.2 s)** |
| unit / integration | **276** / **389** (665 total, 53 files) |
| `npm audit` full tree | **0 vulnerabilities** |
| `npm audit --omit=dev --audit-level=high` | **0 vulnerabilities** |
| Migration status | **5 applied, none pending** |
| Secret scan | **clean** (§13.7) |
| `git diff --check` | **clean** |
| CI on the exact commit `bdd8731` | **gate success, e2e success** (§13.8) |
| Owner manual regression on staging | **7 of 7 passed** (§13.9) |
| **Enrolment-existence oracle** | **CLOSED — §13.2** |

**The first pass's own numbers, kept for the record:** gate PASS 15/15 in 281.9 s, e2e 9 passed,
unit 276 / integration 388, both audits clean, `git diff --check` clean, CI §8.

**Precondition met.** Prompt 2's manual-gate closure is present on the branch (`c294d81`,
"the owner's real-device results close the Phase 1a Prompt 2 manual gate") and
`docs/evidence/phase-1a-prompt-2.md` ends with its PASS line.

---

## 2. Method

Four independent read-only audits ran in parallel over the delivered loop — authorization and
tenancy, ledger correctness, security and privacy, database and performance — each briefed to cite
`file:line`, to distinguish exploitable gaps from hardening, and to name any property **claimed in
a comment or document but not covered by a test**. That last instruction produced several of the
findings below, and it is the one worth keeping for future gates: this codebase's failure mode is
not missing tests, it is tests that assert a comment's claim without exercising the real path.

Two findings came from my own reading rather than the audits (§3.1 consent, §7 L-11 locale
parity). Every finding was re-verified by hand against the source before being fixed or recorded;
nothing below is taken on an audit's word.

---

## 3. Critical and High findings — all fixed

### 3.1 HIGH — a phone number plus the public link opened someone's card

**`src/app/api/enroll/route.ts`** · fixed in `dd510ff`

The enrolment link is printed on the counter and published as a QR, by design. A repeat enrolment
returned the same *shape* as a first one — which is what the enumeration defence promised and what
the Prompt 2 evidence claimed — but the *value* was the existing card's live `shareToken`.

So anyone holding the link could POST a phone number and receive that person's card page:
**their first name, stamp and reward balances, serial, last activity, and the scanner token they
present at the till**. It also distinguished existing customers from new ones by content, and each
probe wrote a junk profile and burned a welcome bonus. The only brake was the per-link window:
~4,800 targeted checks per café per day.

**Fixed.** The card token is returned only when this call created the card. A repeat gets a token
of the same shape that opens nothing, so the response still carries no signal. A returning customer
who lost their link asks the counter, where staff find them by phone — which is the staff-assisted
restore `PHASE-PLAN.md` schedules for **Phase 1.5**. Self-service restore needs proof the caller
owns the number, and Phase 1a deliberately has no OTP.

**Three existing tests asserted the old behaviour** — that a repeat returns the same token. They
were encoding the vulnerability; they now assert the same shape and check the card in the database.

> **This fix is incomplete, and calling it complete was the error in this document.** It removed
> the *disclosure* — a repeat no longer reveals the existing card, its balances, name, serial,
> scanner token or share token, and §12 keeps a test on that — but it did not remove the
> *existence* signal. The token is followed by the browser, and the card route answers one of them
> and not the other. See **§12**.

### 3.2 HIGH — a valid reversal could be refused permanently

**`src/server/ledger/ledger.ts`** · fixed in `8fe0de8`

`reverseOperationGroup` read the group `ORDER BY "createdAt" ASC` and reversed it. `createdAt`
defaults to `CURRENT_TIMESTAMP`, which in PostgreSQL is the **transaction** timestamp — so every row
of a group carries an identical value, the sort had nothing to order by, and PostgreSQL may return
tied rows in any order, varying with the plan and the table size.

That mattered because `appendOperationGroup` validates the balance after **every row**, not just at
the end. Undo an award that had converted to a reward, get the rows back in an unlucky order, and
the running balance dips below zero mid-group: the reversal is refused with *"dependent value was
already consumed"* — blaming the merchant for a state that does not exist, on a reversal that is
perfectly valid, with no retry that can ever succeed. The two integration tests covering reversal
passed only because small result sets come back in heap order.

**Fixed.** Compensating rows are applied **credits first**. Applying all credits first maximises
every intermediate balance, so if any order avoids a negative intermediate this one does — and if
it still dips, no order would have worked and the refusal is real.

**How the first attempt at this fix failed**, because it is the more useful half of the lesson: I
sorted the *original* rows by their own sign, which puts the row whose negation is a debit first
and fails exactly as before. The unit test passed — it was handed compensating rows directly, so it
tested the right function called the wrong way — and the integration test caught it. The helper now
takes the compensating rows and its comment says why.

### 3.3 HIGH — reconciliation scanned the whole ledger to check one card

**`src/server/ledger/reconciliation.ts`** · fixed in `8fe0de8`

The `ledger` CTE had no predicate. The card filter sat on the preserved side of a `LEFT JOIN`, so
PostgreSQL could not push it into the nullable aggregated side: `reconcileCardBalances({ customerCardId })`
cost a full scan and hash-aggregate of **every tenant's** `LoyaltyOperation` rows. That is the
fastest-growing table in the product, this is the only unbounded scan of it, and it is the query
Phase 1.5 schedules nightly.

**Fixed** by bounding the aggregate to the card set under review. The narrowing is by **card
identity, not by `o."businessId"`** — a corruption detector must not filter its input by a column
that could be part of the corruption, so an operation row pointing at a card under review is still
counted whatever its own `businessId` says.

### 3.4 HIGH — registration had no limit an attacker could not pick their way around

**`src/server/security/rate-limit.ts`** · fixed in `8529790`

Every auth window was keyed on something the caller chooses. Per-email is the right shape for "stop
guessing at **this** account" and no shape at all for "stop creating accounts": a fresh email is a
fresh allowance. Where no client address is trusted — the co-hosted staging posture, chosen
deliberately and correctly — registration therefore had **no effective ceiling**. Each attempt also
costs a 12-round bcrypt *before* the transaction opens, on a container capped at 0.35 CPU, so
unlimited registration was also a way to stop the till working.

**Fixed** with a window keyed on a constant, backing the per-email and per-address ones, at 40 per
15 minutes. It can be exhausted on purpose, which pauses new sign-ups for the rest of the window:
for a pilot with a handful of merchants that is a far smaller harm than the one it closes, and it
fails towards "nobody registers" rather than "the café stops serving".

Also fixed a silent skip: `if (identifier)` meant a body with `email: ""` consumed **no window at
all** — the exact silent-degradation pattern the design elsewhere avoids.

**Not closed by this, and recorded as M-6:** sign-in spraying, one password across many
identifiers. At pilot scale the per-identifier window covers what matters — guessing a specific
account's password is still ten attempts per window — and the real fix is restoring a trustworthy
client address, which belongs with the Phase 1.5 security review.

### 3.5 HIGH — consent was recorded without a timestamp or a version

**`src/app/api/enroll/route.ts`, `src/server/customers/consent.ts`** · fixed in `dd510ff`

`PRODUCT-SPEC.md` §6.1 requires **"exact consent text version stored"**. The schema has carried
`consentTextVersion` and `privacyConsentAt` since Phase 0 and the service wrote both when given a
version — and the only screen that collects consent never sent one. So **every real enrolment
stored `NULL` in both fields**, while the integration tests passed, because they supplied a version
by hand.

A `marketingConsent = true` with no timestamp and no version answers neither "when" nor "to what",
which is the entire job of a consent record. It is also **not recoverable after the fact**: you
cannot reconstruct when someone agreed, so every day the pilot ran was a day of consent records
that can never be completed.

**Fixed.** The version is stamped by the **server**, not sent by the page — client plumbing is what
went missing last time, and a value the browser supplies is a value that can be wrong. A unit test
hashes the four consent strings actually shown to customers and fails if the wording moves without
the version moving with it.

---

## 4. What the audits verified as correct

Cited so a later reader can check rather than trust. These are the claims that **held** under
adversarial reading.

**Authorization and tenancy.** Membership is resolved from the database on every request and the
JWT carries only `sub`, so a revocation applies immediately (`tenant/context.ts:37-51`,
`auth/options.ts:75-82`). A caller-supplied `businessId` is always re-verified
(`tenant/scanner-context.ts:35-40`). Cashier creation checks the **role**, not a permission bit, so
granting `EDIT_STAFF` to a manager does not open it (`staff/cashiers.ts:52`, tested). Every lookup
is *filtered* by `businessId` rather than checked afterwards, so a foreign id is "not found", not
"forbidden" (`customers/lookup.ts:85,100,111`). Award, redeem and reverse permissions are enforced
**inside** the ledger transaction (`ledger/actor.ts:59-70,102-109`).

**No caller can name a location.** Guarded at the HTTP boundary on every JSON body and on the query
string (`http.ts:25-39`, applied first in all six mutating routes), and again in the engine
(`stamp/engine.ts:63-69`). The location is always resolved server-side. A test creates a second
`Location` and proves it still receives nothing.

**Tokens.** Three secrets drawn independently at 192 bits (`security/tokens.ts:22-27`). The card
page is keyed on the share token and the scanner on the QR token **plus** `businessId`, and each
refuses the other's token — both directions tested. `CARD_SELECT` deliberately omits `shareToken`,
so scanning a card never hands staff the URL that opens it.

**No Prisma write outside `src/server`.** Confirmed by exhaustive grep, backstopped at the database
by a trigger and by role grants that deny the runtime role `UPDATE`/`DELETE` on `LoyaltyOperation`.
**This was asserted nowhere**; §5 adds the test.

**Idempotency.** Reserve and execute are in the *same* transaction, so no crash can leave a key
reserved forever. Two concurrent first attempts cannot both proceed — the second blocks on the
unique index, then replays. A key reused with a **different** payload raises a conflict and executes
nothing. Proven against real PostgreSQL with N=8 and N=5 concurrency.

**Concurrency.** `SELECT … FOR UPDATE` is taken **first**, before any balance read or limit count,
in both lock paths. Proven with 12 concurrent awards whose exact `balanceAfter` multiset rules out
any lost update.

**Balance projection** is written in the same transaction as the ledger rows, from the same running
numbers, under the card lock; no code outside the ledger and the engine writes a balance column.

**Reversal integrity.** A reversal cannot be reversed; an already-reversed group cannot be reversed
again, checked under the card lock with a partial unique index as the database backstop; two
concurrent reversals of one group produce exactly one winner, proven with N=6.

**Cursor pagination** is a strict total order in both list paths — the operation list uses
`[createdAt desc, id desc]`, which matters because a single award writes up to three rows sharing
`createdAt`. **No N+1** anywhere; the customer page costs three queries regardless of page size.

**Privacy.** No capability token, password or hash reaches an audit row — every `recordAudit` call
site was read. Exactly one `console.*` exists in `src/`. The service worker has **no `fetch`
listener** at all and deletes any stale cache on activate. Camera frames never leave the browser:
decoding is local, the decoded value goes only to the same-origin lookup, and nothing is logged.

**Secret scanning.** `git ls-files` enumerated; no private keys, API keys, JWTs or real connection
strings in any tracked file. The only tracked `.env*` files are the two placeholder-only templates.

---

## 5. Tests added

| File | Tests | Holds |
|---|---|---|
| `tests/unit/reversal-ordering.test.ts` | 6 | Every permutation a database could return keeps the running balance non-negative; a genuinely impossible reversal is still refused |
| `tests/unit/enrollment-consent.test.ts` | 4 | The recorded consent version matches the wording customers actually see, in both locales |
| `tests/unit/server-boundary.test.ts` | 5 | No Prisma write outside `src/server`; exactly one read importer, named; no server actions — plus a self-check that the matcher detects the shapes it claims |
| `tests/unit/message-parity.test.ts` | 5 | Both locales carry the same keys, no empty strings, the same interpolation placeholders, and Arabic that is actually translated |
| `tests/integration/public-enrollment-route.test.ts` | +5 | A repeat cannot reach the existing card; a new customer still gets a working one; consent version and timestamp are recorded; a caller-supplied version is ignored |
| `tests/integration/auth-rate-limit.test.ts` | +3 | A run of unique emails is eventually refused; an empty email still consumes a window; an ordinary pilot rate is not refused |
| `tests/integration/stamp-engine.test.ts` | +1 assertion | Every per-row `balanceAfter` snapshot inside a compensating group is non-negative — what makes the test sensitive to order at all |

Unit tests 256 → **276**; integration 380 → **388**.

---

## 6. Verification commands and results

```
npm run gate
  PASS  dependency audit (prod, high+)             1040 ms
  PASS  prisma generate                            1637 ms
  PASS  lint                                       5751 ms
  PASS  typecheck                                  4905 ms
  PASS  prisma validate                            1438 ms
  PASS  unit tests                                 1710 ms
  PASS  test db up                                  946 ms
  PASS  migrate deploy (test db, migrator role)    5550 ms
  PASS  migrate status (test db)                   5572 ms
  PASS  runtime role grants (test db)               157 ms
  PASS  integration tests                        209112 ms
  PASS  worker build                                182 ms
  PASS  production build                          14500 ms
  PASS  migrate image dependencies                 2964 ms
  PASS  web image container health                26450 ms
  GATE PASSED in 281.9s (15/15 steps)

npm run test:e2e                          9 passed (39.5 s)
npx vitest run                            664 passed, 52 files
npm audit                                 0 vulnerabilities
npm audit --omit=dev --audit-level=high   0 vulnerabilities
git diff --check                          clean
```

**Migration status was verified without production or staging secrets.** The gate applies
`migrate deploy` and then `migrate status` against the disposable test database as the migrator
role, and re-applies the runtime role's grants — `No pending migrations to apply`, and
`db-roles: OK role "walaaplus_app" — read/write on 20 public tables, append-only on
[LoyaltyOperation], no access to [_prisma_migrations] … cannot CREATE in public`. No staging or
production connection string was read at any point.

---

## 7. Medium and Low findings — recorded, not fixed

Owner is the development agent unless stated. "Phase" is where the fix belongs.

| # | Sev | Finding | Rationale for deferring | Phase |
|---|---|---|---|---|
| M-1 | Medium | **Reversal does not re-run conversion.** Reversing an *earlier* group after a later award can leave a card holding ≥ threshold stamps with zero rewards; the customer then sees an empty card while holding a full one, and redeem refuses | **Unreachable through the Phase 1a UI** — the scanner reverses only the group it just created. The correct fix runs `planStampConversion` inside the compensating group, which is a real ledger behaviour change deserving its own concurrency tests. **Phase 1b's arbitrary-reversal picker must not ship before this** | 1b |
| M-2 | Medium | **`reconcileCardBalances` cannot detect a wrong per-row `balanceAfter`** — it compares only the projection against the sum. A group written in a wrong order sums identically but snapshots wrong numbers | The ordering bug that would produce it is fixed (§3.2), and the projection check does catch corruption. A window-function pass needs a deterministic `sequence` column (M-3) | 1b |
| M-3 | Medium | **No `sequence` column on `LoyaltyOperation`.** Rows in a group share `createdAt`, so the group has no true order for history or audit | §3.2 removes the dependence on order. A column needs a migration and is the prerequisite for M-2 | 1b |
| M-4 | Medium | **No index on `CustomerBusinessProfile.customerId`**, so the scanner's phone lookup sequential-scans it | Sub-millisecond at a few thousand profiles. It is a first-class counter path, so it matters before the second merchant cohort | 1b |
| M-5 | Medium | **No `@@index([businessId, id])`** for the customer list's `WHERE businessId ORDER BY id` | Near-optimal with few tenants; degrades to index-scan-plus-sort per page as tenants multiply | 1b |
| M-6 | Medium | **Sign-in spraying is not limited** — one password across many identifiers, since no per-address window opens in co-hosted staging | Per-identifier still limits guessing at a *specific* account to ten per window, which is what matters with a handful of accounts. The real fix restores a trustworthy client address (an edge shared-secret header), which is a Caddy change this prompt may not make | 1.5 |
| M-7 | Medium | **`IdempotencyRecord` grows without bound**; `@@index([createdAt])` exists for a sweep that nothing calls | A few hundred rows a day. The pattern to copy already exists in `pruneExpiredRateLimits` | 1.5 |
| M-8 | Medium | **`prisma migrate dev` could author a migration dropping three hand-written partial unique indexes** (one-active-version, one-default-location, one-reversal-per-operation) | The gate uses `migrate deploy`, so CI is unaffected; the hazard is a developer running `db:migrate:dev`. The reversal index does not need to be partial and can move into the schema | 1b |
| L-1 | Low | **Engine state checks run before the permission check**, so a member lacking `MAKE_REDEMPTIONS` can tell "this card has a reward" from the 409 | Same-tenant only, nothing is written, and **no Phase 1a role lacks the bit** — it becomes live only when 1b's permission editor can mint one | 1b |
| L-2 | Low | **`assertNoLocationInRequest` has a depth cap of 4 and matches only `location`/`locationId`** — `location_id`, `locationIds` are unseen | No Phase 1a service reads any of those spellings; defence-in-depth on a guard that is already redundant with the engine's | 1b |
| L-3 | Low | **`/api/staff/program`'s 409 fallback re-resolves the tenant without the named business** | A multi-membership caller throws and falls through to the original 409, so there is no leak. It reads badly above a response carrying a capability | 1b |
| L-4 | Low | **`listUserBusinesses` does not require an active user**, so a deactivated user's 24 h token still lists business names | Every actual read fails closed through `requireBusinessMembership`; name-only disclosure | 1b |
| L-5 | Low | **A correct denial arrives as a 500.** A cashier opening the customer list gets Next's generic error page; there is no `error.tsx` | No leak, and the program page already shows the right pattern to copy | 1b |
| L-6 | Low | **No explicit CSRF/Origin check** on the five POST routes; protection is NextAuth v4's implicit `SameSite=Lax` | Not currently exploitable. Worth making stated rather than inherited | 1.5 |
| L-7 | Low | **The card scanner token travels in a GET query string**, so it lands in browser history on a shared till and would be captured by proxy access logs | No Caddyfile in this repo enables logging. Note it before anyone turns access logs on | 1b |
| L-8 | Low | **The daily award limit counts awards later reversed**, so a corrected mistake still consumes a slot | Reads as intentional for an anti-abuse limit, but it is neither documented nor tested. Confirm the product decision, then document or change it | 1b |
| L-9 | Low | **`appendOperationGroup` refuses only `DELETED` cards**; paused and expired are enforced one layer up | Every Phase 1a caller goes through the engine. The export is a future footgun | 1b |
| L-10 | Low | **`runIdempotent`'s `P2002` catch is not constraint-specific** | Degrades safely today; a twin could return a stored response instead of a real constraint error | 1b |
| L-11 | Low | **Locale parity was unenforced** | Fixed by test in this prompt; recorded because the files were already in parity and the risk was future drift | — |
| L-12 | Low | **`@@unique([externalProvider, externalEventId])` indexes all-NULL rows** on the highest-volume table | Premature to change at pilot scale; a cheap win if insert latency ever shows | 1b |
| L-13 | Low | **The card detail page looks the same card up three times** | Three index hits; round-trip latency, not load | 1b |
| L-14 | Low | **Membership mutations `UPDATE … WHERE id`** without a tenant column in the write's own predicate | Preceded by a tenant-scoped load, and `businessId` never changes. No path constructible | 1b |

**No Critical or High finding remains open.**

---

## 8. CI evidence on the exact commit

CI runs on the **private** deploy remote `aamerfox/walaaplus-platform` (`isPrivate: true`), on push
to `rebuild/**`. Both workflows use ephemeral fixtures and **no secrets**; neither deploys anything.

`e3e0880` is the commit carrying **every code fix in §3**. The documentation commits that
follow it change only Markdown and cannot affect either workflow; their own runs are green too and
are visible in the same list.

| Workflow | Commit | Conclusion | Run |
|---|---|---|---|
| `gate` | `e3e0880` | **success** | [run 34690832163](https://github.com/aamerfox/walaaplus-platform/actions/runs/34690832163) |
| `e2e` | `e3e0880` | **success** | [run 34690832173](https://github.com/aamerfox/walaaplus-platform/actions/runs/34690832173) |

**One caveat, stated because it bears on how much CI proves.** `gate.yml` sets
`GATE_SKIP_DOCKER: "1"`, so in CI the gate runs 12 of its 15 steps: the disposable-database step
and the **two image checks** (`migrate image dependencies`, `web image container health`) are
skipped. Those two exist precisely because a source tree cannot answer whether an image is
complete — and the migrate-image defect that once broke a real deployment would still not be caught
by CI today. Both ran locally and passed (§6). Making CI run them is recorded as **M-9**, Phase 1b:
the runner has Docker, and the flag needs splitting so the compose step and the image checks can be
skipped independently.

---

## 12. Correction — the enrolment-existence oracle is still open

### 12.1 What this document got wrong

§3.1 reported the enrolment enumeration issue as fixed. It was not. The audit behind it checked
the **API response** — same status, same keys, same token shape — and treated that as the boundary.
It is not the boundary. The boundary is the **complete public browser flow**, and the flow does not
stop at the JSON:

```
POST /api/enroll        → 200 {cardToken}        identical for a new and an existing phone
JoinForm                → router.replace("/<locale>/card/" + cardToken)   unconditional
GET /<locale>/card/…    → the page for a real token, notFound() for the decoy
```

A caller holding the public enrolment link and a phone number submits the form and watches their
own screen. A number that was never enrolled lands on a card; a number that is already a customer
lands on a 404. They need no access to the response body, no timing measurement and no tooling.

**The fix moved the oracle one hop downstream and I reported it as closed.** That is the more
important failure here than the oracle itself: the evidence asserted a property the tests never
exercised end to end, which is precisely the failure mode §2 of this document claims to be
hunting for.

### 12.2 Reproduced, with automated data only

`tests/e2e/enrollment-enumeration.spec.ts` drives the real public form in a browser, twice, and
reads the outcome. Three tests, all passing, all using generated phone numbers:

| Test | Asserts |
|---|---|
| "a repeat enrolment is still distinguishable from a first one — the open defect" | A new number lands on a visible card; the same number submitted again lands on no card. **This asserts the defect**, as a characterization test |
| "the oracle does not fire for a number that was never enrolled" | Two different new numbers both land on a card, so the signal really is "already a customer" and not noise |
| "a repeat still reveals nothing ABOUT the existing card" | The probe gets a different token, and the page contains no share token, no name, no phone and no balance |

The first test **fails the day the oracle is closed**, which is the moment to invert it. A test that
pins a known defect is worth more than a comment, because it cannot be skimmed past.

### 12.3 Why this cannot be fixed inside Phase 1a

Two requirements are in direct conflict:

| | |
|---|---|
| **A** | A phone that has never enrolled must end up holding a **usable card** — public, self-service, "no merchant login anywhere in the path" (`PRODUCT-SPEC.md` §6.1) |
| **B** | A phone that has already enrolled must reveal **nothing**, including whether it has enrolled |

The caller chooses the phone number. Under **A** they receive a live card capability; under **B**
they must not. *"Did I receive a live card?"* is observable by whoever receives it. So A and B are
distinguishable **for any implementation**, unless the system can tell the number's owner from
someone who merely knows the number — which is proof of phone ownership, and nothing else.

This is not an implementation gap that a better redirect, a uniform status code or a reworded 404
closes. Requirement 2 of the correction is right to forbid those: they hide the signal from a
casual reader and leave it intact for anyone who looks.

The alternatives that avoid needing proof were considered and rejected on the merits:

| Alternative | Why not |
|---|---|
| Issue a **second card** for an existing phone, so both paths return a live card | Breaks one-card-per-customer-per-program, the unique index that enforces it, and forks the balance. A worse defect than the one it hides |
| **Never** issue a card self-service; always "ask the counter" | Uniform and secure, and it deletes the public self-service enrolment that Phase 1a delivered and the owner verified on real devices. A product decision, not an engineering one |
| Deliver the card link **to the number** instead of the screen | This *is* proof of ownership, and it needs an SMS provider |
| Rate-limit the probe harder | Reduces volume, removes nothing. Explicitly excluded by requirement 2 |

### 12.4 The decision that is required

Proof of phone ownership needs a channel, and **every channel is unauthorized**, by this project's
own register:

| Decision | Status | Bearing |
|---|---|---|
| **D2** SMS provider for Syria | ⏸ deferred — *"required before automated card delivery, OTP restore or SMS campaigns. Twilio may not serve the market"* | The only realistic channel |
| **D4** WhatsApp Business API | ⏸ deferred | Alternative channel |
| **D3** Email provider | ⬜ open, needed for password reset | Enrolment identity is a phone number, not an email |

`PHASE-1A-IMPLEMENTATION.md` §1 also lists **"OTP restore"** in the *deliberately not* column for
this phase. So the fix is out of authorized scope by two separate, deliberate prior decisions — and
inventing something in its place would be exactly the insecure workaround the correction forbids.

**Three options, for the owner:**

1. **Authorize a verification channel (D2 or D4).** Enrolment sends a link or a code to the number;
   both paths then answer identically — *"if that number can be enrolled, we have sent it a link"* —
   which is the same non-enumerating shape registration already uses. Cost: provider selection,
   money, and Syrian deliverability, which D2 already flags as uncertain.
2. **Accept the residual risk in writing, for the pilot.** The disclosure is bounded to membership
   — *"this number is a customer of this café"* — and the card itself stays protected (§12.2, third
   test). A probe also costs a rate-limit slot and writes a junk profile. This is a legitimate
   choice for a single-café pilot; it must be an explicit, recorded acceptance, not a silence.
3. **Remove self-service issuance.** The form confirms without returning a card and staff hand over
   the link, which is the staff-assisted restore model already scheduled for Phase 1.5. Uniform and
   needs no provider, but it removes a flow that is built, shipped and verified on real devices.

Nothing was implemented in the meantime, deliberately. Option 2 is a decision to record, not code
to write; options 1 and 3 both change the product.

> **Decided 2026-09-12 — the owner chose option 3.** Public self-service enrolment is withdrawn and
> card issuance moved to the authenticated counter, with a staff-assisted restore. No verification
> provider was added; D2 and D4 stay deferred. The implementation and its evidence are in
> [phase-1a-b7-option-3.md](phase-1a-b7-option-3.md).
>
> **At the time this note was added the gate still did not pass**: it had to be re-run against the
> branch as it stood after that change. **That re-run is §13, and it passed** at `bdd8731`.

### 12.5 What was preserved

No behaviour changed in this correction. Verified still in place, with tests:

- **The card capability stays protected.** A repeat reveals no share token, no scanner token, no
  name, no serial and no balance — §12.2's third test, plus the integration tests from §3.1.
- **Consent capture**, with the server-stamped version and timestamp from §3.5.
- **Rate limits** — per link, per address where trusted, and the global registration window.
- **The honeypot**, answered identically to an ordinary failure and still counted.
- **First-time enrolment and card creation**, unchanged: a new customer still gets a working card.
- **The staff-assisted restore model** is unchanged and remains the Phase 1.5 path.

---

## 9. Scope: what this prompt did not do

- **No Phase 1b features.** No points, multi-location, template editing, named links, richer staff
  model, wallets, push, GHL or production release work. The only deletions were prototype pages
  that rendered invented data; the nav entries remain, so the intended shape is still visible.
- **No OCI contact, no deployment, no Caddy, DNS, firewall or secret access.** The M-6 fix was
  deliberately *not* implemented because the right version of it needs a Caddy change this prompt
  may not make.
- **No real customer data** was used anywhere. Every test uses generated phones and emails.
- **`master` is untouched** at `b9ee686`; only `rebuild/phase-0-foundation` was pushed, to the
  private deploy remote.

---

## 10. Manual-device evidence reference

The real-device manual gate for Phase 1a Prompt 2 was performed by the **owner** on physical phones
and confirmed on 2026-09-12, against staging running `c759d78f079b04ae58fa57cc4185d94ab07d5c81`.
The record is `docs/evidence/phase-1a-prompt-2.md` §8 and
`docs/evidence/phase-1a-prompt-2-cohost-config.md` §15: registration and program creation through
the UI, the full loop including a reversal whose reward reappeared on the card, camera scanning on
both iPhone Safari and Huawei Android, permission-denial fallback, installation on both platforms
opening standalone, three cards staying separate, both locales at phone width, and an empty
service-worker Cache Storage.

**This prompt performed no device testing and claims none.** The fixes in §3 have not been
deployed to staging or retested on a phone; staging still runs `c759d78`. Two of them touch paths
the owner exercised — enrolment and reversal — so the next staging update should re-run the loop
once before the pilot continues.

---

## 11. Known limitations

- **The staging deployment is behind this branch.** Everything in §3 is committed and pushed; none
  of it is deployed. That is the owner's step.
- **Phase 1a's pilot gate is a separate question.** `PHASE-PLAN.md` requires one pilot café, real
  daily transactions, an owner-defined minimum scan count and no unreconciled discrepancy. This
  document is the *engineering* gate; nothing here speaks to the pilot gate.
- **§7 is a real backlog, not a formality.** M-1 in particular is a correctness item that Phase 1b
  must fix before it ships an arbitrary-reversal picker.

---

**BLOCKED — PHASE 1A ENGINEERING GATE — PHONE-OWNERSHIP VERIFICATION DECISION REQUIRED**
*(Historical. This was the result from the correction in §12 until the re-run in §13. It superseded
the document's original PASS line; §13 supersedes it in turn.)*

This supersedes the `PASS` line this document originally ended with. Five High findings were
found and fixed and every automated check is green, but §3.1 was reported as closed when it was
only narrowed, and §12 records why closing it is a decision rather than a change.

---

## 13. Re-run — the final Phase 1a engineering gate

**Date:** 2026-09-12
**Commit audited:** `bdd8731b53b4ed352e82573c79b41a6ebc7cc853`, the commit the owner reports
deployed to staging and manually regression-tested.
**Scope:** the complete final Phase 1a implementation — every original Prompt 3 requirement plus
owner decision **B7 option 3**.

**Result: PASS. No Critical or High finding.** Five new Medium and Low findings are recorded in
§13.6 with owner, rationale and phase.

### 13.1 What changed since the first pass, and what did not

The first pass audited `e3e0880`. Everything since is the B7 change and documentation:

```
git diff --name-only e3e0880..HEAD -- src/server/ledger src/server/stamp src/server/security \
  src/server/registration src/server/staff src/server/time src/server/db.ts src/server/env.ts \
  src/server/errors.ts src/server/http.ts src/server/qr.ts src/server/auth prisma public
→ (empty)
```

The stamp engine, the ledger and its reconciliation, idempotency, the security and rate-limit
module, registration, the auth options, the Prisma schema and every PWA asset are **byte-identical**
to the tree the four parallel audits examined. `git diff --shortstat e3e0880..HEAD -- src` is 18
files, 686 insertions, 508 deletions, and all 18 are the enrolment change. So §§3–7 stand as
audited, and this re-run concentrates on the B7 surface, then re-verifies the whole product by
running every suite (§13.7).

### 13.2 Public enrolment is structurally disabled

| Claim | How it is enforced | How it is proven |
|---|---|---|
| `POST /api/enroll` is constant and parameter-independent | `export async function POST(): Promise<NextResponse>` — the handler is **declared with no parameters**, so no body, token or phone number is in scope to branch on. It parses nothing, normalises nothing, opens no rate-limit window and issues no query | `tests/integration/enrollment-withdrawn.test.ts` asserts the arity structurally (`enrollPost.length === 0`) and byte-compares the response for an enrolled number, a new number, a dead token and an empty body |
| `GET /api/enroll` is the same | The same constant `410 ENROLLMENT_MOVED` body | Same test file; `tests/e2e/enrollment-enumeration.spec.ts` repeats it through a browser |
| Every `/join/<token>` is token-independent | `JoinWithdrawnPage()` takes **no `params`**. No source lookup, no template read, no database call of any kind. There is no `generateMetadata` in the segment | The e2e spec loads a real `direct` token and an invented 32-character token and asserts the rendered text is identical |
| It reveals no customer or program data | The page renders three fixed strings from the `Join` namespace | Same spec; the integration suite additionally asserts the owner program API returns no `enrollmentUrl`, no `enrollmentQrSvg` and never the source `publicToken` |
| No public route can create, find, restore or validate a card | The public surface is `/`, `/pricing`, `/auth/*`, `/join/*`, `/card/*`, `/scanner/login`, plus `/api/auth/*`, `/api/enroll` and `/api/health`. None of them writes a card, and none accepts a phone number | Route-by-route review below |

Route-by-route, on the public surface:

- **`/api/enroll`** — constant `410`, no I/O.
- **`/api/health`** — `SELECT 1`, answers `ok` or `degraded` and nothing else.
- **`/api/auth/register`** — creates a *merchant* account, never a card; non-enumerating by
  construction (§3.4 and its tests).
- **`/card/<shareToken>`** and its manifest — these *do* distinguish a real token from an invented
  one, and that is the product working as specified: the link is the capability, it is 192 bits of
  `crypto.randomBytes` (`src/server/security/tokens.ts`), it is addressed by the page token and
  never the scanner token, and it is what the owner's manual check confirmed still opens. It is not
  an enumeration oracle because nothing public maps a phone number to it.
- **`/join/*`** — the static notice above.

`publicEnrollmentUrl` was **deleted**, not left unused: `src/server/program/public-urls.ts` exports
only `publicCardUrl`, so no code path in the repository can construct a public enrolment address.
The `direct` source rows and their tokens still exist — B7 removed the route, not the data — and
`grep` finds the token reaching no client: the only reference outside `src/server` is an existence
check in the program route's 409 branch, which returns the program's name and mechanics and not the
token.

### 13.3 Staff enrolment and restore

| Requirement | Finding |
|---|---|
| Owner/cashier authorization correct | `requireScannerContext` calls `requireUserId`, then `requireBusinessMembership`, which re-reads an **active** membership from the database on every request; then `requirePermission(ctx, EDIT_CUSTOMERS)`. A deactivated membership loses access on the next request (`cashier.test.ts`) |
| Cross-tenant requests fail | The card read in `revealCardLink` is **filtered** by `businessId` rather than checked afterwards, so another tenant's card id is `NotFoundError` — the same answer as a card that does not exist. Naming another business in `businessId` fails in `requireBusinessMembership` with `ForbiddenError`. Both are tested |
| Caller cannot name business, source, template, location, balance or welcome settings | `z.strictObject` with exactly `{ businessId?, phone, firstName?, lastName?, marketingConsent? }`. Unknown keys are **refused**, not ignored, and `readJsonObject` refuses a `location`/`locationId` at any nesting before the schema runs. `businessId` is verified, never trusted. The source token is resolved by `resolveDirectSourceToken(ctx)` from the membership. Five refusal cases are tested individually |
| One customer/business, one card, one welcome bonus | `enrollAtCounter` delegates to the unchanged `enrollCustomer`, whose `INSERT … ON CONFLICT DO NOTHING RETURNING` makes the card insert the sole arbiter of the bonus. Tested for a repeat and for two concurrent enrolments of the same number |
| Consent text, timestamp and version stored | The version is stamped **server-side** from `ENROLLMENT_CONSENT_VERSION`; `privacyConsentAt` is set from the server clock whenever a version is supplied, which the counter always supplies. The two consent strings moved unchanged into a `Consent` namespace and the counter renders exactly those, so the recorded version still describes the words read aloud; `tests/unit/enrollment-consent.test.ts` hashes them and fails if they drift |
| Reveal authorized, tenant-bound and audited without a token, URL, phone or name | `VIEW_CUSTOMERS`, tenant-filtered read, audit row written **before** the link is returned so a failed audit is a failed reveal. `CARD_LINK_REVEALED` carries `metadata: {}` and no `ipAddress`; `CARD_ISSUED_AT_COUNTER` carries `{created, welcomeStampsGranted}`. Tests assert the rows contain neither token, nor URL, nor the substring `http`, nor the phone, nor the name |
| The cashier grant opens only what was intended | `EDIT_CUSTOMERS` is guarded in exactly one place in the repository — `enrollAtCounter`. No UI gates on it (`Permission.` appears in the app tree only for `VIEW_TEMPLATES`/`EDIT_TEMPLATES`), so no navigation changed. The existing boundary tests still hold: a cashier cannot create or change the program, cannot add staff, cannot browse the customer directory, sees operations only for their own location, and reaches no other business |

### 13.4 Existing card, ledger and PWA behaviour

Unchanged by construction (§13.1) and re-verified by running every suite:

- **Existing personal links work.** `getPublicCardView` is keyed on the page token and was not
  touched; the browser suite opens a card by its link after a counter enrolment, and the owner
  confirmed it on a real device (§13.9).
- **Scanner QR / phone / serial lookup, award, conversion, redemption, reversal, idempotency,
  reconciliation, Main-only location and tenant isolation** — 389 integration tests across 33 files,
  including `stamp-engine`, `ledger`, `reversal-race`, `idempotency`, `reconciliation`,
  `daily-limit`, `transaction-group`, `tenant-guard`, `constraints`, `database-protection` and
  `runtime-role`, all green in this run.
- **PWA boundaries.** `public/sw.js` still registers **no `fetch` handler**, so nothing is cached;
  the manifest is still generated per card and still carries only the business and program name.

### 13.5 Counter-enrolment abuse surface, stated plainly

The public enrolment route carried two rate-limit windows. Those windows guarded an anonymous
write; the write behind the counter is not anonymous. What replaces them is authentication, audit
and tenancy — every issuance carries `actorUserId`, and a cashier can only ever act inside their own
business. What does **not** exist is a per-actor limit on how many cards one staff account may
issue (M-11 below). The comparable fraud — a cashier awarding themselves stamps — is the more direct
one, is bounded by the daily award limit, and is equally audited.

### 13.6 New findings from this re-run

None is Critical or High. Numbering continues from §7.

| # | Sev | Finding | Rationale for deferring | Owner | Phase |
|---|---|---|---|---|---|
| M-10 | Medium | **The counter attribution audit row is written outside the enrolment transaction.** `enrollAtCounter` calls `enrollCustomer` (which writes `CARD_ISSUED` inside its own transaction) and then writes `CARD_ISSUED_AT_COUNTER` with the global client. A crash in that window leaves the issuance audited but **unattributed to the staff member** | Issuance itself stays transactionally audited and is reconstructible from `CustomerCard.issuedAt` and `utmSourceLinkId`; only the actor row is at risk, and only on a crash inside a few milliseconds. The fix threads a transaction client through `enrollCustomer`, whose `ON CONFLICT` arbitration deserves its own concurrency tests when it changes | development agent | 1b |
| M-11 | Medium | **No per-actor rate limit on counter enrolment or scanner writes.** One staff account can issue unbounded cards, each granting a welcome bonus | The actor is authenticated, scoped to one tenant, and recorded on every row; the equivalent and more direct abuse (self-awarding stamps) is already bounded by the daily award limit. A per-actor window belongs with the wider staff-abuse work rather than bolted onto one route | development agent | 1b |
| L-15 | Low | **Dead public-enrolment rate-limit code.** `consumeEnrollLimit`, the `enroll.ip`/`enroll.link` scopes and three `ENROLL_RATE_LIMIT_*` environment variables have no caller since B7, and `.env.example` still advertises them — a reader may conclude enrolment is limited when nothing calls the limiter | No behaviour: dead code cannot run. Removing it is a source change, and this gate's whole point is that the audited tree is the deployed tree | development agent | 1b |
| L-16 | Low | **Stale schema comment.** `UtmSourceLink.publicToken` is still annotated "appears in QR/URL"; since B7 it appears in neither | Comment only | development agent | 1b |
| L-17 | Low | **`revealCardLink` is not location-scoped**, only `VIEW_CUSTOMERS`. Phase 1a is Main-only so there is nothing to cross today; when 1b adds locations, a cashier at one branch could reveal a link for a customer served at another | Unreachable in this phase by construction. It belongs with the multi-location work that creates the boundary | development agent | 1b |

**Two earlier findings are now moot rather than open:** the public enrolment honeypot and its
windows (§4) no longer guard anything, which is L-15 above; and L-7 (the scanner token in a GET
query string) is unchanged and still Low — the new card-link reveal deliberately uses `POST` for
exactly that reason.

**No Critical or High finding remains open**, and none was found in this re-run, so no code changed
in this prompt. The tree audited here is the tree the owner deployed and regression-tested.

### 13.7 Commands run, and what they returned

All run locally on this branch at `bdd8731`, on 2026-09-12, against the gate's own Dockerised test
database.

| Command | Result |
|---|---|
| `npm run gate` | **PASS — 15/15 steps in 285.9 s** |
| `npm run test:e2e` | **12 passed (38.2 s)** |
| unit | **276 passed, 20 files** |
| integration | **389 passed, 33 files** |
| `npm audit` (full tree) | **found 0 vulnerabilities** |
| `npm audit --omit=dev --audit-level=high` | **found 0 vulnerabilities** |
| `npm run db:migrate:status` | **5 migrations found, schema up to date, none pending** |
| `git diff --check` | **clean** |

The gate's fifteen steps include the two container checks CI skips — `migrate image dependencies`
and `web image container health` — and both passed here.

**Secret scan.** Tracked files matching `.env`, `secret`, `credential`, `*.pem`, `*.key` or
`id_rsa` are exactly two: `.env.example` and `.env.staging.example`, both **variable names with
empty values**. A pattern search for assigned literals after `password|secret|token|api_key|passwd|
pwd` across `src`, `scripts`, `prisma`, the compose files and the workflows returns nothing, and so
does a search for fallback secrets (`?? "…"` / `|| "…"` on a secret-shaped name) — the Phase 0
hygiene finding H-1 stays closed. `process.env` is read in exactly three places outside
`src/server/env.ts`: the runtime switch in `instrumentation.ts` and `NEXTAUTH_SECRET` in the proxy,
which refuses to serve protected routes when it is missing or shorter than 32 characters. No secret
is logged: the only `console` call in `src` narrows a thrown value to `{name, message}`, and
`errorResponse` returns a generic 500 body for anything that is not a domain error.

**Index and query review.** The B7 change adds two query shapes. `resolveDirectSourceToken` filters
`UtmSourceLink` on `utmSource` and `active` through the relation `template: { businessId, status }`;
`ProgramTemplate` carries `@@index([businessId, status])` and `UtmSourceLink` carries
`@@unique([templateId, name])`, whose prefix serves the `templateId` join, so the path is
index-driven at any scale a pilot reaches. `revealCardLink` reads `CustomerCard` by primary key with
a `businessId` predicate. Neither adds a sequential scan. The index findings from the first pass are
unchanged and still deferred: **M-4** (no index on `CustomerBusinessProfile.customerId`, used by the
scanner's phone lookup), **M-5** (no `@@index([businessId, id])` for the customer list's keyset
page) and **L-12** (`@@unique([externalProvider, externalEventId])` indexing all-NULL rows on the
ledger). Audit-log reads filtered by `action` fall back to the `(businessId, createdAt)` index and
then filter; that is an admin-side read at pilot volume and is not worth an index today.

### 13.8 CI evidence on the exact commit

CI runs on the **private** deploy remote `aamerfox/walaaplus-platform`, on push to `rebuild/**`.
Both workflows use ephemeral fixtures and no secrets, and neither deploys anything.

| Workflow | Commit | Conclusion | Run |
|---|---|---|---|
| `gate` | `bdd8731` | **success** | [run 34694988125](https://github.com/aamerfox/walaaplus-platform/actions/runs/34694988125) |
| `e2e` | `bdd8731` | **success** | [run 34694988173](https://github.com/aamerfox/walaaplus-platform/actions/runs/34694988173) |

This is the **deployed** commit, not an ancestor of it: `git rev-parse HEAD`,
`git ls-remote deploy rebuild/phase-0-foundation` and the two runs' `headSha` all read
`bdd8731b53b4ed352e82573c79b41a6ebc7cc853`.

The §8 caveat still holds and is repeated because it bears on what CI proves: `gate.yml` sets
`GATE_SKIP_DOCKER: "1"`, so CI runs 12 of the 15 steps and skips the disposable-database step and
the two image checks. Those three ran locally and passed (§13.7). Making CI run them stays **M-9**,
Phase 1b.

### 13.9 Owner manual regression on staging

Reported by the owner against staging running `bdd8731`, with **no personal data recorded** — no
names, phone numbers, card links, QR values or screenshots. The agent did not perform, observe or
verify these; they are recorded as the owner's results.

| # | Check | Result |
|---|---|---|
| 1 | Staff searched an unregistered test number and created one card at the counter | pass |
| 2 | The card received its welcome stamp | pass |
| 3 | Searching the same number again returned the same card — no duplicate card, no second welcome bonus | pass |
| 4 | Staff revealed the personal card link, and it opened on another device | pass |
| 5 | Award followed by reversal restored the original balance | pass |
| 6 | `/en/join/test` showed only the public withdrawal notice | pass |
| 7 | The counter-enrolment flow displayed correctly in Arabic RTL | pass |

These close the four manual rows the runbook added for the counter flow (rows 8–11) and repeat the
reversal path that the first pass's §3.2 fix touched. Rows 1–7 of the runbook's device table remain
closed from Prompt 2.

**No code changed in this prompt**, so the tree audited here is the tree that was deployed and the
tree those checks ran against. Had anything needed fixing, this section could not have been used to
support a pass.

### 13.10 What this gate does and does not say

- It is the **engineering** gate. `PHASE-PLAN.md`'s **pilot** gate — one café, real daily
  transactions, an owner-defined minimum scan count, no unreconciled discrepancy — is a separate
  question that nothing here speaks to.
- **Twenty-seven Medium and Low findings** now stand recorded (§7 and §13.6), each with an owner, a
  rationale and a phase. **M-1 in particular blocks Phase 1b's arbitrary-reversal picker.**
- **Public enrolment must not be re-enabled** until proof of phone ownership exists and has been
  independently audited (decision B7).
- No OCI contact, no deployment, no Caddy, DNS, firewall or secret access, and no real customer
  data was used anywhere in this prompt.

---

**PASS — PHASE 1A ENGINEERING GATE PASSED**

Every original Prompt 3 requirement and owner decision B7 option 3, audited at
`bdd8731b53b4ed352e82573c79b41a6ebc7cc853`: the enumeration oracle is closed structurally rather
than hidden, no Critical or High finding remains, every suite and audit is green locally and in CI
on that exact commit, and the owner's manual regression on the same commit passed.
