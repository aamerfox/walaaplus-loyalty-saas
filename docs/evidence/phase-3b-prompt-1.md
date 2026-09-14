# Phase 3B, Prompt 1 — integration capability audit and safe internal event foundation

**Branch** `rebuild/phase-0-foundation` · **baseline** `201d41e` · **local only, nothing deployed**

| | |
|---|---|
| Code, migration and tests | `adca926` |
| Documentation | `9c4a13e` |
| Review fix (migration, tests) | `c63aa41` — see §13 |
| Review fix (documentation) | the commit carrying this file |
| **Deploy this** | the tip of `rebuild/phase-0-foundation`. **Not `9c4a13e`** — see §13 |
| Migration | `20260920120000_integration_events`, the **14th** |
| `master` | untouched at `b9ee686`, and absent from the `deploy` remote |

---

## 1. The capability audit came first

`docs/INTEGRATIONS-CAPABILITY-MATRIX.md` was written **before** any integration code existed, and
then used to constrain what got built rather than to describe it afterwards. It classifies every
family named in the brief and in `BOOMERANGME-REFERENCE.md`:

| bucket | families |
|---|---|
| **Supported now** | the internal event record, and nothing else |
| **Foundation now, provider later** | transactional and marketing email; Telegram Bot; Telegram Report Bot |
| **Needs approval, contract or account** | Custom SMTP, SendGrid, Mailgun, Resend, WhatsApp, Facebook Messenger, Google Business API, FirstPromoter, LeadConnector/GoHighLevel, POS (Toast, Square, Shopify, Lightspeed, GloriaFood, Altegio, WooCommerce) |
| **Unsuitable / out of scope** | Twilio (market coverage unverified — D2), Google Tag Manager, Meta Ads, Stripe, PayPal (E1/E3), any analytics script, any endpoint URL, HMAC signing, retry, public API, ~38 further event types |

Three of its rulings are visible in the diff it gated:

- §0 — a provider name is not an integration. The screen says the opposite of "connected" and offers
  no Connect control; `tests/unit/integration-boundary.test.ts` checks both locales for the verbs
  that would make the claim, in each language rather than by transliteration.
- §8 — where a secret would live is a decision, not a column. Nothing in this diff adds a secrets
  table, a JSON config field, an encryption key, an environment variable or a deployment change.
- §9 — what an event row may never contain. Enforced by the table having typed columns and no JSON.

Two rows became decisions rather than guesses: **D27** (where a credential lives) and **D28** (which
workflows may emit). §10 is the manual gate: **no provider account has been opened, no credential
obtained, and no outbound request made from anywhere.** This report does not claim otherwise.

---

## 2. What was built

An append-only, tenant-isolated row per completed promotion redemption and per withdrawal:

```
IntegrationEvent(
  id, businessId, envelopeVersion, eventType, entityType, entityId, occurredAt, createdAt
)
```

That column list is asserted **exactly** in the integrity suite, and then separately asserted not to
match phone, email, name, address, code, digest, salt, token, secret, key, password, payload, wallet,
pass, amount, price, currency, total, balance, points, stamps, reward, url, endpoint, webhook,
metadata or payment. Two checks because they fail differently: one catches a column being added, the
other catches one being renamed into something dangerous.

**There is no JSON metadata column, deliberately.** A free-form bag does not leak a phone number
through malice; it leaks one because somebody debugging a failed delivery at two in the morning adds
"just the recipient, temporarily". Typed columns mean adding one requires a migration, which is a
thing a person reviews.

*This is the one place the brief's wording was read strictly.* It asked for "safe internal metadata";
what was built is typed columns and no bag, and the reasoning is written into the migration, the
model and the matrix rather than left implicit. §9 records it as a deviation.

---

## 3. Written with the action, or not at all

`emitIntegrationEvent(tx, …)` takes a transaction client **and has no other overload**, so a caller
cannot emit outside the transaction that did the work — there is no signature that lets them. Both
call sites sit inside the transaction that already existed, after the row and its audit entry.

The test that matters most makes the emitter throw and asserts **the redemption is not there
either**; the cashier is told the coupon was not accepted, which is true, and the next attempt with
the emitter working succeeds, so a failure leaves nothing broken behind it. The same test exists for
a withdrawal: the `VOIDED` row is gone with the event, the redemption still stands, and the customer
is still owed.

**The void event names the void row**, not the redemption it withdraws. Both are rows in an
append-only table and both are things that happened — the "recorded" event said a customer was owed
something and it still did. A void is a second fact, not a correction, which is how
`PromotionRedemption` already models it.

