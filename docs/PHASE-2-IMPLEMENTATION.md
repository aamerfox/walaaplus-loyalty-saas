# Phase 2 — implementation notes

Phase 1b finished the merchant operation: programs, versions, branches, staff, the counter, the
ledger. Phase 2 is about what a merchant does with what that produced — reading their customers,
describing groups of them, and getting numbers they can act on.

**Prompt 1 is the foundation, not the feature.** Segments exist and nothing sends to them; analytics
are honest and narrow. That distinction is maintained deliberately in `docs/BOOMERANGME-PARITY.md`,
which now has a "foundation only" table precisely so a later reader cannot mistake one for the
other.

---

## 1. Customer 360

`src/server/customers/customer-360.ts`, rendered at `/business/customers/[profileId]`.

**A customer is a person, not a card.** The previous screen was scoped to a card, which was the same
thing while a business ran one program and stopped being true the moment it ran two. It was also
broken: balances were read through `readStampMechanics`, which throws for a points version, so
opening a points customer produced an invariant error the page turned into a 404. A merchant running
a points program could not open their own customers, and no test caught it because no test opened
one. Each card is now read through the contract its own card type owns.

What the record holds, and where each part comes from:

| Shown | Source |
|---|---|
| Name, phone, joined, last seen, marketing consent | `CustomerBusinessProfile`, which is per business — the same person at two businesses is two profiles |
| Every card, grouped by program | `CustomerCard`, ordered by issue date |
| Balances | the ledger's projections on the card |
| Threshold, rewards to next, tiers | the card's **pinned** version, through its own contract |
| Version number | `ProgramVersion.versionNumber` — the rules the card was sold under |
| Branches | the pinned version's `availableLocations`, resolved to names |
| Source | `UtmSourceLink.name`. The display name; the token is never selected |
| Activity | `LoyaltyOperation`, newest first, across every card, narrowed to the member's branches |

**What it never holds:** `qrToken`, `shareToken`, any card URL, any source token, and any export.
None of them is selected by any query in the file. Revealing a card link remains the explicit,
audited, branch-scoped staff action from the scanner.

**Pagination.** The directory is keyset-paged on `CustomerBusinessProfile.id` ascending — a total
order over an immutable key, so a customer enrolled while a merchant is on page two cannot shift the
rows behind them. Activity is paged on `(createdAt desc, id desc)` with an `id` cursor, because rows
inside a transaction group share an instant and an offset would skip or repeat.

**No N+1.** The record is four queries regardless of how many cards a customer holds; the directory
is two regardless of page size; activity resolves program and branch names from two small lookups
after the page is read, not from a join per row.

**Search** is trimmed and capped at 80 characters — longer than any name this product stores, since
`firstName` and `lastName` are capped at 80 on write — so a `contains` scan is never a cost the
caller gets to choose. A phone is matched only in canonical form, so partial digits cannot walk the
table.

---

## 2. Saved segments

`src/server/segments/definition.ts` (the contract) and `segments.ts` (the service).

**A segment is a definition, never a list.** Membership is derived on every read from the same cards
and ledger every other screen uses. A stored list would be stale the moment a customer earned a
stamp, and would be a second place personal data lives with its own retention question. There is no
membership table and there will not be one.

Nine allowlisted fields, each provable from data the product already holds — program, card type,
pinned version, the three balances, source name, "served at a branch", joined date, last activity.
Anything else is refused, including a field that merely does not exist yet.

### 2.1 The semantic decision

A segment selects **customers**; most conditions are facts about a **card**. So "program is the
coffee card AND at least 5 stamps" has two readings, and this product means the narrower one:

> the customer has a coffee card **with** five stamps on it

not "has a coffee card, and has some card with five stamps". The naive `AND` of subqueries produces
the second, and it is the one that offers a free coffee to somebody whose five stamps are on a
different programme. It is implemented as one `cards: { some: { AND: [...] } }` and pinned by
`tests/unit/segment-definition.test.ts` and by an integration test that builds the confusing case
for real.

`match: "any"` is the mirror: one card satisfying one card rule, or a profile rule satisfied
directly.

### 2.2 Two rules worth knowing

- **`servedAtLocation` means "has been served there", not "is allowed there".** A card's eligible
  branches live in immutable mechanics JSON and are not a queryable column; what the system can
  prove is where value was written.
