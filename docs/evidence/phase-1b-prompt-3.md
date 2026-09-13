# Evidence — Phase 1b Prompt 3: program lifecycle, locations, internal sources, operational hardening

**Date:** 2026-09-13
**Performed by:** development agent (Claude Opus 5)
**Branch:** `rebuild/phase-0-foundation`
**Baseline:** `7e211e5b6fd9002ddb637c65fe94a31d72b69360` — the deployed staging commit, Zademi visual
acceptance passed.
**Scope:** the three server contracts Prompt 2 recorded as missing, the owner screens over them, and
four deferred findings on the same paths. Local development only — nothing deployed.

---

## 1. Result

**Complete.** Every capability in the prompt is built on a real, authorized, tenant-scoped server
contract, and every one of them is exercised by tests that would fail if it regressed.

| Check | Result |
|---|---|
| `npm run gate` | **PASS — 15/15 steps in 388.3 s** (§7, including one transient failure and what it was) |
| `npm run test:e2e` (run 1) | **34 passed** |
| `npm run test:e2e` (run 2) | **34 passed** |
| Unit | **326 passed, 25 files** |
| Integration | **509 passed, 42 files** |
| `npm audit`, full tree | **0 vulnerabilities** |
| `npm audit --omit=dev --audit-level=high` | **0 vulnerabilities** |
| `npm run db:migrate:status` | **7 applied, none pending** |
| Secret scan over every changed file | **one match, not a secret** (§8) |
| `git diff --check` | **clean** |

**Not claimed:** nothing was deployed, no OCI contact, no Caddy/DNS/TLS/secret/Compose/environment-
template change, and **no device testing was performed**. Staging still runs the baseline commit.

---

## 2. The migration — one, additive, backward-compatible

`prisma/migrations/20260913120000_phase_1b_lifecycle/migration.sql`:

```sql
ALTER TABLE "ProgramVersion" ADD COLUMN IF NOT EXISTS "retiredAt" TIMESTAMP(3);

CREATE UNIQUE INDEX IF NOT EXISTS "ProgramVersion_one_draft_per_template"
  ON "ProgramVersion" ("templateId") WHERE status = 'DRAFT';
```

Two statements. No column is changed or dropped, no row is written, and **nothing is backfilled** —
a version retired before the column existed reads "not recorded" in the UI rather than borrowing its
successor's `activatedAt`, because a fabricated timestamp shown to a merchant is worse than an honest
blank. Both an old build and a new build run against a database in either state.

**Everything else the lifecycle needs already existed**, which is the point of having designed the
constraints first: `ProgramVersionStatus.DRAFT` since Phase 0, `walaaplus_protect_program_version`
freezing mechanics the moment a version leaves DRAFT and refusing to delete one that has,
`reward_tier_protect` doing the same for rewards, and
`ProgramVersion_one_active_per_template` guaranteeing a single live version.

---

## 3. Location lifecycle

`src/server/tenant/locations.ts` — `createLocation`, `updateLocation`, `setLocationActive`, all
behind `EDIT_LOCATIONS`, all tenant-scoped, all under the business row lock.

**There is no delete verb and there will not be one.** A location id is a column on every ledger row
written at that counter, and the ledger is append-only by trigger precisely so history cannot be
rewritten. Closing means *no new value may be written here*; everything already written stays
attributed to it forever. The enforcement is code that already existed —
`requireLocationAccess` filters on `active: true` inside the transaction of every scanner write — so a
closure applies to requests already in flight.

| Refusal | Code | What it protects |
|---|---|---|
| Never the main counter | `LOCATION_IS_MAIN` | Enrolment's welcome bonus and every main-only version write there |
| Never the last active one | `LOCATION_LAST_ACTIVE` | A business with no open counter cannot take a stamp |
| Never the only active counter of a live program | `LOCATION_STRANDS_PROGRAM` | A version pins its counters immutably; if all close it can never be transacted at again |

Reactivation keeps the row, so a branch that reopens keeps its history. Audited as
`location.created` / `.updated` / `.deactivated` / `.reactivated`, carrying the counter's label and
**never its address** — a street is closer to personal data than a label is, and the audit question
is "which counter", not "where".

---

## 4. Program-version lifecycle

`src/server/program/versions.ts`.

