# Phase 2, Prompt 2 — consent and campaign draft foundation

Baseline `cec2be8fb377d640ef37dae888ff7b6066ba3dc8`. Branch `rebuild/phase-0-foundation`.
Local work only: nothing contacted OCI, staging, Freebuff, Caddy, DNS or any real customer, and no
message of any kind was sent from this build because no code exists in it that could send one.

---

## 1. What the boundary is, and how it is held

The prompt's central constraint was that this build must **not acquire the ability to deliver a
message**. That is easy to promise in prose and easy to lose to a plausible-looking pull request six
weeks later, so it is held in four places rather than stated once:

| where | what it holds |
|---|---|
| `CampaignState` enum | exactly `DRAFT`, `READY`, `ARCHIVED`. No fourth value exists to be set |
| `/api/staff/campaigns` | `setState` lists the three accepted values explicitly, so an unknown state is a 400 rather than a pass-through |
| `tests/integration/consent-and-campaigns.test.ts` | asserts the API refuses `SENT`, `SCHEDULED`, `QUEUED` and `SENDING` **by name** |
| `tests/e2e/campaigns-ui.spec.ts` | asserts no button or link on any campaign screen is named send, schedule, queue or dispatch in either language, **and that none is disabled** |

The disabled-control assertion is the one that matters most. A greyed-out **Send** makes the same
promise a working one does; refusing to ship it is refusing to imply a capability that does not
exist.

There is also a source-level test that no `fetch`, provider SDK, queue client or worker registration
appears anywhere under `src/server/campaigns/` or `src/server/consent/`. Nothing in this prompt
added a dependency: `package.json` is unchanged.

### B7 is untouched

`GET`/`POST /api/enroll` still answer a constant `410`; `/join/<anything>` is still the static
withdrawal notice. No public enrolment, customer lookup, campaign page, unsubscribe route, tracking
pixel, tracking link or campaign API was added. The existing B7 tests were not modified and pass.

---

## 2. Consent assumptions, stated plainly

**The assumption everything rests on: an incomplete record is not a permission.**

`CustomerBusinessProfile` already carried `marketingConsent`, `privacyConsentAt` and
`consentTextVersion`. There is a combination genuinely in the database — ticked, with both others
`NULL` — from every enrolment taken before the consent version was recorded. It cannot say *when*
anybody agreed or *to what wording*.

| enrolment record | derived state | may be contacted |
|---|---|---|
| ticked, dated, versioned | `GRANTED` | yes |
| ticked, no date | `UNKNOWN` / `MISSING_TIMESTAMP` | **no** |
| ticked, no policy version | `UNKNOWN` / `MISSING_POLICY_VERSION` | **no** |
| not ticked | `WITHDRAWN` | no |

`UNKNOWN` is a distinct state rather than a silent false, because a merchant needs to tell "this
person said no" from "we never asked this person properly" — only the second is worth revisiting.
The rule is a pure function (`originStatus`) with its own unit test, so it cannot drift into
treating a gap as a yes.

**No claim of legal compliance is made anywhere.** This models what the product actually recorded.
Whether that meets any given jurisdiction's bar is not asserted by this build, this document, or any
string in the UI.

### What is recorded, and what is never touched

Each `ConsentRecord` row carries: business, customer profile, scope, new state, previous state,
policy version in force, recorded-at, capture context, recording staff member, optional reason.

The enrolment columns on the profile are **never written by this feature**. A staff member recording
a change appends a row; what enrolment said keeps saying what enrolment said, and a staff action can
never manufacture the appearance of a sign-up opt-in. The integration suite asserts the three
profile columns are byte-identical after a recorded change.

`policyVersion` is `null` for a change captured as spoken agreement, because there was no document
in front of the customer to version. Recording `null` is honest; copying the current version across
would fabricate the single most load-bearing field in the row.

A no-op is not recorded. Setting the state to what it already is returns without writing, so the
history does not accumulate rows that represent nothing happening.

