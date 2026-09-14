# Phase 3A, Prompt 3 — staff-assisted promotions and coupon redemption

**Branch** `rebuild/phase-0-foundation` · **baseline** `70704f8` · **local only, nothing deployed**

| | |
|---|---|
| Code, migration and tests | `0f8f00c` |
| Documentation | the commit carrying this file |
| **Deploy this** | the tip of `rebuild/phase-0-foundation` |
| Migration | `20260919120000_promotions_and_redemptions`, the **13th** |
| `master` | untouched at `b9ee686` |

---

## 1. The capability audit came first

`docs/PROMOTIONS-CAPABILITY-MATRIX.md` was written **before** any promotion code existed, and then
used to constrain what got built rather than to describe it afterwards. Three of its rulings are
visible in the diff:

- §3 — *automatically applying a discount* is the defining exclusion. No amount, percentage,
  currency, tax, invoice or total exists anywhere in this feature.
- §5 — a cashier may redeem and may not manage. `requirePromotionManager` is a role check on top of
  a permission check for that reason.
- §7 — the named out-of-scope list is what `/business/promotions` and `/api/scanner/coupon` are
  measured against. No public route, no claim page, no code oracle, no distribution channel.

Two rows are "later provider / business policy" and became decisions **D22** and **D24** rather than
guesses. §6 is the manual gate: nothing here has been checked on a real merchant's counter, and this
report does not claim it has.

---

## 2. What a redemption is, and the sentence it is not

A `PromotionRedemption` row says: *this business, this promotion, this card, this profile, this
member of staff, at this moment.* It carries no amount, percentage, currency, points, stamps or
balance, and a column-name check in `tests/integration/promotion-integrity.test.ts` fails if one is
ever added.

`src/server/promotions/redemption.ts` imports no ledger, points, stamp, campaign, consent, wallet or
referral verb. It cannot alter money, invoices, balances, passes or campaigns because it has no way
to reach any of them, and it sends nothing because no provider exists to send with.

The cashier is told this in as many words:

> Recorded for manual fulfilment: A free espresso. Hand it over now. Nothing was discounted or
> charged. Give the customer what the offer says.

---

## 3. The code: stored as a salted digest, never as a value

```
codeDigest = sha256(codeSalt ‖ businessId ‖ normalizeCode(code))
```

with a fresh 32-byte salt per promotion and NUL separators between the parts.

A coupon code is not a 256-bit capability. It is four to sixty-four characters a human chose and
says out loud — `AUTUMN`, `FREE10` — so an unsalted digest column of them is a rainbow table away
from being plaintext. `CardShareLink` uses a plain SHA-256 and that is right there and wrong here.

**The honest cost.** Per-promotion salts blind the `(businessId, codeDigest)` unique index to
duplicates: two salts produce two digests for the same code. Creating a promotion therefore compares
the candidate against every existing promotion's salt, expired ones included, and redemption walks
the ACTIVE candidates the same way, comparing with `timingSafeEqual`. Both loops are bounded by
`MAX_PROMOTIONS_PER_BUSINESS = 200`, and that bound exists partly for this reason. A keyed HMAC
under one application secret would remove the loop; there is no such secret to key it with today,
and the matrix says so rather than presenting the salt as finished.

The raw code lives in the body of one authenticated request and nowhere else — not in a column, a
path, a query string, a log, an audit row, a response or a rendered page. Audit rows carry two row
ids. `PROMOTION_SELECT` lists its columns literally and omits `codeDigest` and `codeSalt`; there is
no reveal route and nobody, including the owner, reads a code back.

---

## 4. One generic refusal

`redeemCoupon` returns `{ outcome: "RECORDED", … }` or `{ outcome: "NOT_ACCEPTED" }` and nothing
else. `NOT_ACCEPTED` covers malformed, unknown, draft, paused, expired, not yet started, past its
end, globally exhausted, exhausted for this customer, already used, another tenant's, a card that is
not this business's — and a catch-all for anything unforeseen.

