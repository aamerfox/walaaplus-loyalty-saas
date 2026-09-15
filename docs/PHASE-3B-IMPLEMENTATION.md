# Phase 3B — implementation notes

> **Scope of this file: Prompt 1 only.**
>
> Phase 3B's original deliverable was five things - a public API, API keys, signed outbound
> webhooks, a private GoHighLevel OAuth app, and one validated POS connector. **Two are built.**
> This file documents the first of them; Prompts 2 and 3 are documented in
> `docs/evidence/phase-3b-prompt-2.md`, `docs/evidence/phase-3b-prompt-3.md`,
> `docs/WEBHOOK-EGRESS-TOPOLOGY.md` and `docs/PHASE-3B-RELEASE-GATE.md`.
>
> **The public API, API keys, the GoHighLevel app and a POS connector are not started.** Nothing in
> this file, and nothing in the webhook release gate, should be read as covering them. The full
> reconciliation is `docs/PHASE-3B-SCOPE-RECONCILIATION.md`.

Phase 3A ended with a wallet link, a referral attribution and a coupon a cashier records. Phase 3B is
about the direction none of those went: **outwards**.

**Prompt 1 ships exactly one thing**: an internal record that a completed workflow happened. It
delivers nothing, connects to nothing, holds no credential and has no way to obtain one.

The capability audit that gates it is `docs/INTEGRATIONS-CAPABILITY-MATRIX.md`. It was written first
and then used to constrain the implementation; only §1 of it is turned on.

---

## 1. The sentence this prompt exists to prevent

> *"We integrate with Twilio, SendGrid, Stripe, WhatsApp and your POS."*

A provider logo on a settings screen is not an integration. Neither is a **Connect** card, a field
that accepts an API key, or a row in a features table. An integration is a credential somebody
obtained, an account somebody pays for, a contract somebody agreed to, a network path that reaches
the provider, a retry policy for when it does not, and a record of what was actually delivered.

This phase has none of those. The thing that makes that stick is not a promise in a document — it is
that there is nowhere in the code for any of them to go, and a test that reads the source and says
so.

The order matters too. Building the **record** first, with nothing able to publish it, is what keeps
a half-finished integration from being mistaken for a working one. The opposite order — an endpoint
field and a Connect button, with delivery "coming next sprint" — is how the sentence above gets
written by somebody in good faith.

---

## 2. The envelope, and the column that is not there

`IntegrationEvent` carries the business, an envelope version, the event type, the entity type, the
entity's internal id, and the moment the **database** assigned. That is all of it.

**There is no JSON metadata column**, and that absence is the design rather than an oversight.

A free-form bag does not leak a phone number because somebody is careless. It leaks one because
somebody debugging a failed delivery at two in the morning adds *"just the recipient, temporarily"*,
and temporarily becomes a column nobody re-reads. Typed columns mean the table has nowhere to put a
contact detail, a capability or its digest, a coupon code, a secret, a wallet payload or an amount —
and adding one would require a migration, which is a thing a person reviews.

The integrity suite asserts the column list **exactly**:

```
businessId, createdAt, entityId, entityType, envelopeVersion, eventType, id, occurredAt
```

and then separately asserts that no column name matches phone, email, name, address, code, digest,
salt, token, secret, key, password, payload, wallet, pass, amount, price, currency, total, balance,
points, stamps, reward, url, endpoint, webhook, metadata or payment. Two checks because they fail
differently: the first catches a column being added, the second catches one being renamed into
something dangerous.

A consumer that needs detail asks for it through an authorized read. That keeps the authorization
decision in one place instead of copying a customer's data into a row nobody re-checks.

### Why the envelope is versioned

`envelopeVersion` is `1`, and `1` is the only value that exists — enforced by a CHECK constraint and
again by the trigger.

The point is what happens later. A consumer written against version 1 that meets a version 2 row
should **stop**, not guess; a shape that cannot be identified is a shape that gets mis-delivered. A
version column added after the first consumer exists is a version column nobody can trust, because
the rows written before it have no version at all.

---

