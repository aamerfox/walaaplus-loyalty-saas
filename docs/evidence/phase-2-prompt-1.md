# Evidence — Phase 2 Prompt 1: CRM, segments, and a trustworthy analytics foundation

**Date:** 2026-09-14
**Performed by:** development agent (Claude Opus 5)
**Branch:** `rebuild/phase-0-foundation`
**Baseline:** `195be047b39c5601fdfbd0949e9417d7a2dad2fd` — Phase 1b Prompt 3, deployed and
owner-reviewed.
**Scope:** the customer record, saved segments, honest analytics, and the Arabic Location wording
the owner found on staging. Local development only — nothing deployed.

---

## 1. Result

| Check | Result |
|---|---|
| `npm run gate` | **PASS — 15/15 steps in 497.8 s** |
| `npm run test:e2e` (run 1) | **41 passed, 3.0 min** |
| `npm run test:e2e` (run 2) | **41 passed, 3.0 min** |
| Unit | **349 passed, 29 files** |
| Integration | **528 passed, 44 files** |
| `npm audit`, full tree | **0 vulnerabilities** |
| `npm audit --omit=dev --audit-level=high` | **0 vulnerabilities** |
| `npm run db:migrate:status` | **8 applied, none pending** |
| Secret scan over all 28 changed files | **clean** |
| `git diff --check` | **clean** |

**Not claimed:** nothing deployed, no OCI or staging contact, no Caddy/DNS/TLS/secret/Compose/
environment-template change, no real customer data, and **no device or PWA re-install testing**.

---

## 2. What was built

Full engineering notes are in `docs/PHASE-2-IMPLEMENTATION.md`. In summary:

- **Customer 360** — `src/server/customers/customer-360.ts` and
  `/business/customers/[profileId]`. One record per person; every card they hold, each read through
  the contract its own card type owns; balances and activity from the ledger; the version each card
  is pinned to; branch context; source display name. Reversals appear as their own rows beside what
  they correct, because that is how they are stored.
- **Saved segments** — `src/server/segments/`, `/business/segments`, `POST /api/staff/segments`. A
  validated, versioned, tenant-scoped DEFINITION over nine allowlisted fields. Counts are derived
  server-side on every read and never stored.
- **Analytics** — every count is now a PostgreSQL aggregate (finding **M-12**, closed); date presets
  and a bounded custom range in the business's own timezone; a per-branch filter.
- **Wording** — the `Location` entity is a **branch / فرع**; the cashier ROLE keeps its name.

---

## 3. The migration

`prisma/migrations/20260914120000_customer_segments/migration.sql` — one additive migration that
creates one table and its two indexes. No column is changed, no row is written, nothing is dropped.
An old build ignores the table entirely, so it is safe to apply before a deploy and safe to leave in
place if one is rolled back.

| Object | Why it is necessary |
|---|---|
| `CustomerSegment` table | Somewhere to keep a saved definition. It holds a RULE, not people: there is no membership table, because a stored list of customers would go stale the moment somebody earned a stamp and would be a second place personal data lives |
| `CustomerSegment_businessId_normalizedName_key` (unique) | "VIP", "vip" and "  VIP " are one name. Enforced in the database rather than by whoever remembers to call the normaliser — two segments a merchant cannot tell apart is a campaign sent to the wrong people later. Tenant-scoped, so two businesses may each have a VIP |
| `CustomerSegment_businessId_archivedAt_idx` | The list screen reads live segments for one business |
| `businessId` FK `ON DELETE RESTRICT` | A business with segments is not silently removable |
| `createdByUserId` FK `ON DELETE SET NULL` | Who wrote a segment is useful history; losing the segment because a staff account was removed would be the wrong trade |

**No other index was added.** The customer directory, the customer record and the metric aggregates
all run on indexes that already existed — `CustomerBusinessProfile_businessId_id_idx`,
`CustomerBusinessProfile_customerId_idx`, `CustomerCard_businessId_issuedAt_idx`,
`LoyaltyOperation_businessId_templateId_createdAt_idx` and
`LoyaltyOperation_reversalOfOperationId_key`, which `NOT EXISTS` uses to decide whether a redemption
was reversed. Adding an index nobody measured a need for is a cost on every write.