```
  v1 ACTIVE  ──create draft──▶  v2 DRAFT  ──edit──▶  v2 DRAFT  ──publish──▶  v2 ACTIVE
      │                             │                                            │
      │                          discard                                  v1 RETIRED
      ▼                                                                          │
  cards keep v1 forever ◀───────────────────────────────────────────────────────┘
```

**There is no `UPDATE` against `CustomerCard` anywhere in the file.** That is the guarantee, stated
as a property of the code rather than as an intention.

- **Publishing is one transaction** under the template's row lock: validate the draft again (a
  counter it names may have closed since the last edit), retire the live version with `retiredAt`,
  activate the draft, audit with the published mechanics in full. Order is forced by the partial
  unique index — retire first, or the second ACTIVE row is rejected.
- **`expectedVersionNumber`** is the draft the merchant reviewed. A publish made stale by someone
  else's publish is refused with `DRAFT_STALE` rather than applied to a draft nobody read.
- **Drafts are safe to edit and discard.** Mechanics and tiers are mutable only while a version is
  DRAFT, enforced by trigger; a discard deletes a DRAFT row, which is the only status the trigger
  permits to be deleted.
- **Stamps and points stay two programs.** A draft inherits the template's `cardType` and is parsed
  by that card type's contract. A stamp draft carrying points mechanics is refused at the route's
  own boundary, before any service runs.
- **Pausing** stops new sign-ups and nothing else. Every issued card keeps earning, redeeming and
  being reversible. `ARCHIVED` is deliberately unreachable from the product (recorded as owner
  decision **D5**).

The version-history screen is what makes immutability legible: each version with when it went live,
when it retired, and **how many cards still run on it**. "Existing cards keep their version" stops
being a sentence in a document and becomes a number a merchant can look at.

---

## 5. Internal named sources

`updateSourceLink` renames a source and corrects its campaign fields. `utmSource` and the welcome
bonus are deliberately **not** editable: both are baked into cards already issued, so editing either
would rewrite the meaning of history — last month's forty cards would be reported as having come
from somewhere they did not.

The built-in counter source is protected from renaming and from deactivation (`SOURCE_PROTECTED`),
because it is what `enrollAtCounter` resolves; switching it off would stop staff issuing a card at
all, from a screen that looks like it is tidying a list.

**B7, re-checked on the screen most likely to undo it:**

- no token is returned by create, update or list — asserted in an integration test that reads the
  real `publicToken` out of the database and checks the rendered page does not contain it;
- no URL, slug, QR or landing page exists for a source, in the product or in the server;
- `GET`/`POST /api/enroll` is still a constant 410 that reads nothing, parses nothing and opens no
  rate-limit window — asserted by counting `AuthRateLimit` rows before and after;
- the static `/join/[token]` route still resolves no token.

---

## 6. The four findings closed

| Finding | Fix | Test |
|---|---|---|
| **M-10** — the counter attribution row was written outside the enrolment transaction, so a crash in that window left a card issued with no record of who issued it | `EnrollCustomerInput.counterActor` threads the actor into `enrollCustomer`, and the `CARD_ISSUED_AT_COUNTER` row is written inside the same transaction, by the same arbiter that decides the welcome bonus | `counter-hardening.test.ts` asserts both rows name the same card and the same member |
| **M-11** — no per-actor limit on counter enrolment or scanner writes | `consumeStaffActionLimit`, keyed on the **membership**: 60 enrolments and 300 writes per hour. Enforced at the route, after the membership is verified and before the service, answered as 429 with `Retry-After` | the full allowance is consumed and the next attempt refused; an exhausted window returns 429 and writes nothing; one member's window does not touch another's |
| **L-15** — dead public-enrolment limiter | `consumeEnrollmentLimit` and its two scopes removed; `env.ts` no longer parses the three `ENROLL_RATE_LIMIT_*` variables | the scopes are asserted absent, and the withdrawn endpoint opens no window |
| **L-17** — `revealCardLink` was not location-scoped | the card's **pinned** version is checked against the member's assignment. Owner/manager unrestricted; a cashier sees a card whose version runs at a counter they are assigned to; a cashier with no assignment sees nothing. Refused as 404, matching the tenant miss | a Main cashier is refused a branch-only card, the branch cashier is allowed, the owner is allowed |

**A change of behaviour worth stating:** a repeat counter enrolment (the customer already had a card)
is now audited as `CARD_LINK_REVEALED` rather than as `CARD_ISSUED_AT_COUNTER` with `created: false`.
It is what actually happens — the response hands staff the existing card's link — and it stops a
staff member's issuance count being inflated by lookups. It also closes a small gap: a repeat
enrolment revealed a card link and wrote no reveal row at all.