- **Dates in a segment are UTC; dates on the dashboard are business-timezone days.** A segment is a
  standing rule with no clock attached — a boundary that moved with the reader's business day would
  make "joined before 1 March" mean two sets on two screens. A dashboard range describes a trading
  period, which is exactly when the merchant's own day is the right one.

### 2.3 Authorization

`VIEW_SEGMENTS` to read, `EDIT_SEGMENTS` to write — both existing permissions, held by an owner and
a manager. Counting additionally requires a membership with **no branch restriction**, and that is a
refusal rather than a narrowing: a count that quietly shrank to the viewer's own branch would show
one number to a manager, another to a branch-scoped colleague, and a later campaign would send to a
third set. A restricted member is told they cannot count, which is something they can act on.

### 2.4 Archived, never deleted

`archivedAt` hides a segment and keeps the row, because a campaign in a later phase will reference
one by id and "who did we send this to" is a question a merchant is entitled to answer.

---

## 3. Analytics

`src/server/analytics/metrics.ts` and `ranges.ts`.

**Finding M-12 is closed.** Every count is now a PostgreSQL aggregate, and every query returns one
row, or one row per branch, or one row per program. It used to fetch the range into Node and count
it there: `groupBy(["transactionGroupId"])` returned one row per counter event and `.length` counted
them; the breakdowns returned one row per (branch, group) pair; `liveRedemptions` fetched every
redemption and every reversal and subtracted the sets. Correct, and it moved tens of thousands of
rows to produce eleven integers over a long range. `COUNT(DISTINCT …)` is why it is raw SQL — Prisma
cannot express a distinct count — and the definitions did not change: the tests that pinned them
were written before this and still pass.

**Date ranges are business-timezone days.** Presets (today, 7, 30, 90) and a bounded custom range
are resolved with `businessDayRange` in `Business.timezone` — the same day `dailyAwardLimit` counts
in. A dashboard counting in UTC would disagree with the till about which day a 01:00 coffee belonged
to. A range longer than `MAX_RANGE_DAYS` is refused rather than clamped, and an unreadable range in
the URL falls back to the default and says so on the screen.

**Nothing is called revenue.** There is no revenue, ROI, lifetime-value or campaign-performance
figure anywhere, because the data to compute one honestly does not exist: `redemptionValueMinor` is
what a reward cost the merchant, and it is labelled as exactly that.

---

## 4. Product wording: a branch is not a cashier

The owner's staging review found the Arabic Locations screen calling a branch **كاشير**, the same
word the Team screen uses for the cashier ROLE. Both screens read "إضافة كاشير" — one adding a
place, one adding a person.

The `Location` entity is now **فرع / branch** in every message that names it, in both locales; the
`MembershipRole.CASHIER` employee keeps **كاشير / cashier**; and customer-facing copy telling a
customer to show their QR to the cashier is about the person and is unchanged. The rule is enforced
by `tests/unit/location-wording.test.ts`, which asserts both halves — a correction that quietly
renamed the job would be its own defect.

---

## 5. Two message defects this prompt found

Both were found by reading a rendered screenshot, and both are now guarded:

- `Customers.costPoints` existed in **neither** locale. `message-parity.test.ts` compares the two
  files with each other, so a key missing from both is in parity and still broken. The new
  `tests/unit/message-usage.test.ts` reads the components, resolves which group each translator
  variable is bound to, and checks every literal key against both files.
- `Customers.cardType.STAMP` / `.POINTS` were missing, and the screen rendered the key names as
  badges. That call is a computed key, which the usage test deliberately does not resolve, so the
  enum-indexed guard in `message-groups.test.ts` gained the group instead.

---

# Prompt 2 — consent, and drafts that cannot be sent

Prompt 1 ended with segments nothing acts on. Prompt 2 writes the thing that would act on them —
and stops one step before it can. That step is the whole design: **the product must be able to say
who may be contacted before it is able to contact anybody**, because the opposite order is how a
loyalty database becomes a list somebody bought.

Nothing in this prompt sends. There is no provider, no credential, no queue, no worker, no
scheduler, no send verb, and no state a draft can reach that means any of those. The
`CampaignState` enum has exactly three values and `tests/integration/consent-and-campaigns.test.ts`
asserts that the API refuses anything outside them by name, so a future `SENT` cannot arrive by
being merely plausible to a JSON body.

