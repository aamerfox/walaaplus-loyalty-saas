# Phase 2, Prompt 3 — campaign approval, audience snapshot, and delivery safety

Baseline `14a92a1933f352f84b1efc545e77cae7f5108ef8`. Branch `rebuild/phase-0-foundation`.
Local work only: nothing contacted OCI, staging, Freebuff, Caddy, DNS, Docker infrastructure, a real
customer, or any external service. No message of any kind was sent, because no code exists in this
build that could send one.

---

## 1. The boundary, and the four places it is held

This prompt adds the two things that must exist **before** delivery is discussed — a record of a
person deciding, and a record of who that decision covered — and adds no way to deliver either.

| where | what it holds |
|---|---|
| `CampaignState` | `DRAFT`, `IN_REVIEW`, `APPROVED`, `WITHDRAWN`, `ARCHIVED`. No sent, scheduled or queued value exists to move a row into |
| `/api/staff/campaigns` `setState` | lists the three merchant-driven states literally. `APPROVED` and `WITHDRAWN` are **refused**, so the label cannot be had without the decision |
| `src/server/campaigns/delivery.ts` | the only delivery-shaped module. Its sole implementation throws on its first line, and it accepts a snapshot id and nothing else |
| `tests/e2e/campaign-approval-ui.spec.ts` | no button or link on any campaign screen is named send, schedule, queue or dispatch in either language, **and none is disabled** |

A source scan over `src/server/campaigns/` and `src/server/consent/` asserts that no `fetch`,
provider SDK, HTTP client, queue client, `setInterval` or cron reference exists anywhere in them.
`package.json` is unchanged: this prompt added no dependency.

### B7 is untouched

`GET`/`POST /api/enroll` still answer a constant `410`; `/join/<anything>` is still the static
withdrawal notice with no form. `/api/campaigns`, `/api/deliver`, `/api/unsubscribe`, `/api/track`
and `/api/staff/campaigns/send` do not exist. A visitor who guesses `/en/unsubscribe` or
`/en/preferences` is sent to the **staff sign-in** — which is the proof worth having: a customer
following a guessed preference URL is asked for a staff password, not handed a control over their own
record. All of it is asserted in the browser suite.

---

## 2. Campaign lifecycle

### `READY` became `IN_REVIEW`

Prompt 2's `READY` meant "the merchant considers the wording finished", which is exactly the moment a
campaign is handed over for a decision. Rather than add a parallel `IN_REVIEW` beside it and leave
two labels meaning one thing, the migration **renames it**, rebuilding the enum with an explicit CASE
that maps `READY → IN_REVIEW` and leaves `DRAFT` and `ARCHIVED` alone.

Every stored row keeps its meaning. No row is deleted, and a campaign a merchant had marked ready is
in review afterwards — which is what they meant by marking it.

### Two owners, on purpose

`campaigns.ts` owns `DRAFT`, `IN_REVIEW` and `ARCHIVED`, in one table (`MERCHANT_TRANSITIONS`) rather
than as scattered conditionals. `approvals.ts` is the **only** writer of `APPROVED` and `WITHDRAWN`.

```
DRAFT     → IN_REVIEW   submit for a decision
IN_REVIEW → DRAFT       pull it back to keep writing
APPROVED  → (nothing)   withdraw first; the row for APPROVED is empty
WITHDRAWN → DRAFT       start again; approving writes a new decision and a new snapshot
ARCHIVED  → DRAFT       restore
```

The single most important test in the suite sends `setState: APPROVED` and requires a 400. Without
it, every other guarantee here would be decoration: there would be a way to have the label without
the decision row, the snapshot, or the person.

### What an approval records

One append-only `CampaignApproval` row: campaign, **the exact revision**, revision number, decision,
**the channel declared at the decision**, the audience snapshot, the approver, the timestamp, an
optional note.

The channel is declared rather than read back from the draft. A merchant who approves an SMS and
later relabels the draft as WhatsApp has not approved a WhatsApp message, and a row that read the
channel back afterwards would quietly claim otherwise.

The client sends the revision number it is deciding about, and the server checks it against its own
latest. If a colleague saved an edit while the approval screen was open, the approval is refused with
a 409 rather than landing on words nobody read.

### Editing approved content

Allowed, and it invalidates the approval in the same transaction: a new revision is written and the
campaign drops to `DRAFT` with its approval pointers cleared. Refusing the edit would be worse — a
merchant who spots a typo after approval needs a way to fix it that is not "make a second campaign".

