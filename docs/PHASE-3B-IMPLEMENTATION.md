# Phase 3B — implementation notes

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

## 4. No backfill, deliberately

Every redemption and void recorded before this migration has **no event**.

A backfilled row would assert that a decision to publish was taken at a moment when it was not. And
`occurredAt` is assigned by the trigger from the server clock precisely so that nobody — not a
service, not a script, not a console session — can date one into the past.

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