### Authorization boundary

| action | permission | notes |
|---|---|---|
| read the consent state and history | `VIEW_CUSTOMERS` | refused for `CASHIER`, whose job is the person at the counter |
| record a change | `EDIT_CUSTOMERS` | explicitly refused for `CASHIER` even if a permission set were widened |
| see audience counts | `VIEW_PUSHES` | plus an unrestricted membership — see §4 |
| create or revise a draft | `EDIT_PUSHES` | |

Every read and write resolves the profile through the caller's own `businessId` first. The
integration suite includes a cross-tenant attempt on each route.

### Retention: decided by not deciding

**Nothing deletes a consent record, and nothing in this build ever will.** That is the design, not an
omission: a consent history that can be edited or pruned is not evidence of anything.

What that leaves open is recorded as **D9** in `docs/DECISIONS-REQUIRED.md` — a retention period, and
what happens to the history when a customer asks to be erased, are decisions with legal weight and
are deliberately not guessed here. **D8** records the related product decision: whether staff go back
and re-ask the customers whose records read `UNKNOWN`, and with what wording.

### Deliberately not built

- **No customer self-service preference route, and no unsubscribe link.** Both are public endpoints
  that take a customer identifier and change something about that customer — the unsolved problem of
  B7 wearing a different hat. Nothing here can prove who is asking.
- **No per-channel preference.** The record says "marketing", not "SMS but not email" (**D10**).
  Splitting it is cheap to add later and impossible to backfill honestly, so it waits for a channel
  to exist.

---

## 3. Placeholder rules

Two placeholders exist: `{{firstName}}` and `{{businessName}}`. The grammar is `{{ name }}` with an
optional space — no property paths, filters, fallbacks, expressions or block helpers.

**The validation that matters is the second regex.** A scanner looking only for *known* names finds
no match in `{{firstName || "friend"}}` and would call that text placeholder-free, which is exactly
how a template language reaches customer data. So every `{{ … }}` in a body must parse as a
well-formed placeholder; anything else is `MALFORMED`, reported with the text that caused it. The
unit test runs nine hostile shapes — logical-or fallback, property path, arithmetic, pipe filter,
block helper, empty, whitespace-only, hyphenated, spaced — and requires each to be refused.

Four names are refused with their **own** reason rather than as unknown: `programName`,
`stampBalance`, `pointBalance`, `rewardName` → `AMBIGUOUS_ACROSS_CARDS`. A customer may hold several
cards, and the product does not guess which one a merchant meant. The editor says so in those words
rather than silently omitting them, because a merchant who cannot see why a value is missing assumes
it is a bug and asks for it again.

**Previews render from constants only.** `renderWithSamples` substitutes fixed sample values in the
draft's own language — `Layla` / `ليلى`, `Your business` / `نشاطك التجاري`. No customer row is read
to draw a preview. The browser test enrols a real customer named `ليلى`, writes `{{firstName}}`, and
asserts the preview shows `Layla` and that `ليلى` is **absent**.

An unknown placeholder is left visible in the preview rather than blanked. Blanking would hide the
mistake behind a plausible-looking result that the save then refuses.

The preview wrapper carries the **draft's** `dir` and `lang`, not the screen's, so an Arabic message
composed on an English interface reads the way its recipients will read it.

---

## 4. Campaign states and audience

```
DRAFT ⇄ READY        READY = "we think the wording is finished". Nothing more.
  ↘      ↙           Refused for a campaign with no content.
  ARCHIVED           Reversible. There is no delete.
```

Archiving sets the state and `archivedAt` in one update so the two cannot disagree. Content is kept
as numbered `CampaignRevision` rows on an append-only table: a merchant can read back what a draft
said three edits ago, and nothing — including this codebase — can change what it said.

**D11** records what is still open: once delivery exists, `READY` becomes the last human checkpoint
before a message reaches customers, and whether it needs a second pair of eyes is the owner's call.