---

## 4. Authorization and data-model decisions

| Decision | Why |
|---|---|
| The customer record refuses a **cashier** | `VIEW_CUSTOMERS` lets a cashier serve whoever is at the counter — by QR, phone or serial. Browsing or reading the book is an owner/manager action, which is the rule `listCustomers` already applied and this extends to the record |
| Activity is narrowed to the member's **assigned branches** | Identical to `listCardOperations`. A branch-scoped member reads what happened at their own branch |
| Counting a segment requires **no branch restriction** | A count that shrank to the viewer's branch would be a different number on every screen, and a later campaign would send to a set nobody saw. Refused, not narrowed |
| Segments reuse `VIEW_SEGMENTS` / `EDIT_SEGMENTS` | Both already existed in the `Permission` enum and are held by an owner and a manager. No new permission, no broadened role |
| Every id in a definition is verified against the tenant **on save** | `toProfileWhere` also scopes every clause by `businessId`, so a foreign id would match nothing — but a segment that silently matches nobody is a merchant staring at a zero, and another business's id would still be sitting in this business's stored row |
| No customer export | It needs its own privacy, retention, authorization and audit contract. Recorded in the capability map as Phase 2, not built here |

---

## 5. Metric definitions and timezone behaviour

The definitions are unchanged from Phase 1b and are stated in full at the top of
`src/server/analytics/metrics.ts`. Restated here because a report should not require reading the
code:

| Metric | Exactly |
|---|---|
| transactions | distinct `transactionGroupId` of non-reversal rows. One counter event is one transaction, however many ledger rows it wrote |
| reversals | distinct groups whose rows are `REVERSAL` |
| visits | rows carrying the `countsAsVisit` flag frozen at write time. Never re-derived on read |
| rewardsRedeemed | `REWARD_REDEEMED` rows with no reversal pointing at them |
| rewardValueMinorRedeemed | sum of `redemptionValueMinor` over those rows — **what the rewards cost the merchant**, not revenue |
| unitsAwarded | sum of positive quantities on award kinds, per unit. Stamps and points are reported separately because adding them is meaningless |
| newCustomers | profiles whose `firstSeenAt` is in the range |
| repeatCustomers | distinct profiles that transacted in the range and were first seen before it |
| cardsIssued | cards whose `issuedAt` is in the range |

**Timezone.** The project already had a contract — `dailyAwardLimit` counts per business-timezone day
(PRODUCT-SPEC §5.6), `Business.timezone` holds it, `businessDayRange` implements it — and the
dashboard now uses it. Presets run from local midnight to **now**, not to the end of today. A custom
range is inclusive of both local dates. Over `MAX_RANGE_DAYS` is refused rather than clamped.

**Segment dates are UTC, deliberately, and this is the one place the two differ.** A segment is a
standing rule evaluated at any hour by anyone; a boundary that moved with the reader's business day
would make "joined before 1 March" mean two different sets on two screens. A dashboard range
describes a trading period, which is exactly when the merchant's own day is the right one.

### 5.1 M-12, closed

The old reads were correct and unbounded: `groupBy(["transactionGroupId"])` returned one row per
counter event and counted them in Node; the per-branch and per-program breakdowns returned one row
per (branch, group) pair; `liveRedemptions` fetched every redemption and every reversal of one and
subtracted the sets. Over a 400-day range at a busy branch that is tens of thousands of rows moved
to produce eleven integers.

Every count is now an aggregate, and the query shapes are:

```
headline     1 row   COUNT(DISTINCT …) FILTER (…) × 8, over LoyaltyOperation, WHERE tenant + range
by branch    ≤ branches   GROUP BY "locationId"
by program   ≤ programs   GROUP BY "templateId"
cards        1 row + ≤ programs   COUNT / groupBy on CustomerCard
```