---

## 6. Marketing preference as a history, not a field

`src/server/consent/consent.ts`, shown at `/business/customers/[profileId]`.

### The field that was already there, and what it cannot say

`CustomerBusinessProfile` carries three columns from enrolment: `marketingConsent`,
`privacyConsentAt` and `consentTextVersion`. Read as a permission, they have a combination that is
genuinely in the database and genuinely unreadable — `marketingConsent = true` with both others
`NULL`, which is every enrolment taken before the consent version was wired up.

That row cannot say **when** anybody agreed or **to what wording**. Reading it as consent is how a
gap in a schema turns into a message nobody asked for, so it does not read as consent:

| enrolment record | state | may be contacted |
|---|---|---|
| ticked, dated, versioned | `GRANTED` | yes |
| ticked, no date | `UNKNOWN` (`MISSING_TIMESTAMP`) | no |
| ticked, no policy version | `UNKNOWN` (`MISSING_POLICY_VERSION`) | no |
| not ticked | `WITHDRAWN` | no |

`UNKNOWN` is a first-class state rather than a default-to-false, because the two mean different
things to a merchant: one person said no, the other was never properly asked, and only the second is
worth going back and asking again. The rule is pure and lives in `originStatus`, so
`tests/unit/consent-eligibility.test.ts` pins it without a database and it cannot drift quietly.

### Append-only, in the database

`ConsentRecord` is a tenant-scoped table with a PL/pgSQL trigger that raises `restrict_violation` on
`UPDATE`, `DELETE` and `TRUNCATE` — the same mechanism the ledger uses. Each row carries the new
state, the state it replaced, the policy version in force, when it was recorded, how it was
captured, which staff member recorded it, and an optional free-text reason.

**Nothing writes back to the profile.** A staff member recording a change adds a row; the enrolment
columns keep saying exactly what enrolment said. The history the screen shows is the derived
enrolment entry — marked `isOrigin` — followed by every recorded change, and a staff action can
never manufacture the appearance of an opt-in at sign-up.

Two defences, not one. `scripts/db-roles.mjs` now lists `ConsentRecord` and `CampaignRevision`
alongside `LoyaltyOperation`, so the runtime role holds **only** `SELECT` and `INSERT` on them and
the services are refused on privilege before any trigger runs. The trigger is the second line, for
anyone connecting with more rights than the app has; `tests/integration/runtime-role.test.ts`
asserts the privileges, and `consent-and-campaigns.test.ts` asserts both refusals.

### What is deliberately absent

There is **no customer-facing preference route and no unsubscribe link.** Both are public endpoints
that take a customer identifier and change something about that customer, which is the unsolved
problem of B7 wearing a different hat: nothing here can prove who is asking. A staff member records
what a customer told them, and the record says that is what happened — `capturedVia` is
`STAFF_UPDATE`, never `CUSTOMER`.

`CASHIER` cannot record a consent change. Reading a customer needs `VIEW_CUSTOMERS`; recording needs
`EDIT_CUSTOMERS`, and the role that stands at the till has neither by default.

---

## 7. Campaign drafts

`src/server/campaigns/campaigns.ts`, at `/business/campaigns`.

A campaign is a name, an intended channel, a language, an optional audience, and content. Content is
the part that matters: every save writes a **new numbered revision** rather than editing the last
one, on a table with the same append-only trigger. A merchant can read back what a draft said three
edits ago, and nobody — including this codebase — can change what it said.

**Three states, and none of them is operational.**

| state | means |
|---|---|
| `DRAFT` | being written |
| `READY` | "we think this is finished". Nothing more. Refused for a campaign with no content |
| `ARCHIVED` | put away, and reversible. There is no delete |

Archiving sets the state and the timestamp in one update so the two cannot disagree. There is no
hard delete, because a revision history that can be removed is not a history.

**The audience is three integers.** `previewAudience` re-evaluates the saved segment live, counts the
matches with an aggregate, checks consent for those profiles, and returns `matched`,
`marketingEligible` and `notEligible` plus the segment's name. Profile ids are read inside that
function and discarded with the array; no name, phone, card, serial, token or id of any recipient is
returned, rendered, stored or logged. There is no preview of *who*, and no materialised audience — so
a draft can never carry a stale one.