Against a six-character secret, a refusal that distinguishes "no such code" from "that code is used
up" is most of the attack. The route is authenticated and bounded by `enforceStaffLimit(ctx,
"write")`, so the realistic threat is a till left running a script rather than the open internet —
which is why the limit is applied here and noted in the code as mattering more here than elsewhere.

**A bad coupon never fails the staff workflow.** The coupon box is its own action against a card
already found; a refusal leaves the card, the stamp controls and the reward button exactly as they
were. Asserted in `tests/e2e/promotions-ui.spec.ts`.

---

## 5. Lifecycle, limits and concurrency

`DRAFT → ACTIVE ↔ PAUSED`, and any of the three → `EXPIRED`, terminal. A promotion is always created
as a draft whatever the caller asks for. An expired promotion cannot be edited at all, because
editing the terms of an offer customers already redeemed against rewrites what those redemptions
meant. The `Expire` button asks twice.

Two optional limits — a global total and a per-customer total, both `> 0` by CHECK constraint.
Redemption takes `SELECT id … FOR UPDATE` on the promotion, re-reads it inside the lock, counts
standing rows (`REDEEMED` with no void), and inserts. The trigger then recounts from the table on
`BEFORE INSERT`, so a future caller that forgets the lock still cannot exceed a limit.

Voided rows count toward no limit: a void here means "that did not happen", so the customer's
entitlement returns. That is the deliberate **opposite** of `ReferralAttribution`, where a void does
not free the card — re-attributing later would be retrospective attribution. Two tables, two
meanings, both written into their migrations.

---

## 6. What the database refuses, with no service in the way

`walaaplus_promotion_guard` — BEFORE INSERT OR UPDATE on `Promotion`

- forces `DRAFT` on insert
- freezes `id`, `businessId`, `codeDigest`, `codeSalt`, `createdByUserId`, `createdAt`
- allows only the transitions that exist
- refuses any change at all to an `EXPIRED` row

`walaaplus_validate_redemption` — BEFORE INSERT on `PromotionRedemption`

- business, promotion, card and profile must all be the same tenant's, and the card must be the
  profile's
- the promotion must be `ACTIVE`
- `now()` must be inside the window
- both limits must still hold, counted from the table
- a `REDEEMED` row may not name a row it voids
- a `VOIDED` row must name a `REDEEMED` row and be a faithful copy of it — same business, promotion,
  card and profile — so a void cannot quietly reassign what it withdraws

Plus `walaaplus_promotion_no_removal` (delete/truncate) and
`walaaplus_reject_redemption_mutation` (update/delete/truncate).

Constraints and indexes carry the rest: positive limits, `startsAt < endsAt`, one name per business,
one digest per business, and `PromotionRedemption_voids_key`, a partial unique index giving each
redemption at most one void.

Every failure raises `check_violation` with a message naming the rule.

### Proven against the database, not the service

`tests/integration/promotion-integrity.test.ts` inserts every invalid shape through `prisma` — the
**restricted runtime client**, exactly as a second service would — and inserts the valid shapes too,
so the rules refuse the wrong rows without refusing the right ones.

**The suite was confirmed to depend on what it claims.** Dropping both
`promotion_redemption_validate` and `promotion_guard` and re-running turned **20 of its 27 tests
red**. The seven that stayed green are the positive controls, the cases a foreign key or a unique
index already covered, and the privilege-level append-only checks — none of which a trigger is
responsible for. Both triggers were then restored by rolling the migration back locally and
reapplying it, and `scripts/db-roles.mjs` was re-run. A test that has never been red is a test
nobody has checked.

---

## 7. Privilege model

Three categories in `scripts/db-roles.mjs`, and this prompt adds to two of them:

| Category | Grants | Now includes |
|---|---|---|
| `APPEND_ONLY_TABLES` | `SELECT`, `INSERT` | + `PromotionRedemption` |
| `NO_DELETE_TABLES` | `SELECT`, `INSERT`, `UPDATE` | + `Promotion` (with `CardShareLink`) |
| everything else | normal read/write | — |

`Promotion` needs `UPDATE` because a lifecycle transition is a real state change a merchant drives;
`promotion_guard` is what keeps that `UPDATE` from becoming a rewrite. `PromotionRedemption` needs
nothing beyond `INSERT`: a void is a second row. Neither has `DELETE` or `TRUNCATE`.

`db-roles` prints, and the run is in the Vitest output:

```
OK role "walaaplus_app" — read/write on 31 public tables,
  append-only on [LoyaltyOperation, ConsentRecord, CampaignRevision, CampaignApproval,
                  CampaignAudienceSnapshot, CampaignAudienceMember, ReferralAttribution,
                  PromotionRedemption],
  no-delete on [CardShareLink, Promotion]