**Nothing is backfilled, and the database refuses to be talked into it.** Redemptions and voids
from before the migration have no event, and none can be created for them afterwards: `occurredAt`
is assigned by the trigger, and must equal the redemption's own `recordedAt` — true only inside one
transaction. See §13, where this started as a policy and became a rule.

---

## 4. What the database refuses, with no service in the way

`walaaplus_validate_integration_event` — BEFORE INSERT

- assigns `occurredAt` from `now() AT TIME ZONE 'UTC'`
- dispatches on `entityType`, and refuses an entity type it has no rule for
- the entity must exist
- the entity must belong to the **same business**
- the entity must be the **kind the event type claims** (recorded → `REDEEMED`, voided → `VOIDED`)
- the event's `occurredAt` must **equal the entity's `recordedAt`**, which is true only when both
  rows were written in the same transaction — §13

`walaaplus_reject_integration_event_mutation` refuses `UPDATE`, `DELETE` and `TRUNCATE`, for the
table owner as well as the runtime role. Plus a CHECK that `envelopeVersion = 1` and a unique index
on `(eventType, entityId)` that makes emission idempotent.

**There is deliberately no foreign key on `entityId`.** It would bind the column to one table
forever, and the next event type will point elsewhere. More to the point, it would have been
*satisfied* by the row this is most concerned about: another business's redemption exists, so the
reference is valid — what is wrong is whose it is. The trigger catches that; a foreign key never
could. `businessId` does have one, because there is only one business table.

`tests/integration/integration-events-integrity.test.ts` inserts every invalid shape through
`prisma`, the **restricted runtime client**, with no service in the way, and the valid shapes too.

---

## 5. Privilege model

`IntegrationEvent` joins `APPEND_ONLY_TABLES` in `scripts/db-roles.mjs` — `SELECT` and `INSERT`, and
nothing else. `db-roles` prints, and the run is in the Vitest output:

```
OK role "walaaplus_app" — read/write on 32 public tables,
  append-only on [LoyaltyOperation, ConsentRecord, CampaignRevision, CampaignApproval,
                  CampaignAudienceSnapshot, CampaignAudienceMember, ReferralAttribution,
                  PromotionRedemption, IntegrationEvent],
  no-delete on [CardShareLink, Promotion]
```

An event is a statement that something happened. There is no correcting one — the thing happened, or
the transaction that claimed it did was rolled back — and no removing one, because a future
consumer's idea of what it has already seen is a position in this table.

---

## 6. Authorization

| | Cashier | Manager | Owner |
|---|---|---|---|
| Reach `/business/integrations` | ❌ 404 | ✅ | ✅ |
| Read the event history | ❌ | ✅ `VIEW_INTEGRATIONS` | ✅ |
| Connect a provider | ❌ | ❌ | ❌ — there is nothing to connect |

`VIEW_INTEGRATIONS` already existed in the enum and in `ROLE_DEFAULT_PERMISSIONS` for `OWNER` and
`MANAGER`. **No permission was added, removed or re-assigned by this prompt.**

`listIntegrationEvents` checks the permission *and* the role, because a permission bit can be granted
to one membership by a checkbox and a feed of everything the business has done is not a decision to
leave to a checkbox. The page 404s rather than rendering empty: being told there is a page you may
not see is itself information.

The screen is a server component with no client bundle and **no route behind it** — a test asserts
`src/app/api/integrations`, `/webhooks` and `/events` do not exist.

---

## 7. Every protection was watched fail

| protection removed | tests that went red |
|---|---|
| the whole `integration_event_validate` trigger | **5 of 13** |
| only the `occurredAt` assignment | **1** |
| only the cross-tenant check | **1** |
| only the entity-kind check | **2** |
| both append-only triggers | **1** |
| the envelope-version CHECK | **1** |
| the `(eventType, entityId)` unique index | **1** |

Each restored and the suite re-run green.

**One honest exception.** The grant-level protection could **not** be turned red through the suite:
the integration harness runs `npm run db:roles` at suite start, which revokes and re-grants, so a
grant broken beforehand is repaired before any test body executes. That is the safety property
working, not a gap — but it means the proof had to be done directly. Granting `UPDATE` and `DELETE`,
then asking **as the runtime role** the exact predicate the test asserts on:

```
before:  s | i | u | d | t        after:  s | i | u | d | t
         t | t | f | f | f                t | t | t | t | f
```

The assertion is `toEqual({ s: true, i: true, u: false, d: false, t: false })`, so it would fail on
the right-hand column. Reported this way rather than claimed as a red test run.

---

## 8. Verification