### 6.1 The counter screen had to learn something too

A card is served under the version it was **issued** with, not the version its program has since
published. The scanner used to read the counters of the template's live version, which was correct
while a program had one version for its whole life. `CardSearchResult` now carries the card's own
`pinnedLocations`; the scope carries `usableLocations` (open, and assigned to this member); the
picker is the intersection. When that intersection is empty the screen says so and blocks the
buttons, rather than enabling them and letting the server refuse with a customer waiting.

---

## 7. Verification

Every figure below was produced by running the command, on this machine, at this commit.

```
npm run gate                    PASS — 15/15 steps in 388.3 s
  dependency audit (prod, high+)      PASS
  prisma generate / validate          PASS
  lint / typecheck                    PASS
  unit tests                          PASS
  migrate deploy + status (test db)   PASS
  runtime role grants                 PASS
  integration tests                   PASS
  worker build / production build     PASS
  migrate + web image container health PASS

npx playwright test             34 passed, 1.7 min  (run 1)
npx playwright test             34 passed, 1.6 min  (run 2)
npx vitest run --project unit           326 passed, 25 files
npx vitest run --project integration    509 passed, 42 files
npm audit                       0 vulnerabilities
npm audit --omit=dev --audit-level=high 0 vulnerabilities
npm run db:migrate:status       7 applied, none pending
git diff --check                clean
```

**One gate run failed, and it is worth writing down rather than quietly re-running.** The first
attempt failed at `migrate image dependencies` — a Docker build whose `npm ci` took **895 seconds**
and then exited non-zero, against a step that takes about three seconds when the layer cache is
warm. Re-running that step alone passed immediately, and the full gate then passed 15/15. The
signature is a registry stall inside the build, not a change in this branch: no package file was
touched by this prompt (`git status` shows no `package.json`, `package-lock.json` or `Dockerfile`),
and nothing in the failing step reads application source.

### 7.1 Tests added

| File | Covers |
|---|---|
| `tests/integration/location-lifecycle.test.ts` (11) | create with no staff and no programs; duplicate name refused and freed by closing; rename moves no ledger row; main and last-active refusals; stranded-program refusal; close and reopen keeping the id and the audit trail; a scanner award refused at a counter closed after the card was issued, with the earlier row still attributed to it; a new version refused for naming a closed counter; cross-tenant refusal; cashier refusal |
| `tests/integration/version-lifecycle.test.ts` (15) | draft is an exact copy; a second draft is the first; edit and diff; wrong card-type shape refused; discard leaves the live version alone; an existing card keeps its version, its balance and its threshold; a new card gets the new rules; retire and activate share an instant; stale publish refused; two concurrent publishes leave one ACTIVE version; cross-tenant and cashier refusals; pause stops sign-ups only; no destructive status; points tiers survive a version change and the stamp engine still refuses a points card |
| `tests/integration/counter-hardening.test.ts` (12) | M-10, M-11, L-15, L-17 as in §6, plus source CRUD authorization, the protected built-in source, and no token in any response, list or audit row |
| `tests/e2e/lifecycle-ui.spec.ts` (9) | an owner opens, renames and closes a counter and finds no close button on the main one; an Arabic refusal reads in Arabic at phone width; draft → review → publish end to end, with the database checked afterwards; pause in Arabic; a source added with no link, token or QR anywhere on the page; and a 24-frame visual record of the three changed screens |

### 7.2 Screens inspected

The browser suite writes the lifecycle screens into `playwright-results/visual/` at 1440×900 and
390×844, in both locales. **Inspected by eye:** `desktop-en-locations-lifecycle`,
`phone-ar-locations-lifecycle`, `desktop-en-program-versions`, `desktop-en-program-draft-review`,
`desktop-ar-program-draft`. Two defects were found that way and fixed:

- the version table printed "Not set" in the **Retired** column for the LIVE version, which reads as
  missing data rather than as "this version has not been retired". It is now a dash for a live or
  draft version, and "not recorded" only for a retired one with no timestamp;
- a stamp program's review listed every threshold change **twice** — once as "Stamps per reward" and
  once as "Reward: …", because a stamp version's single reward tier is derived from its mechanics.
  Reward diffing now runs for points programs only.