```

---

## 8. Authorization

| | Cashier | Manager | Owner |
|---|---|---|---|
| Redeem at the till | ✅ `MAKE_REDEMPTIONS` | ✅ | ✅ |
| See a card's recorded offers | ❌ | ✅ `VIEW_CUSTOMERS` | ✅ |
| Create, edit, activate, pause, expire | ❌ | ✅ `EDIT_TEMPLATES` | ✅ |
| Void a redemption | ❌ | ✅ | ✅ |
| Read a code back | ❌ | ❌ | ❌ |

A cashier holds `EDIT_CUSTOMERS` because enrolling people is their job, so permission alone is not
the bar. `requirePromotionManager` requires `EDIT_TEMPLATES` **and** `OWNER` or `MANAGER`.
`/business/promotions` returns **404** for a cashier rather than an empty screen, and the sidebar
does not offer it.

`/api/staff/promotions` accepts exactly `create | update | setState | voidRedemption`. There is no
`redeem` and no `reveal`. `/api/scanner/coupon` is POST only and returns 200 with the outcome either
way.

---

## 9. B7 and the public boundary, unchanged

- `src/proxy.ts` — no diff. No public route was added.
- `src/app/api/enroll/route.ts` and the `/join` notice — no diff.
- `public/` — **0 files changed**, verified with `git status --porcelain public/`.
- No public coupon lookup, redemption page, QR claim flow or phone lookup exists.
- `CardShareLink` and `ReferralAttribution` were not weakened, moved or bypassed — neither module
  appears in the diff.

---

## 10. Verification

Everything below was run locally on this machine, against local PostgreSQL in Docker.

| Check | Result |
|---|---|
| `node scripts/gate.mjs` | **PASS 15/15**, 561.9s |
| `npx playwright test` — run 1 | **92 passed**, 2.7m |
| `npx playwright test` — run 2 | **92 passed**, 2.7m |
| `npx vitest run` | **86 files, 1172 tests passed**, 430.9s |
| `npm audit` | 0 vulnerabilities |
| `npm audit --omit=dev` | 0 vulnerabilities |
| `node scripts/db-migrate.mjs status` | 13 migrations, schema up to date |
| `prisma migrate diff` | one pre-existing naming difference — §10a |
| `git diff --check` | clean |
| `git status --porcelain public/` | 0 |
| Secret scan over every changed file | clean |
| Raw-coupon-capability scan | clean — §10b |

New tests this prompt:

| Suite | Tests |
|---|---|
| `tests/unit/promotion-codes.test.ts` | 16 |
| `tests/integration/promotions.test.ts` | 32 |
| `tests/integration/promotion-integrity.test.ts` | 27 |
| `tests/e2e/promotions-ui.spec.ts` | 12 |

### 10a. The one migrate-diff difference, reported rather than buried

`prisma migrate diff --from-migrations --to-schema-datamodel` exits 2 with exactly this:

```
[*] Changed the `ConsentRecord` table
  [*] Renamed the foreign key "ConsentRecord_profile_fkey" to "ConsentRecord_customerBusinessProfileId_fkey"
  [*] Renamed index `ConsentRecord_profile_scope_recordedAt_idx` to `ConsentRecord_customerBusinessProfileId_scope_recordedAt_idx`