## 3. Written with the action, or not at all

`emitIntegrationEvent(tx, …)` takes a transaction client **and has no other overload**. A caller
cannot accidentally emit outside the transaction that did the work, because there is no signature
that lets them.

Both call sites are inside the transaction that already existed:

- `redeemCoupon` — after the redemption row and its audit entry, before the transaction returns.
- `voidRedemption` — after the `VOIDED` row and its audit entry.

So the two commit together. There is no "best effort" path, because a best-effort event is one a
consumer will eventually be missing without anybody knowing — and a consumer cannot tell a missing
event from an event that never should have existed.

The test for this is the one that matters most in the file: the emitter is made to throw, and the
assertion is that **the redemption is not there either**. A cashier is told the coupon was not
accepted, which is true; nothing was recorded, in either table. The next attempt, with the emitter
working, succeeds — so a failure leaves nothing broken behind it.

### The void event names the void row

Not the redemption it withdraws. Both are rows in an append-only table and both are things that
happened: the "recorded" event said a customer was owed something, and it still did. A void is a
second fact, not a correction to the first — which is exactly how `PromotionRedemption` models it,
and the event stream should not disagree with the table it describes.

It also makes `(eventType, entityId)` unique work naturally, which is what makes emission idempotent:
a retry, a second service, or a backfill script that ran twice all collide on the index rather than
producing two rows a future consumer would deliver twice.

---

## 4. No backfill — refused, not merely intended

Every redemption and void recorded before this migration has **no event**, and none can be created
for one afterwards.

A backfilled row would assert that a decision to publish was taken at a moment when it was not.

### What the first version of this got wrong

`occurredAt` being server-assigned stops a row being dated into the past. It does **not** stop a row
being written *today* for a redemption from last month. Everything else the trigger checked — the
entity exists, it is this business's, it is the right kind — is satisfied by exactly that row. So a
direct writer could have manufactured an event for any old redemption that had none, which is the
backfill this phase refuses to do.

Found in review of `9c4a13e`, before anything was deployed.

### The rule that closes it

```sql
IF NEW."occurredAt" IS DISTINCT FROM redemption."recordedAt" THEN
  RAISE EXCEPTION 'IntegrationEvent: an event must be written in the same transaction as the thing it describes'
```

Both timestamps are assigned by their own triggers from `now()`, which in PostgreSQL is the
**transaction's start time** and is identical for every statement inside one. So equality means
"these two rows were written in the same transaction", and a later transaction — with a different
`now()` — cannot produce it.

**Neither side can be chosen by the caller.** `PromotionRedemption.recordedAt` is overwritten by
`walaaplus_validate_redemption`; `occurredAt` is overwritten at the top of this function. A writer
that knows exactly when the redemption happened and supplies that value still fails, because the
value it supplies is discarded before the comparison. There is a test that tries.

It is checked **last**, after the existence, tenant and entity-kind rules, so each refusal stays
specific about what was actually wrong rather than collapsing into one message.

### The residual — CORRECTED by migration `20260925130000`

> **This section described the rule as it shipped. The residual below turned out to be exploitable,
> and has since been closed. Read §"Transaction identity" at the end of this document for what the
> rule is now.**

The columns are `TIMESTAMP(3)`, so two transactions beginning within the same millisecond would
compare equal. That closes the thing the rule exists for — an **old** redemption can never be matched
— and it is written into the migration rather than glossed. An exact same-transaction proof is
available (comparing `PromotionRedemption.xmin` against `pg_current_xact_id()`) and was not taken:
it would behave differently under savepoints, which Prisma's transaction handling may introduce, and
trading a robust rule for an exact one that might refuse a legitimate write is the wrong trade
without a reason to make it.

If a consumer ever needs history, that is a decision with a policy attached, not a script somebody
runs on a Friday.

---

## 5. What the database refuses, with no service in the way

`walaaplus_validate_integration_event` — `BEFORE INSERT`

- assigns `occurredAt` from `now() AT TIME ZONE 'UTC'`
- dispatches on `entityType` to decide which table the entity lives in, and refuses an entity type it
  has no rule for