The remaining frames in the record were generated and not individually inspected; that is stated
here rather than implied.

---

## 8. Boundaries, secrets and data hygiene

| Boundary | State |
|---|---|
| Prisma schema | **one additive migration** (§2); no column changed or dropped, no data written |
| Ledger rules, balances, idempotency, reversal logic | **unchanged** — no file under `src/server/ledger`, `src/server/stamp` or `src/server/points` was touched |
| Points/stamps isolation | **unchanged and re-asserted** through a version change |
| Permission model | **unchanged** — no new permission, no change to `ROLE_DEFAULT_PERMISSIONS`. The new verbs reuse `EDIT_LOCATIONS` and `EDIT_TEMPLATES` |
| B7 public-enrolment boundary | **unchanged**, re-asserted in three suites |
| `GET`/`POST /api/enroll` constant 410 | **unchanged**, and now also asserted to open no rate-limit window |
| Card capability tokens | **never returned, never logged, never audited**; the reveal is now narrower than it was |
| Real business or customer data | **untouched**; every fixture creates and destroys its own |
| Docker, Compose, Caddy, DNS, firewall, secrets, environment templates | **untouched** — none appears in `git diff --name-only` |
| `public/brand/*`, `public/icons/*`, `src/app/favicon.ico` | **untouched**; official assets byte-identical |

**Secret scan.** All 42 changed files were scanned for private-key blocks, AWS keys, JWTs, GitHub and
Slack tokens, password/secret/token assignments, PostgreSQL URLs carrying a password, and real Syrian
phone numbers.

**One match, and it is not a secret:** `src/server/env.ts:24` contains
`postgresql://walaaplus:ab/cd@db:5432/loyalty` inside a documentation comment. It is the illustrative
example explaining why a generated password containing `/` breaks URL parsing — `ab/cd` is the fake
password, and the line is unchanged by this prompt (the file appears in the scan only because a
different part of it was edited). Reported rather than suppressed, because a scanner exception that
is not written down is an exception nobody can check.

Phone numbers in screenshots are generated by `uniqueSyrianPhone()` and belong to no one.

**No Prisma access outside the server layer**; no external analytics, tracker or runtime font
request was added.

---

## 9. Known risks and limitations

1. **No device or staging verification.** Nothing here has been opened on a real phone. The browser
   evidence is Chromium at two emulated viewports. The PWA re-install check from Prompt 2 is still
   outstanding.
2. **`.env.example` and `.env.staging.example` still list the three `ENROLL_RATE_LIMIT_*`
   variables.** The code that read them is gone and the schema now ignores them, so they have no
   effect — but this prompt may not change an environment template, so the lines remain. Removing
   them is a one-line change for whoever next has authority over those files.
3. **The per-actor limits are code constants**, not configuration (owner decision **D6**). A merchant
   whose busiest hour approaches 60 enrolments or 300 writes per staff member would need a code
   change. Both numbers are well above a real counter's rate and fail in the direction of "this one
   person waits", never "the café stops serving".
4. **`ARCHIVED` is unreachable** (owner decision **D5**). Pausing covers every case a pilot merchant
   has; what should happen to cards pinned to an archived program's versions is a product decision.
5. **A published version cannot be un-published.** The way back is to publish another version, which
   is why the review screen exists and why publishing asks for confirmation naming the number of
   cards that keep the old rules.
6. **The draft editor replaces the whole mechanics object on every save.** That is deliberate — a
   patch over a JSON column silently restores fields a merchant cleared — but it means two people
   editing one draft overwrite each other. One draft per program and a row lock make the window
   small; a merchant-facing "someone else changed this draft" check is not built.
7. **`src/app/[locale]/card/[shareToken]/` still uses the old `zinc` palette.** It is the customer's
   own card surface, themed per merchant, and it was out of scope here. Every merchant-facing screen
   is now on the semantic tokens; this one is the last file that is not.
8. **The version diff is field-level, not semantic.** It reports that `earnMode` changed from
   `MANUAL` to `SPEND_BLOCK`; it does not explain what that means for a customer's earning rate.

---

## 10. Delivery

- Code and tests committed separately from documentation.
- Only `rebuild/phase-0-foundation` pushed, to the private deploy remote, with `git ls-remote`
  confirmed against the final HEAD.
- **`master` untouched** at `b9ee686`.
- **Nothing deployed.**