```

It is **pre-existing** and nothing to do with this work: it comes from
`20260915120000_consent_and_campaign_drafts`, introduced in `1f87431` (Phase 2 Prompt 2), where two
identifiers were written shorter than Prisma's own spelling. It is cosmetic — same columns, same
constraint, same index, different name — and fixing it means amending a migration that has already
been reviewed, which this prompt was not asked to do. **The promotions migration itself produces no
drift**; it is absent from the output entirely.

### 10b. The raw-coupon-capability scan, in full

Seven passes over the repository:

1. **Schema** — no column anywhere stores a code. `Promotion` has `codeDigest` and `codeSalt` and
   nothing else code-shaped.
2. **Selections** — `PROMOTION_SELECT` enumerates its columns and omits both. No other select in
   `src/` reads either out to a caller.
3. **Audit** — both `recordAudit` calls carry row ids only, with the reason written beside them.
4. **URLs** — neither route reads `searchParams` or `req.url`; both take the code in a POST body.
5. **Logging** — no `console.*` or logger call exists anywhere under `src/server/promotions/`,
   `src/app/api/scanner/coupon/`, `src/app/api/staff/promotions/` or `/business/promotions`.
6. **Client** — `couponInput` is cleared on success and never becomes an `href` or a route.
7. **Rendered HTML** — the browser suite fetches the promotions page and asserts the digest does not
   appear in it.

### 10c. What was NOT tested, and is not claimed

- Nothing was deployed. Not to staging, not to OCI, not to Freebuff. Staging is Freebuff's after
  review.
- No real merchant, no real counter, no real customer, no real coupon.
- No provider, no device, no wallet, no payment system was contacted, because none is involved.
- The concurrency argument is tested by asserting the limit holds across parallel attempts in the
  integration suite; it is **not** a load test and does not claim to be.

---

## 11. Screenshots inspected

All five were opened and read, not merely generated.

| File | What it shows |
|---|---|
| `desktop-en-promotions.png` | the notice, the created promotion with its `Draft` badge, the lifecycle buttons, the create form |
| `phone-ar-promotions.png` | the same screen in Arabic at phone width, right-aligned throughout |
| `phone-en-coupon-till.png` | the till with the manual-fulfilment success message above the fold |
| `phone-ar-coupon-till.png` | the same in Arabic, with the coupon box and the success message RTL |
| `desktop-en-customer-redemptions.png` | the offers panel on a customer record, its void control and its own no-money line |

### What the screenshots found

`desktop-en-promotions.png` came back showing the middle of the create form and nothing else. The
promotion just created, its state badge and the "nothing is calculated" notice were all above the
top of the image. The dashboard shell scrolls `main`, not the document, so `fullPage` captured the
document's idea of the page — a viewport that never moved. A `shot()` helper now rewinds `main`
before every capture. Nothing but reading the image would have caught it.

Arabic RTL is usable at phone width: headings, the disclaimer, the empty state, the field labels and
the till's coupon box all read right to left, with the hamburger and locale switch on the left. The
Latin phone number and the ISO dates stay left-to-right inside the Arabic run via `<bdi>`.

---

## 12. Failures on the way, reported rather than hidden

- **Duplicate codes were not detected.** The `(businessId, codeDigest)` unique index cannot see a
  duplicate when each promotion has its own salt. Fixed with the digest-comparison loop at create
  time; the index stays as a second line of defence against a salt collision.
- **Forbidden-word guards matched the disclaimer that denies the calculation.** The notice has to
  contain "discounted" and "charged" in order to deny them. Fixed with an explicit allowlist in the
  unit test and a `textWithoutDisclaimer()` helper in the browser test, plus a follow-up test
  asserting the exempted strings still say what they are exempt for.
- **`\btotal\b` matched "Total uses".** The money regex was too broad; narrowed, with the reason
  written next to it.
- **Arabic assertion looked for `التسليم`** where the string is `للتسليم` — the ل prefix makes the
  substring start inside the word. Matched on `لتسليم اليدوي` instead.
- **Browser reads hit another test's rows.** The e2e database is shared and never truncated between
  tests; a bare `findFirst` returned a promotion belonging to a different café. Added `scoped()`
  helpers so every read is bounded by `businessId`.
- **A fixture cashier cannot sign in** — `createStaff` gives its user `passwordHash: "x"`. The
  cashier test now demotes the owner's own membership under a live session, which tests the guard
  that actually matters: the tenant context is rebuilt from the database on every request.
- **Prisma drift** from non-canonical constraint names and an undeclared `onDelete`. The unapplied
  migration was rolled back locally, renamed to Prisma's spelling, given `onDelete: Restrict`, and
  reapplied.
- **A stale e2e server** reused an old build and 404'd a new route. Rebuilt and restarted.
- Three lint failures on the way: an unused `type Page` import, a test variable named `module`
  (Next forbids it), and an unused `normalizeCode` import.

---

## 13. Known limitations

1. **Nothing distributes the code.** A merchant tells customers themselves. There is no claim page,
   wallet push, SMS or email — **D22**.
2. **Nothing confirms the item was handed over.** The record says a customer was owed something. The
   handover is a person, and the product does not pretend to observe it.
3. **One shared code per promotion.** Per-customer codes are a different product — **D24**.
4. **Limits are global and per customer only.** No per-branch and no per-day cap — **D26**.
5. **A void returns the entitlement**, which is right for a mistype and wrong after a free coffee
   has already crossed the counter — **D25**.
6. **No retention rule.** Nothing deletes a redemption, and what happens when a customer asks to be
   erased is open — **D23**.
7. **The salt is the ceiling, not the summit.** A keyed HMAC is better and needs an application
   secret this product does not have. The matrix says so.
8. **200 promotions per business**, a code constant, for the reason in §3.
9. **Nothing here has been seen by a real cashier.** The manual gate in the matrix §6 is unchecked.

---

## 14. Open decisions raised by this prompt

**D22** how a customer gets a code · **D23** redemption retention and erasure · **D24** shared code
or per-customer codes · **D25** what a void means once the item is gone · **D26** per-branch and
per-day limits.

None is blocking. Nothing in the code, the schema or the strings presumes an answer to any of them.

---

## 15. Deviations from the brief

One, and it is a reporting matter rather than a change of scope: the brief asked for a "secret scan"
and the repository has no dedicated secret-scanning script, so the scan was run as a pattern sweep
over every changed file (private keys, provider key prefixes, and assigned `secret` / `password` /
`api_key` literals). It came back clean. §10b is the coupon-specific scan the brief also asked for,
run separately and in more depth.

Everything else was done as written.

---

## 16. Which SHA to deploy

The tip of `rebuild/phase-0-foundation` — the documentation commit carrying this file, which
contains `0f8f00c`. The final report names the exact hash; it is not written here because a file
cannot name the commit it is part of.

`master` is untouched at `b9ee686`. Staging is Freebuff's after review, and nothing in this report
claims a staging, device or provider test was performed.