- the entity must **exist**
- the entity must belong to **the same business** as the event
- the entity must be the **kind the event type claims**: a "recorded" event names a `REDEEMED` row, a
  "voided" event names a `VOIDED` row
- the event's `occurredAt` must **equal the entity's own `recordedAt`**, which is true only when the
  two rows were written in one transaction — §4

`walaaplus_reject_integration_event_mutation` refuses `UPDATE`, `DELETE` and `TRUNCATE`, for the
table owner as well as the runtime role.

Plus a CHECK on the envelope version and a unique index on `(eventType, entityId)`.

### There is deliberately no foreign key on `entityId`

Two reasons, and the second is the stronger one.

A foreign key binds the column to one table forever, and the next event type will point somewhere
else — at a campaign, or a program version, or something not yet imagined. The lookup is dispatched
on `entityType` instead, so adding an entity type is adding a branch rather than dropping a
constraint.

And a foreign key would have been **satisfied** by the row this is most concerned about: another
business's redemption exists, so the reference is valid. What is wrong is whose it is. The trigger
catches that; a foreign key never could.

`businessId` does have a foreign key, because there is only one business table and there always will
be.

### Proven against the database, not the service

`tests/integration/integration-events-integrity.test.ts` inserts every invalid shape through
`prisma` — the **restricted runtime client**, with no service in the way — exactly as a second
service, a backfill script or a console session would. It inserts the valid shapes too, so the rules
are known to refuse the wrong rows without refusing the right ones.

Each protection was then removed one at a time and the suite watched go red. §7 has the table.

---

## 6. Who may read it

| | Cashier | Manager | Owner |
|---|---|---|---|
| Reach `/business/integrations` | ❌ 404 | ✅ | ✅ |
| Read the event history | ❌ | ✅ `VIEW_INTEGRATIONS` | ✅ |
| Connect a provider | ❌ | ❌ | ❌ — there is nothing to connect |

`VIEW_INTEGRATIONS` already existed in the permission enum and in `ROLE_DEFAULT_PERMISSIONS` for
`OWNER` and `MANAGER`; **no permission was added or changed by this prompt.**

`listIntegrationEvents` checks the permission *and* the role. A permission bit can be granted to one
membership by a checkbox, and a feed of everything the business has done is not a decision to leave
to a checkbox. The page 404s for a cashier rather than rendering empty: being told there is a page
you may not see is itself information.

The screen is a server component with no client bundle and no route behind it. There is nothing to
interact with, so there is no `/api/integrations` — and a test asserts that directory does not exist,
along with `/api/webhooks` and `/api/events`.

---

## 7. Every protection was watched fail

| protection removed | result |
|---|---|
| the whole `integration_event_validate` trigger | **5 of 13** red |
| only the `occurredAt` assignment | **1** red |
| only the cross-tenant check | **1** red |
| only the entity-kind check | **2** red |
| both append-only triggers | **1** red |
| the envelope-version CHECK | **1** red |
| the `(eventType, entityId)` unique index | **1** red |
| only the same-transaction comparison (§4) | **4** red, and the positive control stayed green |

Each was restored and the suite re-run green.

**One honest exception.** The grant-level protection could not be turned red *through the suite*:
the integration harness runs `npm run db:roles` at suite start, which revokes and re-grants, so a
grant broken beforehand is repaired before any test body executes. That is the safety property
working rather than a gap — but it means the red-proof had to be done directly. Granting `UPDATE`
and `DELETE` and then asking the runtime role the exact predicate the test asserts on:

```
 s | i | u | d | t            s | i | u | d | t
---+---+---+---+---         ---+---+---+---+---
 t | t | f | f | f     →      t | t | t | t | f
```

The assertion is `toEqual({ s: true, i: true, u: false, d: false, t: false })`, so it would fail on
the right-hand column. Reported this way rather than claimed as a red test run.

---

## 8. What the screenshots found

Four were taken and read: the empty state and a populated list on desktop in English, the populated
list on a phone in English, and the same in Arabic on both widths.