Raw SQL only because Prisma cannot express `COUNT(DISTINCT x)`. Every value is a bound parameter;
an empty allowed-branch list becomes `IN (NULL)`, which matches nothing — the same answer the Prisma
path gave, and the only safe reading of "assigned nowhere". **The outputs did not change:** the ten
metric tests were written before this and pass unaltered.

---

## 6. Segment semantics and limitations

Stated in full in `docs/PHASE-2-IMPLEMENTATION.md` §2. The two that most need writing down:

1. **`match: "all"` requires ONE card to satisfy every card-scoped rule.** "Coffee card AND ≥5
   stamps" means a coffee card with five stamps on it, not "has a coffee card, and has some card
   with five stamps". The second is what a naive `AND` of subqueries produces and it is the reading
   that offers a free coffee to somebody whose stamps are on a different programme. Pinned by a unit
   test on the produced `where` and by an integration test that builds the confusing case for real.
2. **`servedAtLocation` means "has been served there", not "is allowed there".** A card's eligible
   branches live inside immutable mechanics JSON and are not a queryable column; what the system can
   prove is where value was written.

Limitations, stated rather than implied:

- nine fields, and no free-text or operator input. A segment a merchant can describe but the server
  cannot validate would fail on save;
- no nesting: conditions are one flat list joined by one `all`/`any`. Nested groups are a bigger
  editor and a bigger semantic surface, and nothing needs them yet;
- a count is a number, not a list. The preview returns at most 20 people, by name and id, with no
  phone and no card;
- an unreadable stored definition (a future shape, read by an older build) is shown as unreadable
  and **not evaluated**. Treating it as "everybody" is the one wrong answer that could later send a
  campaign to a whole customer base.

---

## 7. Tests added

| File | Covers |
|---|---|
| `tests/unit/segment-definition.test.ts` (9) | every documented field accepted; unknown field, unknown key, unknown operator, unknown card type, bad version all refused; empty, unbounded and backwards ranges refused; `all` produces one `some` with an `AND`; `any` is a union; every nested clause carries the tenant; a date range is inclusive of its last day |
| `tests/unit/analytics-ranges.test.ts` (6) | presets start at LOCAL midnight in a non-UTC zone; 7/30/90 count local days; a custom range runs to the end of its last local day; malformed, backwards and oversized ranges refused rather than clamped |
| `tests/unit/location-wording.test.ts` (3) | no location message names a cashier in either locale; the Arabic entity is a فرع; the cashier ROLE is still a cashier, and the customer card still tells a customer to show their QR to one |
| `tests/unit/message-usage.test.ts` (1) | every literal message key a component asks for exists in both locales |
| `tests/integration/customer-360.test.ts` (9) | balances match the ledger after award, redemption and reversal; an idempotent retry changes nothing; a POINTS card is readable (the regression); every card on one record; a card keeps its pinned version and threshold after a publish; no card token, share token or source token in any output, and no URL; cross-tenant refused; cashier refused; activity narrowed to assigned branches |
| `tests/integration/segments.test.ts` (10) | save and count from live data; the count moves when the data moves; the audit row carries the rule and not the people; unknown fields refused; foreign program/branch refused; tenant-scoped name uniqueness, case- and space-insensitive; archive keeps the row and blocks editing; restore; cross-tenant id refused for every verb; `all` means one card; `any` is a union; the same person at two businesses counts once; a cashier is refused, and a branch-scoped member is refused a COUNT even when granted `VIEW_SEGMENTS` |
| `tests/e2e/crm-ui.spec.ts` (7) | a two-card customer opened from the directory with no token in the rendered HTML; the record in Arabic RTL on a phone; describe → count → save → archive, with the count asserted from the server; the builder in Arabic RTL; range presets and a custom range changing the URL and the header; an unreadable range falling back and saying so; the Arabic Locations screen containing no cashier word in its visible text |

`tests/unit/message-groups.test.ts` gained `Customers.cardType` and `Segments.cardType`;
`tests/e2e/zademi-visual.spec.ts` and `tests/unit/platform-identity.test.ts` gained the new
`segments` navigation destination.