Everything below was run locally on this machine, against local PostgreSQL in Docker.

| Check | Result |
|---|---|
| `node scripts/gate.mjs` | **PASS 15/15**, 696.6s |
| `npx playwright test` — run 1 | **104 passed**, 3.4m |
| `npx playwright test` — run 2 | **104 passed**, 3.4m |
| `npx vitest run` | **90 files, 1225 tests passed**, 535.4s |
| *(re-run after the §13 fix)* | **90 files, 1230 tests passed**, 457.1s |
| `npm audit` / `--omit=dev` | 0 vulnerabilities each |
| `node scripts/db-migrate.mjs status` | 14 migrations, schema up to date |
| `prisma migrate diff` | one pre-existing naming difference — §8a |
| `git diff --check` | clean |
| `git status --porcelain public/` | **0** |
| Secret scan over every changed file | clean |
| Raw-capability / coupon scan | clean — §8b |
| Physical NUL over 339 tracked reviewed files | none |

New tests this prompt:

| Suite | Tests |
|---|---|
| `tests/unit/integration-boundary.test.ts` | 10 |
| `tests/integration/integration-events.test.ts` | 14 |
| `tests/integration/integration-events-integrity.test.ts` | 13, then **18** after §13 |
| `tests/e2e/integrations-ui.spec.ts` | 12 |

### 8a. The one migrate-diff difference, reported rather than buried

`prisma migrate diff` exits 2 with exactly this, unchanged from the previous two prompts:

```
[*] Changed the `ConsentRecord` table
  [*] Renamed the foreign key "ConsentRecord_profile_fkey" to "ConsentRecord_customerBusinessProfileId_fkey"
  [*] Renamed index `ConsentRecord_profile_scope_recordedAt_idx` to `ConsentRecord_customerBusinessProfileId_scope_recordedAt_idx`
```

**Pre-existing and unrelated to this work**: it comes from `20260915120000_consent_and_campaign_drafts`,
introduced in `1f87431` (Phase 2 Prompt 2), where two identifiers were written shorter than Prisma's
own spelling. Cosmetic — same columns, same constraint, same index, different name — and fixing it
means amending an already-reviewed migration, which this prompt was not asked to do. **The
integration-events migration produces no drift**; it is absent from the output entirely.

### 8b. The raw-capability and provider scan, in full

1. **Schema** — the event table has eight typed columns and no JSON; none could hold a contact
   detail, a capability, a digest, a code, a secret, a wallet payload or an amount.
2. **Outbound** — no `fetch`, axios, `node:http`, WebSocket, queue, timer or `sendBeacon` in any code
   under `src/server/integrations/`; comments are stripped before the scan so the ones explaining the
   absence do not mask it.
3. **Providers** — no import specifier matches twilio, sendgrid, mailgun, resend, nodemailer, stripe,
   paypal, meta, facebook, whatsapp, telegram, googleapis, firstpromoter, leadconnector or
   gohighlevel.
4. **Secrets** — no URL, API key, endpoint, token, SMTP setting, encryption key, HMAC or
   `process.env` anywhere in that module.
5. **Routes** — `src/app/api/` contains no `integrations`, `webhooks` or `events` directory;
   `src/proxy.ts` is unchanged, so no public route was added.
6. **Coupon values** — the event path never reads `codeDigest` or `codeSalt`, and a service test
   serialises every stored event and searches it for the real phone, name, code, digest, salt, card
   serial and both card tokens.
7. **Rendered page** — the browser suite fetches the whole document (not just `main`) and asserts
   none of those values appears in it.

### 8c. What was NOT tested, and is not claimed

- Nothing was deployed. Not to staging, not to OCI, not to Freebuff. Staging is Freebuff's after
  review.
- **No provider, device, POS, wallet, payment or external network was contacted**, because none is
  involved — there is no code that could contact one.
- No provider account was opened, funded or verified; no credential was obtained, stored or rotated.
- Deliverability, message templates, sender reputation and per-country regulation are entirely
  unverified and out of scope.

---

## 9. Deviations from the brief

Three, all stated rather than absorbed.

**One — "safe internal metadata" was built as typed columns, not a metadata field.** The brief listed
"safe internal metadata" as part of the envelope while also forbidding a generic JSON configuration
field. Rather than add a narrow JSON bag and rely on discipline to keep it safe, the envelope is
typed columns only, and the reasoning is written into the migration, the model and the matrix. This
is stricter than asked and removes the leak vector entirely.

**Two — the grant protection could not be red-proved through the suite** (§7). The harness repairs
grants before any test body runs. Demonstrated directly instead, and reported as a demonstration
rather than as a red test run.