### The audience is three integers

`previewAudience` re-evaluates the saved segment live, counts matches with an aggregate, checks
consent, and returns `matched`, `marketingEligible`, `notEligible` and the segment's name. Profile
ids are read *inside* that function and discarded with the array.

**No name, phone, card, serial, token or id of any recipient** is returned, rendered, stored, audited
or logged. The integration test serialises the whole response and asserts the absence of both
customers' names, profile ids, card ids and share tokens. A separate test asserts the same of every
campaign row and audit row.

Showing both numbers is deliberate: "412 matched, 96 may be contacted" tells a merchant something
true about their own records that neither number tells alone, and the gap is an argument for asking
people properly rather than for sending anyway.

A branch-scoped member cannot preview an audience at all — the same rule that already governs segment
counts. A number narrowed to the viewer's branch would be a different number on every screen.

Segments stay **definitions**. No membership table was added, no customer PII was copied, and a
campaign stores a segment *id*, never a resolved list.

### A segment this build cannot read is never "everybody"

If a stored definition fails to parse, `previewAudience` raises rather than evaluating to an empty
`where`. An empty `where` is the one wrong answer that could later reach an entire customer base.

---

## 5. Migration

One additive migration, `20260915120000_consent_and_campaign_drafts`:

- 5 enums: `ConsentScope`, `ConsentState`, `ConsentCapture`, `CampaignChannel`, `CampaignState`
- 3 tables: `ConsentRecord`, `Campaign`, `CampaignRevision`
- 2 PL/pgSQL trigger functions raising `restrict_violation` on `UPDATE`/`DELETE`/`TRUNCATE`

**Nothing is backfilled, and the migration says why in its own comments.** Writing a `ConsentRecord`
for existing enrolments would require inventing a `recordedAt` for customers whose `privacyConsentAt`
is `NULL` — manufacturing the exact field whose absence is the reason those records are `UNKNOWN`.
The enrolment answer is instead *derived* as the first history entry at read time, marked `isOrigin`,
and shown with "Not recorded" where the date would be.

No column was dropped, renamed or retyped. No existing row was modified. `migrate status` reports the
schema up to date on both the development and the test database.

### Append-only enforced twice

`scripts/db-roles.mjs` now lists `ConsentRecord` and `CampaignRevision` alongside `LoyaltyOperation`,
so the runtime role holds **only `SELECT` and `INSERT`** on them — the services are refused on
privilege *before* any trigger runs. The trigger is the second line, for anyone connecting with more
rights than the app has.

`tests/integration/runtime-role.test.ts` asserts the exact privilege set on both new tables and adds
eight bypass attempts (UPDATE, DELETE, TRUNCATE, disable-triggers on each). `consent-and-campaigns`
asserts both refusals: privilege as the app, trigger as the owner.

The script's own header says a new append-only table belongs in that list in the same commit as its
migration. It now is.

---

## 6. Verification

Every command below was run locally against the local PostgreSQL test database.

| check | result |
|---|---|
| `node scripts/gate.mjs` | **PASS 15/15**, 388.1 s |
| `npx playwright test` (run 1) | **47 passed**, 1.8 m |
| `npx playwright test` (run 2) | **47 passed**, 1.8 m |
| `npx vitest run` | **76 files, 924 tests, all passed**, 331 s |
| `npm audit` | 0 vulnerabilities |
| `npm audit --omit=dev` | 0 vulnerabilities |
| `node scripts/db-migrate.mjs status` | 9 migrations, schema up to date |
| `git diff --check` | clean |
| secret scan | only the `sk_live_...` / `pk_live_...` literal placeholders in the committed `.env.production.example` |

### Two failures on the way, reported rather than hidden