Showing both numbers is deliberate. "412 matched, 96 may be contacted" tells a merchant something
true about their own records that neither number tells alone, and the gap is an argument for asking
people properly rather than for sending anyway.

A branch-scoped staff member cannot preview an audience at all. The same rule already governs segment
counts: a number narrowed to the viewer's branch would be a different number on every screen.

---

## 8. Placeholders: an allowlist, not a template language

`src/server/campaigns/placeholders.ts`.

Two placeholders exist — `{{firstName}}` and `{{businessName}}` — and the grammar is `{{ name }}`
with an optional space, nothing else. No property paths, no filters, no fallbacks, no expressions, no
block helpers.

The validator's important half is the second regex. A scanner that only looked for *known* names
would find no match in `{{firstName || "friend"}}` and call the text placeholder-free, which is
exactly how a template language reaches customer data. So every `{{ … }}` in a body must parse as a
well-formed placeholder, and anything that does not is reported as `MALFORMED` with the text that
caused it.

Four names are refused with their own reason rather than treated as unknown: `programName`,
`stampBalance`, `pointBalance` and `rewardName` are `AMBIGUOUS_ACROSS_CARDS`. A customer may hold
several cards, and the product will not guess which one a merchant meant — the screen says so in
those words. They become available when a draft can be tied to one programme, which is a later
prompt's contract, not a missing feature.

**The preview renders from constants.** `renderWithSamples` substitutes fixed sample values in the
draft's own language (`Layla` / `ليلى`, `Your business` / `نشاطك التجاري`). No customer is read to
draw a preview, and the browser test asserts that a real enrolled customer's name is absent from one
rendered while that customer exists. An unknown placeholder is left visible rather than blanked:
blanking it would hide the mistake behind a plausible-looking preview that the save then refuses.

The preview wrapper carries the **draft's** direction and language, not the screen's, so an Arabic
message composed on an English interface reads the way its recipients will read it.

---

## 9. Saying so on the screen

Every campaign screen carries `Draft only — nothing will be sent. This product has no way to send a
message yet: no provider, no schedule, no queue.` — once per screen, and a badge beside the save
button where a merchant might otherwise forget.

`tests/e2e/campaigns-ui.spec.ts` asserts that **no button or link** on those screens is named
anything like send, schedule, queue or dispatch, in either language, and that none is disabled — a
greyed-out Send promises the same thing a working one does. The assertion is on control names rather
than page prose on purpose: the copy has to be free to say the words in order to explain that the
capability does not exist.

---

## 10. Two defects this prompt's screenshots found

Both were caught by reading a rendered page rather than by a failing test:

- The audience preview labelled **zero contactable customers with a success badge.** "None have
  agreed to hear from you" is not an achievement; the badge is neutral below one.
- The English remainder line read *"# have declined, or were never asked in a way we can date"*,
  which is not a sentence a merchant can parse. Both locales now say that those customers declined,
  or have no clear record of agreeing.

A third, smaller one: the draft-only banner rendered twice on the drafts screen, once from the page
and once from the editor mounted below it. A warning repeated twice on one screen is read once. The
editor no longer carries its own.

---

# Prompt 3 — approval, a frozen audience, and a wall where delivery would go

Prompt 2 ended with a draft that could not be sent and an audience that was three integers on a
screen. Prompt 3 adds the two things that have to exist **before** delivery is even discussed: a
record of a person deciding, and a record of who that decision covered.

It adds no way to deliver either. What it adds instead is a named place where delivery would go, and
that place refuses on its first line.

---

## 11. `READY` became `IN_REVIEW`, and that is the whole of the rename

Prompt 2's `READY` meant "the merchant considers the wording finished" — which is exactly the moment
a campaign is handed over for a decision. So this prompt did not add a parallel `IN_REVIEW` beside
it and leave two labels meaning one thing. The migration rebuilds the enum with an explicit CASE
that maps `READY → IN_REVIEW` and leaves `DRAFT` and `ARCHIVED` alone. Every stored row keeps its
meaning; a campaign a merchant had marked ready is in review afterwards, which is what they meant.

The state model now has five values and **two owners**:

| state | written by | means |
|---|---|---|
| `DRAFT` | `campaigns.ts` | being written; the only state in which content may change |
| `IN_REVIEW` | `campaigns.ts` | submitted for a decision |
| `APPROVED` | **`approvals.ts` only** | an approval row exists for the current revision |
| `WITHDRAWN` | **`approvals.ts` only** | an approval was explicitly taken back |
| `ARCHIVED` | `campaigns.ts` | put away; cannot be approved or edited until restored |

That split is the design, not bookkeeping. `setState` accepts three values and the API route lists
them literally, so **no request can set `APPROVED`**. A product where somebody can set a campaign to
"approved" has a label; this one has a decision, and the label is a consequence of the decision
existing. `tests/integration/campaign-approval.test.ts` asserts both `APPROVED` and `WITHDRAWN` are
refused by `setState` with a 400.

The merchant-driven transitions live in one table, `MERCHANT_TRANSITIONS`, rather than as scattered
`if` statements. `APPROVED` has an empty row: there is nothing a merchant can do to an approved
campaign except withdraw the approval, which is a decision of its own.

---

## 12. An approval is a record of a person

`CampaignApproval` is append-only, by trigger and by grant, like the ledger and the consent history.
One row carries: the campaign, **the exact revision**, the revision number, the decision, the
declared intended channel, the snapshot, who decided, when, and an optional note.

Three of those deserve the argument behind them.

**The exact revision.** Approval never covers "the campaign"; it covers the words somebody actually
read. That is the entire reason `CampaignRevision` was made append-only in Prompt 2, and this is
where the guarantee pays for itself.

**The declared channel.** Recorded at the decision rather than read from the draft afterwards. A
merchant who approves an SMS and later flips the label to WhatsApp has not approved a WhatsApp
message, and a decision row that read the channel back from the draft would quietly claim otherwise.

**The revision number, sent by the client and checked.** It is the concurrency guard. If a colleague
saved an edit while the approval screen was open, the number no longer matches the server's latest
and the approval is refused with a 409 rather than landing on words nobody read.

### Editing approved content

Refusing the edit would be worse than allowing it: a merchant who spots a typo after approval needs
a way to fix it that is not "make a second campaign". So an edit is allowed, and in the same
transaction the campaign drops to `DRAFT` and its approval pointers are cleared.

**The approval row is untouched.** It remains a true statement about revision 3, forever. What
changed is which revision is current. That distinction — history stays, status moves — is the same
one the consent history makes, and it is the reason both are append-only.

The invalidation is audited separately (`campaign.approval_invalidated`), because it happens as a
side effect of something a merchant did for another reason, and a side effect nobody recorded is how
an audit trail develops a hole.

Changing the **audience** of an approved campaign is refused rather than silently invalidated. The
snapshot was taken over that segment; swapping it underneath would leave an approval whose audience
came from a group nobody approved. Withdrawing first makes that a decision somebody takes, with a
row to show for it.

### The approval policy, stated because it was not going to be obvious

**One approver.** `EDIT_PUSHES` — the existing engagement permission, held by an owner and a manager
— plus a membership with **no branch restriction**, because a snapshot is business-wide and a
branch-scoped approver would be signing off on a number they cannot verify.

A mandatory second approver is deliberately not invented. A pilot merchant is one person; requiring
two would mean requiring them to create a second account to approve their own campaign, which is
theatre rather than control. Recorded as **D12** for the moment a business has staff who are not its
owner, and again in **D11** for what `READY`-equivalent sign-off should commit to once delivery
exists.

---

## 13. The audience snapshot

A segment is a live definition: its membership moves as customers earn, spend and enrol. That is
right for a segment and wrong for a decision, because "you approved this for 412 people" has to
still be true next week.

So approving takes an immutable `CampaignAudienceSnapshot` **inside the approving transaction** —
not two reads with a gap between them that a concurrent enrolment can fall into. The header carries
the counts and the segment's name as it was; a rename afterwards does not rewrite the history of a
decision.

### What a snapshot holds, and the one thing it does not

| stored | not stored |
|---|---|
| internal profile reference | phone, name, email |
| the consent state observed at that instant | card id, serial, card URL |
| the consent record that decided it, or null for an enrolment answer | QR token, share token, source token |
| campaign, revision, segment, timestamps, counts | any rendered message |