**Three — the secret scan is a pattern sweep**, because this repository still has no dedicated
secret-scanning script. Private keys, provider key prefixes (including SendGrid's `SG.`), and
assigned `secret` / `password` / `api_key` literals, over every changed file. Clean.

---

## 10. Screenshots inspected

All four were opened and read, not merely generated.

| File | What it shows |
|---|---|
| `desktop-en-integrations-empty.png` | the notice, the empty state, and the "nothing about a person" line |
| `desktop-en-integrations.png` | one entry: type, time, shortened internal reference, envelope version |
| `phone-en-integrations.png` | the same at phone width, notice above the fold |
| `desktop-ar-integrations.png` | the Arabic desktop screen, nav and content right-aligned |
| `phone-ar-integrations.png` | Arabic at phone width |

The screen's first job is to not lie, and a screenshot is where that gets checked by a person rather
than a regex. In all five, the denial sits above the list, the list carries only a type, a time, a
shortened internal reference and an envelope version, and the "no phone number, email address, code,
card, wallet pass or amount" line sits beneath it — a second place the claim is denied, because the
list is where somebody would go looking for a customer's name.

Arabic reads right to left at both widths: heading, subtitle, notice, rows and closing line all
right-aligned, with the hamburger and locale switch on the left on the phone and the nav rail on the
right on the desktop. The ISO-shaped timestamps and the hex reference stay left-to-right inside the
Arabic run via `<bdi>`.

Nothing needed correcting; no earlier screen regressed.

---

## 11. Known limitations

1. **Nothing is delivered.** There is no outbound HTTP, endpoint, subscription, signature, retry,
   dead-letter record or delivery log. The event row is the input to all of those and is none of
   them.
2. **No credential can be stored**, so no provider can be configured — **D27**.
3. **Two event types**, out of the reference product's roughly forty — **D28**.
4. **No backfill**, deliberately. Anything that happened before the migration is invisible to a
   future consumer.
5. **No retention rule.** Nothing deletes an event, and what happens when a customer asks to be
   erased is open — the row names no customer, but it names a redemption that does. Related to D9,
   D13, D20 and D23.
6. **The read view is one page of 50**, newest first. No filter, no range, no export.
7. **Nothing here has been seen by a real merchant**, and the matrix §10 manual gate is unchecked.

---

## 12. Open decisions raised by this prompt

**D27** where a provider credential would live, who may read it, and what happens on rotation —
**every outbound integration is blocked on this**.
**D28** which workflows may ever emit an event.

Neither is blocking today. Nothing in the code, the schema or the strings presumes an answer to
either.

---

## 13. Review hardening — the no-backfill guarantee was a policy, not a rule

`9c4a13e` was reviewed and one database-level gap was found. It is fixed in **`c63aa41`**. Migration
14 had not reached staging, so `20260920120000_integration_events` was **amended** rather than
followed by a fifteenth; the count stays at **14**, and none of the thirteen earlier migrations,
`master`, `public/`, the deployment configuration, the provider scope or Phase 3A behaviour was
touched.

### 13.1 What was wrong

`walaaplus_validate_integration_event` confirmed that the named `PromotionRedemption` exists, belongs
to the business, and is the entry kind the event type claims. None of that says **when** the event
was written.

Server-assigned `occurredAt` stops a row being dated into the past. It does not stop a row being
written *today* for a redemption from last month — and such a row satisfies every other check. So a
direct runtime writer could have manufactured an event for any old redemption that had none, which is
exactly the backfill §7 of the capability matrix says will not happen. The guarantee was a policy in
a document, not a rule in the database.

Nothing had been deployed, and no wrong row exists: the service has always written both rows in one
transaction. The gap was what a *second* writer could have done.

### 13.2 The rule

```sql
IF NEW."occurredAt" IS DISTINCT FROM redemption."recordedAt" THEN
  RAISE EXCEPTION 'IntegrationEvent: an event must be written in the same transaction as the thing it describes'
    USING ERRCODE = 'check_violation', HINT = '… Events are never backfilled.';
END IF;
```

`occurredAt` stays server-authoritative — it is still assigned from `now()` at the top of the
function, before anything reads it. The new comparison is against
`PromotionRedemption.recordedAt`, which `walaaplus_validate_redemption` assigns the same way.

Both are `now()`, which in PostgreSQL is the **transaction's start time** and is identical for every
statement inside one transaction. So:

| | |
|---|---|
| same transaction | the two timestamps are the same value → accepted |
| any later transaction | a different `now()` → refused |

**Neither side can be chosen by the caller**, because each is overwritten by its own trigger before
it is read. A writer that knows exactly when the redemption happened and supplies that value is still
refused — and there is a test that tries precisely that.

Checked **last**, after the existence, tenant and entity-kind rules, so each refusal stays specific
about what was actually wrong.

### 13.3 The residual, stated rather than glossed

The columns are `TIMESTAMP(3)`, so two transactions beginning within the same millisecond would
compare equal. That fully closes the case the rule exists for — an **old** redemption can never be
matched — and it is written into the migration.

An exact proof is available and was not taken: comparing `PromotionRedemption.xmin` against
`pg_current_xact_id()` identifies the writing transaction precisely. It behaves differently under
savepoints, which Prisma's transaction handling may introduce, and trading a robust rule for an exact
one that might refuse a legitimate write is the wrong trade without a reason to make it. Recorded
here so the option is visible rather than forgotten.

### 13.4 The suite was restructured, because the rule changed what a valid insert looks like

Seven existing tests inserted an event in a different transaction from the redemption it named —
which was legal before and is not now. All of them went red on the first run, which is the rule
working.

Every event that should succeed is now written **in one transaction with a fresh redemption**, via a
`sameTransaction()` helper: that is the only shape the database accepts, so it is the shape the
positive controls have to take. The refusal tests are unaffected — the existence, tenant and
entity-kind rules are checked before the time rule, so each still fails on its own specific message,
which the assertions now name exactly.

Five tests added for the rule itself:

| test | what it proves |
|---|---|
| accepts an event inserted alongside a brand-new redemption | the same-transaction path works, and the two timestamps are equal |
| refuses an event for a redemption committed in an earlier transaction | the backfill is refused, **and no event row is written** |
| refuses a withdrawal event for a void row committed earlier | the same, for the other event type |
| cannot be imitated by supplying the redemption's own recorded time | the supplied value is discarded before comparison |
| refuses one written in a later transaction even seconds afterwards | not a stale-row problem — "later" means "different transaction", not "old" |

And the service workflows still each produce their matching event: `integration-events.test.ts` is
unchanged and its 14 tests pass, including the redemption event, the void event, the "no event for a
refused coupon" case and both transactionality tests.

### 13.5 The new rule was watched fail

Removing **only** the comparison — every other line of the function left exactly as it is — and
re-running:

```
× refuses an event for a redemption committed in an earlier transaction
× refuses a withdrawal event for a void row committed earlier
× cannot be imitated by supplying the redemption's own recorded time
× refuses one written in a later transaction even seconds afterwards
  Tests  4 failed | 14 passed (18)
```

Four red, and the fifth new test — the positive control — stayed green, which is what tells you the
rule refuses the right rows rather than all of them. Restored, and both suites re-run: **32 passed**.

### 13.6 The quality bar, re-run in full after the fix

| Check | Result |
|---|---|
| `node scripts/gate.mjs` | **PASS 15/15**, 570.3s |
| `npx playwright test` — run 1 | **104 passed**, 3.1m |
| `npx playwright test` — run 2 | **104 passed**, 2.9m |
| `npx vitest run` | **90 files, 1230 tests passed**, 457.1s |
| `npm audit` / `--omit=dev` | 0 vulnerabilities each |
| `node scripts/db-migrate.mjs status` | **14** migrations, schema up to date |
| `prisma migrate diff` | unchanged — the same pre-existing `ConsentRecord` naming difference, §8a |
| `git diff --check` | clean |
| `git status --porcelain public/` | **0** |
| Secret scan over every changed file | clean |
| Screenshots | `desktop-en-integrations.png` re-read after the run; the service path still writes its event and nothing regressed |

Only two files changed in `c63aa41`: the migration and the integrity suite.

---

## 14. Which SHA to deploy

The tip of `rebuild/phase-0-foundation` — the documentation commit carrying this file, which
contains `adca926`, `9c4a13e` and `c63aa41`. The final report names the exact hash; it is not written
here because a file cannot name the commit it is part of.

**`9c4a13e` must not be deployed.** Nothing in it is wrong today — the service has only ever written
an event inside the transaction that produced it, so every existing row is correct. What it ships is
a migration whose no-backfill guarantee rests on the service being the only writer, and a migration
is the hardest artefact to correct once applied. It has not been applied anywhere yet, which is the
only window in which this is one more `IF` rather than a fifteenth migration reasoning about rows
that already exist.

`master` is untouched at `b9ee686` and does not exist on the `deploy` remote. Staging is Freebuff's
after review, and nothing in this report claims a staging, provider, device, POS, wallet or
external-network test was performed.