1. **`migrate image dependencies` failed once** with `npm ci --ignore-scripts` exiting non-zero
   inside the Docker build, after 22 s. Re-running the full gate passed the same step in 2.4 s with
   no code change between the runs. This is the same flake class seen in Phase 1b Prompt 3 (registry
   access inside the container) and is **not** a green result being reported as one: the gate
   genuinely failed once, and the passing run is the one quoted above.
2. **`lint` failed once** on a genuinely unused binding in a new test — a customer enrolled to make
   the audience count 2 but never referenced. Fixed by asserting that customer's profile id and
   share token are also absent from the serialised preview, which is what the binding was for.

### What was NOT tested, and is not claimed

No staging deployment, no device testing, no PWA install, no real customer, no provider, no
infrastructure and no network beyond localhost. Nothing was sent to anybody, because nothing in this
build can send.

---

## 7. Screenshots inspected

Generated by `tests/e2e/campaigns-ui.spec.ts` into `playwright-results/visual/`. Each was opened and
read, and the list is exactly what was looked at:

| file | what reading it confirmed |
|---|---|
| `desktop-en-campaigns.png` | Draft-only banner above the fold; a saved draft showing its revision count and "No audience chosen"; the editor below with no send control anywhere |
| `desktop-en-campaign-detail.png` | Audience as counts — "2 customers match this segment", "none have agreed to hear from you", "Counts only. This product never builds or stores a list of who a campaign would reach"; controls are *How many people?*, *Mark as ready*, *Archive* |
| `phone-ar-campaigns.png` | Arabic RTL: heading, banner, empty state and form labels all right-aligned; the hamburger and locale switch on the left; Arabic banner text reads correctly |
| `desktop-en-consent.png` | Identity row showing "Marketing consent — Not known — Not counted as permission" for a ticked-but-undated enrolment |
| `desktop-en-consent-history.png` | Two rows: the recorded change (date, *Agreed*, reason, "Told a staff member", "Test Owner") and the derived origin ("Not recorded", *Not known*, "Sign-up", "—"); the append-only notice; only the opposite action offered |
| `phone-ar-consent.png` | Arabic RTL customer record with "موافقة التسويق — غير موافق — لا تُحتسب موافقة" |
| `phone-ar-consent-history.png` | Arabic RTL consent table and the append-only notice on a phone |

### Three defects the screenshots found

None of these was caught by a failing test; all three came from reading a rendered page.

1. **A success badge on zero contactable customers.** "None have agreed to hear from you" was
   rendered in the green success tone. It is now neutral below one — that number is not an
   achievement.
2. **An unreadable English string.** The remainder line read *"# have declined, or were never asked
   in a way we can date"*, which is not a sentence a merchant can parse. Both locales now say those
   customers declined, or have no clear record of agreeing.
3. **The draft-only banner rendered twice** on the drafts screen — once from the page, once from the
   editor mounted below it. A warning repeated twice on one screen is read once. The editor no longer
   carries its own; the badge beside the save button keeps the reminder near the action.

A fourth observation, fixed in the test harness rather than the product: the dashboard shell scrolls
`main` rather than the document, so Playwright's `fullPage` was capturing whatever the test had last
scrolled to. Screenshots now rewind first, which is why the banner is visible in the evidence at all.

---

## 8. Known limitations

- **The consent table hides two columns on a phone.** "How" and "Recorded by" are `hidden sm:table-cell`,
  matching the existing card-history table on the same screen. On a phone the *actor* is therefore not
  visible. Consistent with the page's convention, but worth revisiting: actor is the field that makes
  the row auditable.
- **`READY` carries no approval semantics** (**D11**).
- **Consent is one scope, `MARKETING`.** The enum has room for more; nothing uses it (**D10**).
- **`{{programName}}` and the balance placeholders stay unavailable** until a draft can be tied to one
  programme. That is a contract decision, not a missing implementation.
- **The built-in direct source still displays as "Direct" in the Arabic UI.** Pre-existing, from the
  Phase 1b sources work, and out of this prompt's scope.
