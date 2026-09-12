# Evidence — Phase 1a Prompt 3: Release Engineering Gate

**Date:** 2026-09-12
**Performed by:** development agent (Claude Opus 5)
**Branch:** `rebuild/phase-0-foundation`
**Scope:** release-engineering review of the completed Phase 1a café pilot. No features added.

---

## 1. Result

**PASS.** Four Critical/High findings were found and fixed with regression tests. Sixteen
Medium/Low findings are recorded in §7 with severity, rationale, owner and phase.

| Check | Result |
|---|---|
| `npm run gate` | **PASS 15/15 in 281.9 s** |
| `npm run test:e2e` | **9 passed (39.5 s)** |
| unit / integration | **276** / **388** (664 total, 52 files) |
| `npm audit` full tree | **0 vulnerabilities** |
| `npm audit --omit=dev --audit-level=high` | **0 vulnerabilities** |
| `git diff --check` | clean |
| CI on the exact commit | §8 |

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

**PASS — PHASE 1A ENGINEERING GATE PASSED — READY FOR PHASE 1B PROMPT 1**