**The approval row is untouched.** It remains a true statement about the revision it named. History
stays; status moves. The invalidation is audited separately
(`campaign.approval_invalidated`) because it happens as a side effect of something a merchant did for
another reason, and a side effect nobody recorded is how an audit trail develops a hole.

Changing the **audience** while approved is refused outright rather than silently invalidated. The
snapshot was taken over that segment; swapping it underneath would leave an approval whose audience
came from a group nobody approved.

### Withdrawal

Explicit, audited, and additive: a second row recording the withdrawal and pointing at the approval
it took back. Nothing is deleted, the snapshot is kept, and readiness is blocked. Approving again
writes a third row and a **new** snapshot, because it is a new decision.

### The approval policy, stated rather than implied

**One approver**: `EDIT_PUSHES` — the product's existing engagement permission, held by an owner and
a manager — **plus a membership with no branch restriction**, because a snapshot is business-wide and
a branch-scoped approver would be signing off on a number they cannot verify.

A mandatory second approver is deliberately **not** invented. A pilot merchant is one person;
requiring two would mean requiring them to create a second account to approve their own campaign,
which is theatre rather than control. Recorded as **D12**.

---

## 3. The audience snapshot

A segment is a live definition whose membership moves as customers earn, spend and enrol. That is
right for a segment and wrong for a decision, because "you approved this for 412 people" has to still
be true next week. So approval takes an immutable snapshot **inside the approving transaction** — not
two reads with a gap a concurrent enrolment can fall into.

### What it holds, and what it refuses to hold

| stored | not stored |
|---|---|
| internal profile reference | phone, name, email |
| consent state observed at that instant | card id, serial number, card URL |
| the consent record that decided it, or `null` for an enrolment answer | QR token, share token, source token |
| campaign, revision, segment, segment name as it was, timestamps, counts | any rendered message |

**No row at all is written for an excluded customer.** The two exclusion reasons live on the header
as `unknownCount` and `withdrawnCount`. Somebody who never agreed to be contacted has not agreed to
appear in a marketing artefact either, and no future delivery needs them.

`consentRecordId` is null when the permission came from the enrolment answer rather than a recorded
change. That is a fact worth telling apart later; inventing a reference to make the column look tidy
would be the same mistake Prompt 2 refused when it declined to backfill a consent history.

The segment's **name at the time** is copied onto the header, so a rename afterwards does not rewrite
the history of a decision.

### Reproducible, and unmoved by the live segment

The integration suite approves with one eligible customer, enrols two more consenting customers, and
asserts that the live preview says three while the snapshot still says one — header counts and member
rows alike.

### The consent contract at snapshot time

Applied exactly as everywhere else: only an explicit, dated, versioned `GRANTED` is eligible.
`UNKNOWN` — the real historical row, a tick with no date and no policy version — is excluded and
counted, as is `WITHDRAWN`. The suite builds all three cases in one segment and checks each count.

A segment definition this build cannot read raises rather than evaluating to an empty `where`. An
empty `where` is the one wrong answer here, because the resulting snapshot would authorise a whole
customer base.

### Retention

**Not decided, and deliberately not invented.** Nothing deletes a snapshot. A retention period, and
what happens to one when a customer asks to be erased, are recorded as **D13** (related to the
consent retention question, D9). **D14** records the 50,000-member ceiling on a single approval — a
review limit rather than a performance one, and a code constant the owner can change on the record.

---

## 4. The delivery boundary

`src/server/campaigns/delivery.ts` exists because the step from "an approved campaign with a count of
contactable people" to "somebody writes a loop" is one small step, and the honest way to handle that
is to put the step somewhere visible and make it refuse.

```ts
export const disabledDelivery: CampaignDeliveryPort = {
  async dispatchApprovedSnapshot(): Promise<never> {
    throw new DeliveryDisabledError();
  },
};
```

`snapshotId` is accepted and never used: the function cannot reach a recipient because it never looks
one up, and a reviewer confirms that by reading four lines rather than by tracing a call graph. The
unit test spies on four database accessors and asserts that refusing touches none of them — the
property that matters is not only *that* it throws but that it throws **before reading anything**, so
a bug in a future guard cannot cause contact details to be loaded in the name of sending a message.

The port is deliberately narrow. There is no variant taking a recipient, a phone number or a rendered
message, because a port shaped like that is one somebody can call with data they assembled
themselves. No provider, credential, configuration key, queue, worker, scheduler or retry policy was
added anywhere.