**Only eligible customers get a row.** The excluded are counted on the header — `unknownCount` and
`withdrawnCount` — and never listed. Somebody who never agreed to be contacted has not agreed to
appear in a marketing artefact either, and no future delivery needs them.

`consentRecordId` is null when the permission came from the enrolment answer itself rather than from
a recorded change. That is a fact worth being able to tell apart later, and inventing a reference to
make the column look tidy would be the same mistake Prompt 2 refused when it declined to backfill a
consent history.

**Retention is not decided here.** Nothing deletes a snapshot, and there is no retention period,
because a period invented by an implementation is a policy nobody agreed to. Recorded as **D13**.

---

## 14. The wall

`src/server/campaigns/delivery.ts` is the only thing in this codebase shaped like a delivery port. It
exists because the step from "an approved campaign with a count of contactable people" to "somebody
writes a loop" is one small step, and the honest way to handle that is to put the step somewhere
visible and make it refuse.

```ts
export const disabledDelivery: CampaignDeliveryPort = {
  async dispatchApprovedSnapshot(): Promise<never> {
    throw new DeliveryDisabledError();
  },
};
```

Note the shape. `snapshotId` is accepted and never used: the function cannot reach a recipient
because it never looks one up, and a reviewer confirms that by reading four lines rather than by
tracing a call graph. `tests/unit/campaign-delivery-boundary.test.ts` spies on the database client
and asserts that refusing touches it zero times.

The port is deliberately narrow — a snapshot id and nothing else. There is no variant taking a
recipient, a phone number or a rendered message, because a port shaped like that is a port somebody
can call with data they assembled themselves.

### `readinessOf`, and the blocker that never clears

Every campaign response carries a `DeliveryReadiness`: the state, the approved revision, the
approved audience size, `deliverable: false`, and a list of blockers that always ends with
`NO_DELIVERY_CHANNEL_EXISTS`. A merchant reads their own blockers first and the state of the product
underneath them.

It also carries `consentMustBeRecheckedAtDispatch: true` — a standing instruction to whatever builds
delivery, in the contract rather than only in a comment, because a comment is not returned by an API.

**An approval is not permission to contact anybody.** A snapshot records who *could* have been
contacted at the instant of a decision; consent moves afterwards. The integration suite proves the
case that matters: a customer withdraws after approval, the snapshot still lists them — because it is
a record of what was true and rewriting it would make it useless as one — and the live consent check
returns nobody. Any delivery must re-read current consent per recipient and treat a snapshot as the
*ceiling* of an audience, never as its authority. The screen says so too.

---

## 15. What the screens say

The campaign detail page states that nothing sends in three separate places: the draft-only banner,
the approval panel (above every control that leads to a decision), and the readiness section, whose
last line is the reason that never clears.

Approving and withdrawing each take **two deliberate steps**. Approval and its snapshot are
append-only, and a later withdrawal adds a row rather than removing one, so a single click that
writes permanent history is a click somebody makes by accident. The confirmation states what is
about to be recorded — which revision, which channel — and says plainly that it still sends nothing.

`tests/e2e/campaign-approval-ui.spec.ts` asserts that no button or link on any campaign screen is
named anything like send, schedule, queue or dispatch in either language, and that **none is
disabled**. It also reads the real tokens, serial and phone out of the database and asserts their
absence from the rendered HTML of an *approved* campaign — which is the moment the product is
holding a list of contactable people for the first time.

---

## 16. What the screenshots found this time

**A localized label sent as a value.** The approval panel received the channel as
`t("channel.PUSH")` and posted the translated string — "App notification" — as `intendedChannel`,
which the server rejected as invalid. The panel now takes the enum and the label as separate props:
one is declared on the decision, the other is shown to the reader.

**A date that read as a different date.** On the Arabic approval screen the snapshot line rendered
`2026-09-13` inside an Arabic sentence, where the bidi algorithm reorders an unisolated left-to-right
run. The date and the segment name are now wrapped in `<bdi>`, and the messages end before the value
rather than interpolating it. On a record of a decision an ambiguous date is not a cosmetic problem.

**A success badge on a number that is not a success** — already fixed in Prompt 2, and the snapshot
section inherited the same rule: the "may be contacted" badge is neutral below one.