---

## 8. B7, re-asserted

Unchanged, and checked again on the screens most able to undo it:

- `GET`/`POST /api/enroll` remain a constant 410 that reads nothing (`counter-hardening.test.ts`);
- `/join/<anything>` remains the static withdrawal notice with no lookup (`zademi-visual.spec.ts`);
- no public customer search, segment access, referral, campaign or recovery endpoint exists. The
  segment route is `POST /api/staff/segments`, behind a session and a permission;
- **no capability reaches a CRM screen.** The integration test reads the real `qrToken`,
  `shareToken` and `publicToken` out of the database and asserts each is absent from the service
  output; the browser test does the same against the rendered HTML.

---

## 9. Issues found during this prompt

| Issue | Fixed? |
|---|---|
| **The customer detail page 404'd for any points customer.** It read every card through the stamp contract, which throws for a points version | **Fixed.** Each card is read through its own card type's contract, and an integration test opens a points customer |
| **The directory showed one card per person** — `cards[0]`, whichever was oldest — so a customer's points were invisible behind their stamps | **Fixed.** One row per person with a card count and separately totalled stamps, points and rewards, plus a line saying they are never added together |
| **`Customers.costPoints` existed in neither locale.** next-intl rendered the key name and logged a `MISSING_MESSAGE` nothing was watching | **Fixed**, and `message-usage.test.ts` now catches the class |
| **`Customers.cardType.STAMP` / `.POINTS` were missing**, so the card badges rendered the key names. Found by reading a screenshot | **Fixed**, and the enum-indexed guard gained the group |
| **`dateBounds` returned a number where a Date belongs**, hidden by an `as` cast. Found by a test comparing the produced `where` | **Fixed**, and the cast is gone |
| **A Prompt-3 browser test became ambiguous** once "Main branch only" appeared on the Locations screen: Playwright's `hasText` is a case-insensitive substring, so a row filter of "Branch" matched two rows | **Fixed** by renaming the fixture branch to one that does not appear in the product's vocabulary |

---

## 10. Deferred, with an owner and a phase

| Item | Owner | Phase |
|---|---|---|
| Customer export (CSV or otherwise) — needs a privacy, retention, authorization and audit contract | owner decision on retention; development agent to build | 2 |
| Anything that ACTS on a segment: campaigns, push, scheduled sends, birthday and inactivity triggers | development agent | 2 / 1.5 |
| Nested condition groups in a segment | development agent | when a merchant needs one |
| A rollup table for analytics. Not needed: every metric is now a bounded aggregate. If a merchant's range ever gets slow, the measurement comes first | development agent | 2+ |
| Editing a saved segment's definition from the UI. The service and the route support it; the screen offers rename-and-archive only | development agent | 2 |
| Cohort, retention and RFM views | development agent | 2 / 3a |
| `src/app/[locale]/card/[shareToken]/` still uses the old `zinc` palette — the customer's own card surface, out of scope here | development agent | 2 |

---

## 11. Screens inspected

Read by the agent, at the sizes named:

- `desktop-en-customer-360.png` — twice: the first showed `Customers.cardType.STAMP` as a badge, which
  is how that defect was found; the second confirmed the fix;
- `desktop-en-segments.png` — showed a saved segment listing only its field name with no value, which
  is why saved conditions now render their bounds;
- `phone-ar-segments.png` — Arabic RTL, translated throughout;
- `desktop-en-dashboard-range.png` — presets, the custom range, and the header echoing the resolved
  local dates;
- plus a pixel-level crop of the customer record's card badges after the label fix.

`phone-ar-customer-360.png` and `phone-ar-locations-wording.png` were generated by the suite and are
in the record; they were not individually opened, which is stated here rather than implied.

---

## 12. Delivery

- Code and tests committed separately from documentation.
- Only `rebuild/phase-0-foundation` pushed, to the private deploy remote, with `git ls-remote`
  confirmed against the final HEAD.
- **`master` untouched** at `b9ee686`.
- **Nothing deployed.**