### Readiness

Every campaign response carries a `DeliveryReadiness`: `deliverable: false`, the approved revision,
the approved audience size, and a blocker list that always ends with `NO_DELIVERY_CHANNEL_EXISTS` —
the merchant's own blockers first, the state of the product underneath them. It also carries
`consentMustBeRecheckedAtDispatch: true`, in the contract rather than only in a comment, because a
comment is not returned by an API.

### An approval is not permission to contact anybody

The case is tested, because the alternative is a person who said no receiving a message from a list
taken before they said it:

1. a customer with an explicit agreement is snapshotted into an approval;
2. the customer withdraws afterwards;
3. the snapshot **still lists them** — it is a record of what was true, and rewriting it would make it
   useless as one;
4. the live consent check returns nobody, and the live audience preview returns zero.

Whatever builds delivery re-reads current consent per recipient at the moment it contacts them, and
treats a snapshot as the **ceiling** of an audience, never as its authority. The screen says so, in
both languages, on the readiness section of every campaign.

---

## 5. Authorization and tenant isolation

| attempt | result |
|---|---|
| cashier approves or withdraws | 403 — holds neither engagement permission |
| branch-scoped member with `EDIT_PUSHES` approves | 403 — cannot verify a business-wide snapshot |
| member deactivated between two requests | 403 on the second — context is rebuilt from the database every request, never from a cached role |
| approve / withdraw / read decisions on another business's campaign | **404**, not 403: `businessId` is in the `WHERE`, so the id does not exist for that caller |
| point a campaign at another business's segment | 400 |

Decision lists return an approver's **name**, never a user id and never an email; the suite
serialises the response and asserts neither appears.

---

## 6. Migration

One migration, `20260916120000_campaign_approval_and_snapshots`:

- rebuilds `CampaignState` with an explicit CASE (`READY → IN_REVIEW`), preserving every row
- adds `CampaignDecision`
- adds `CampaignApproval`, `CampaignAudienceSnapshot`, `CampaignAudienceMember`
- adds three nullable columns to `Campaign` (`approvedRevisionNumber`, `approvedSnapshotId`,
  `approvedAt`) — derivable, kept on the row so the drafts list answers "is what I am looking at what
  was approved" without a correlated subquery per campaign, and cleared in the same transaction that
  invalidates an approval
- adds four append-only triggers

Nothing is dropped, nothing is backfilled, and no existing row is rewritten.

**The migration contributes zero schema drift.** `prisma migrate diff` between the schema and the
database it produces reports only two pre-existing cosmetic differences from Prompt 2 — the
`ConsentRecord` foreign-key and index names, which are spellings, not behaviour. Getting there meant
rolling the migration back locally once and reapplying it with Prisma's canonical constraint names
and with `onDelete: Restrict` declared in the schema for five optional relations (including
`Campaign.segment`, which had been `Restrict` in SQL and `SetNull` in the schema since Prompt 2).

### Append-only enforced twice, on three more tables

`scripts/db-roles.mjs` now lists all six append-only tables, so the runtime role holds **only
`SELECT` and `INSERT`** on them and the services are refused on privilege before a trigger runs. The
trigger is the second line, for anyone connecting with more rights than the app has.
`tests/integration/runtime-role.test.ts` asserts the exact privilege set on each and adds ten bypass
attempts; the feature suite asserts both refusals — privilege as the app, trigger as the owner.

---

## 7. Verification

Every command was run locally against the local PostgreSQL databases.

| check | result |
|---|---|
| `node scripts/gate.mjs` | **PASS 15/15**, 512.4 s |
| `npx playwright test` (run 1) | **54 passed**, 2.1 m |
| `npx playwright test` (run 2) | **54 passed**, 2.0 m |
| `npx vitest run` | **78 files, 986 tests, all passed**, 348 s |
| `npm audit` | 0 vulnerabilities |
| `npm audit --omit=dev` | 0 vulnerabilities |
| `node scripts/db-migrate.mjs status` | 10 migrations, schema up to date |
| `prisma migrate diff` (schema ↔ database) | only the two pre-existing `ConsentRecord` name differences |
| `git diff --check` | clean |
| secret scan | only the `sk_live_...` / `pk_live_...` literal placeholders in the committed `.env.production.example` |