The screen's first job is to not lie, and the screenshots are where that gets checked by a person
rather than a regex. The notice sits above the list in both languages, the list carries only a type,
a time, a shortened internal reference and an envelope version, and the "nothing about a person"
line sits under it — a second place the claim is denied, because the list is where somebody would go
looking for a customer's name.

Arabic reads right to left at phone width: heading, subtitle, notice, list rows and the closing line
all right-aligned, with the hamburger and the locale switch on the left. The ISO-shaped timestamps
and the hex reference are `<bdi>`-isolated so they stay left-to-right inside the Arabic run.


---

## Transaction identity — the correction to the same-transaction rule

**Migration `20260925130000_integration_event_transaction_identity`.** Added after the rule above had
shipped and been deployed, because the residual it documented turned out to matter.

### How it surfaced

Not in review. A **Phase 4 engineering gate failed** on
`integration-events-integrity.test.ts > refuses one written in a later transaction even seconds
afterwards`. That test is correct; it fails exactly when the one-millisecond window opens.

### Why the residual was not small

Measured on this project's own database — 400 consecutive **separate** transactions:

```
consecutive SEPARATE transactions sharing the same TIMESTAMP(3): 3 of 399 (0.8%)
```

About 1 attempt in 125. **A writer performing a backfill is not limited to one attempt**, so retrying
reaches near-certainty within a few hundred tries. Against a deliberate direct writer the timestamp
rule was therefore not a guarantee. It did completely prevent what it was written for — an *old*
redemption can never be matched, because no new transaction shares a millisecond weeks in the past —
and that half was never in question.

### The rule now

`PromotionRedemption` carries `writeXactId xid8`, assigned by `walaaplus_validate_redemption` from
`pg_current_xact_id()` and overwritten regardless of what a caller supplies, exactly as `recordedAt`
already was. `walaaplus_validate_integration_event` requires:

```sql
IF redemption."writeXactId" IS DISTINCT FROM pg_current_xact_id() THEN   -- exact, not approximate
```

Equality is now identity rather than proximity. There is no window.

### Why `pg_current_xact_id()` and not `xmin`

A transaction-id comparison was proposed once before and **rightly rejected**, because savepoint
behaviour had not been proven safe. Proven now, on PostgreSQL 15:

```
pg_current_xact_id() inside a SAVEPOINT      ->  the SAME top-level id
xmin of a row inserted inside a SAVEPOINT    ->  a DIFFERENT id (the SUBtransaction's)
xmin inside a plpgsql EXCEPTION block        ->  a DIFFERENT id (also a subtransaction)
```

`xmin` would have **refused legitimate same-transaction writes** the moment anything opened a
savepoint — a retry helper, a nested write, a future Prisma release — and the failure mode would have
been rejecting real work in production. `pg_current_xact_id()` returns the top-level id at every
depth, so both sides of the comparison agree under savepoints by construction. A test writes an event
two savepoints deep and requires it to be **accepted**; if that ever goes red, the implementation has
drifted back to the rejected design.

### Legacy rows fail closed

`writeXactId` is nullable and stays that way: redemptions existed before the guarantee did, and an
invented identity would be a fabricated claim about when something happened. A `NULL` is **refused**,
with its own message so the reason is never confused with the general one. Such a redemption could
only ever have received an event inside its own transaction, which ended before the migration existed.

### What was preserved

Migration 14's timestamp comparison is **kept as well as**, not replaced by, the identity check — it is
now implied by it, and a second independent statement of the same fact costs nothing. Every other
migration-14 rule is untouched: the server-assigned `occurredAt`, the event-type → entry mapping,
"the redemption does not exist", the tenant check, the entry-kind check, and the fatal fallthrough for
an unknown `entityType`. Both function bodies were **extracted from the applied migrations and edited
in place**, not retyped, and the diff is in the evidence.

Migrations 14–19 are byte-for-byte unchanged; the correction is ordered **before** the in-progress
Phase 4 migration so staging can deploy it without deploying incomplete Phase 4 work.