Test counts added by this prompt: 9 unit (delivery boundary), 37 integration (approval, snapshots,
isolation, no-send), 7 browser, plus 12 more bypass attempts and 3 more privilege assertions in the
runtime-role suite.

### Failures on the way, reported rather than hidden

1. **The approval posted a translated label as an enum.** The panel received the channel as
   `t("channel.PUSH")` and sent "App notification" as `intendedChannel`; the server rejected it and
   the screen showed the wrong error. Found by reading a failing test's screenshot. The panel now
   takes the enum and the label as separate props.
2. **Every database assertion in the first browser spec was global.** The e2e suite shares one
   database across every spec and never truncates, so `prisma.campaignApproval.count()` was counting
   other tests' work. Three assertions passed for the wrong reason before the counts happened to
   disagree. Every read is now scoped to the café the test created.
3. **A route-existence assertion asserted the wrong thing.** `/en/unsubscribe` returns 200 with a
   form — the staff sign-in, because the proxy redirects an unauthenticated visitor there. The test
   now asserts the destination, which is the stronger claim.

### What was NOT tested, and is not claimed

No staging deployment, no device testing, no PWA install, no real customer, no provider, no
infrastructure, no delivery, and no network beyond localhost. Nothing was sent to anybody, because
nothing in this build can send.

---

## 8. Screenshots inspected

Generated into `playwright-results/visual/`. Each was opened and read; this is exactly the list.

| file | what reading it confirmed |
|---|---|
| `desktop-en-campaign-approved.png` | "Approving records a decision. It does not send anything…" above the controls; the standing approval badge; **Withdraw approval** as the only decision control; the frozen audience with its counts, segment name, taken date, "Counts and internal references only" and "A snapshot cannot be edited"; and "Can this be delivered? No — and not because of anything you have done", with the consent-recheck note |
| `desktop-en-campaign-withdrawn.png` | the decision table with both rows — Withdrawn (note "wrong month", audience "—") above Approved (audience 1) — the audience un-frozen, and readiness showing "The approval was taken back" above the reason that never clears |
| `phone-ar-campaign-approved.png` | the whole approval flow in Arabic RTL on a phone: heading, notice, badge and the red **سحب الاعتماد** all right-aligned; the snapshot counts and both notices reading correctly |
| `desktop-en-campaigns.png`, `desktop-en-campaign-detail.png`, `phone-ar-campaigns.png`, `desktop-en-consent.png`, `desktop-en-consent-history.png`, `phone-ar-consent.png`, `phone-ar-consent-history.png` | re-generated by the Prompt 2 spec and re-read: unchanged by this prompt except for the state labels |

### The defect the Arabic screenshot found

The snapshot line rendered its date inside an Arabic sentence, where the bidi algorithm reorders an
unisolated left-to-right run. The date and the segment name are now wrapped in `<bdi>`, and the
messages end before the value rather than interpolating it. Confirmed by re-reading the regenerated
screenshot at 2× — it now reads `2026-09-13`. On a record of a decision, a date that could be read as
a different date is not a cosmetic problem.

---

## 9. Risks and open decisions

| # | what |
|---|---|
| **D11** (reframed) | What a sign-off will commit to once delivery exists — whether an approved campaign may be dispatched without a second confirmation, and how long an approval stays valid |
| **D12** (new) | Whether a second approver becomes mandatory when a business has staff who are not its owner |
| **D13** (new) | Audience snapshot retention, and what happens to one when a customer asks to be erased |
| **D14** (new) | The 50,000-member ceiling on one approval |

**Risk: the approval-invalidation pointers are denormalised.** `Campaign.approvedRevisionNumber`,
`approvedSnapshotId` and `approvedAt` are derivable from `CampaignApproval` and are kept on the row
for query shape. They are written only inside the transactions that write a decision, and
`readinessOf` treats a campaign marked `APPROVED` with no approved revision as **not approved** — the
honest reading if they ever disagreed. A unit test pins that behaviour.

**Risk: a snapshot is the first stored audience membership in the product.** It carries no contact
data, but it is still a record that a named group of customers was approved as a marketing audience on
a date. That is why D13 exists, why no row is written for an excluded customer, and why nothing in the
codebase reads member rows out to a caller.

**Limitation: the decision table hides two columns on a phone.** "Intended for" and "By" are
`hidden sm:table-cell`, matching the existing convention on the same screen. Same trade-off noted for
the consent table in Prompt 2, and the same answer: worth revisiting, since the approver is the field
that makes the row auditable.
