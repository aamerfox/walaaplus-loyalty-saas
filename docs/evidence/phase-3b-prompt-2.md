# Phase 3B, Prompt 2 — secure custom outbound webhooks and controlled delivery

**Branch** `rebuild/phase-0-foundation` · **baseline** `e34e765` · **local only, nothing deployed**

| | |
|---|---|
| Code, migration and tests | `770f324` |
| Documentation | `9695e17` |
| Review fixes — lease, test matrix, encryption (migration, code, tests) | `76edaee` — see §13 |
| Review fixes — lease, test matrix, encryption (documentation) | `9282fa2` |
| Review fix — dispatch boundary (code, tests) | `35b6ab2` — see §14 |
| Review fix — dispatch boundary (documentation) | the commit carrying this file |
| **Deploy this** | the tip of `rebuild/phase-0-foundation`. **Not `9695e17`, not `9282fa2`** |
| Migration | `20260921120000_webhook_destinations`, the **15th** |
| `master` | untouched at `b9ee686`, and absent from the `deploy` remote |

---

## 1. The capability audit was extended first

`docs/INTEGRATIONS-CAPABILITY-MATRIX.md` gained **§7a — webhook security and decision record**,
written before any Prompt 2 code existed and covering every heading the brief named: encryption,
signing, SSRF, delivery semantics, retries, endpoint verification, key rotation, retention, owner
authority, and the receiver's own responsibilities. §8a records the exact deployment requirement for
`INTEGRATION_ENCRYPTION_KEY`.

**No named provider moved a bucket.** §§2–6 are unchanged: email, SMS, WhatsApp, Messenger, Google,
Meta, Stripe, PayPal, FirstPromoter, LeadConnector and POS are all still where Prompt 1 left them.

Two rows became decisions rather than guesses: **D29** (the key-rotation tool does not exist) and
**D30** (no delivery retention rule).

---

## 2. What was built

```
WebhookDestination      what the owner configured. Narrow UPDATEs.
WebhookDelivery         one row per (destination, event). A transactional OUTBOX.
WebhookDeliveryAttempt  APPEND-ONLY. Outcome, status code, bounded error class.
```

Five enums, three tables, seven triggers. **No JSON column anywhere**, and the integrity suite
asserts all three column lists exactly.

A delivery attempt never touches `IntegrationEvent` — the event said what happened; whether somebody
was told is a different fact, and conflating them would let a delivery failure rewrite the record of
a redemption.

---

## 3. Encryption

AES-256-GCM, fresh 96-bit nonce per value, envelope `v1.<nonce>.<tag>.<ciphertext>` in base64url,
with the algorithm and key version in their own columns.

Encrypted: the **URL** (which may carry a path or query token the receiver treats as authentication)
and the **signing secret**. Plaintext: the name and the hostname, which the owner reads and neither
of which is a credential.

**No fallback, in any mode.** A unit test asserts there is no source and no argument combination that
returns plaintext. A CHECK constraint requires the exact nonce (16 chars) and tag (22 chars) lengths,
so a plaintext URL cannot be stored even by a direct writer, and a truncated tag is refused.

**Fail closed, scoped to webhooks.** Without the key, configuration and delivery refuse; an
integration test removes the key and then redeems a coupon at the till successfully, and asserts B7
still answers 410.

`src/server/env.ts` takes the variable as an **optional, unvalidated string** — deliberately.
Validating its format at boot would stop enrolment, stamps, redemptions and `/health` over a feature
nobody had configured.

---

## 4. Signing

`HMAC-SHA-256` over `"{timestamp}.{body}"`, sent as `X-Walaaplus-Signature: v1=…`. The timestamp is
inside the signed string, so a captured body cannot be replayed under a fresh one.

The body is the seven-field envelope and nothing else: `id`, `envelopeVersion`, `eventType`,
`entityType`, `entityId`, `occurredAt`, `businessId`. A browser-suite test asserts the body's key
list exactly, and a delivery test asserts the signing secret, the URL and the hostname appear in
neither the body nor the headers.

`X-Walaaplus-Event-Id` is stable across every attempt and every destination. **At-least-once, never
exactly-once** — on the screen in both languages, in §7a, and here.

---

## 5. SSRF and DNS rebinding

| rule | where |
|---|---|
| HTTPS only, no user-info, no IP literal, no loopback/private name, no single-label host, no control characters | `assertSafeWebhookUrl`, on save **and before every request** |
| every resolved address validated, and the socket connects only to one just validated | `makeGuardedLookup`, handed to the agent as its `lookup` |
| any private answer refuses the whole resolution | `resolveSafeAddress` |
| no redirects | the transport treats 3xx as an outcome |

A delivery test resolves a saved, valid hostname to `169.254.169.254` at delivery time and asserts
the request never leaves, the outcome is `UNSAFE_ADDRESS`, `PERMANENT` and never retried, and the
receiver saw nothing.

### A bug the tests found

Node calls a custom `lookup` with `{ all: true }` when Happy Eyeballs is on — the default since
Node 20 — and expects an **array**. Answering with a bare string gives
`ERR_INVALID_IP_ADDRESS: undefined`, which looks like DNS and is not. Fixed, with a unit test for the
array form.

### The test seam, stated

The local HTTPS receiver is on loopback and the policy refuses loopback, correctly. Rather than
soften the rule, `resolveSafeAddress` takes an `AddressPolicy` **whose default is the rule**; the
tests pass one permitting exactly the receiver's address and deferring to the real policy otherwise.
No production caller passes one, and `webhook-boundary.test.ts` asserts the runner and the worker job
never do.

---

## 6. Delivery, retries, and worker-only

An outbox: the `WebhookDelivery` row is written in the **same transaction** as the
`IntegrationEvent`. A rolled-back redemption takes the obligation with it, and there is no second
write to a queue that could disagree with the first.

The worker scans once a minute. **Nothing is sent from a request handler** — `test` writes a row and
returns 202. A source scan asserts `transport.ts` is the only file under `src/server` holding an HTTP
client and that nothing under `src/app/` imports it or the runner.

Retries: network/timeout/429/5xx retried, 4xx and 3xx and TLS refused, **unsafe address never
retried**, and — after §13.3 — a **missing environment key retried** while an **undecryptable
ciphertext is not**. Five attempts, 1 min → 5 → 25 → ~2 h. A timeout or network error is **never**
recorded as delivered, and the database refuses a row that claims otherwise.

Deliveries are **claimed under a lease** rather than merely read, so two passes cannot dispatch the
same row and a crashed worker strands nothing — §13.1.

---

## 7. Authorization

**Owner only** — stricter than every other screen. A manager keeps `VIEW_INTEGRATIONS` and the event
history and sees **no webhook section at all**; a cashier still gets a 404 for the page. Refused in
the service, at the route, and by the screen not rendering. No permission was added or changed.

---

## 8. Every database rule was watched fail

| protection removed | red of 37 |
|---|---|
| `webhook_destination_guard` | 5 |
| `webhook_delivery_guard` | 10 |
| `webhook_attempt_validate` | 5 |
| attempt append-only triggers | 1 |
| no-removal triggers | 2 |
| only the cross-tenant rule | 1 |
| only "delivered means 2xx" | 1 |
| only the attempt-counter rule | 1 |
| only "unsafe is permanent" | 1 |
| only the secret/disclosure pairing | 1 |
| the ciphertext-shape CHECKs | 3 |
| the host-shape CHECKs | 1 |
| the test-xor-event CHECK | 1 |
| the one-delivery-per-event index | 1 |

Each restored and the suite re-run green (37 passed).

---

## 9. Verification

Everything below ran locally, against local PostgreSQL in Docker and a **local HTTPS receiver this
suite starts and stops**.

| Check | Result |
|---|---|
| `node scripts/gate.mjs` | **PASS 15/15**, 662.6s |
| `npx playwright test` — run 1 | **118 passed**, 3.8m |
| `npx playwright test` — run 2 | **118 passed**, 3.6m |
| `npx vitest run` | **96 files, 1365 tests passed** — see §9a |
| `npm audit` / `--omit=dev` | 0 vulnerabilities each |
| `node scripts/db-migrate.mjs status` | **15** migrations, up to date |
| `prisma migrate diff` | one pre-existing naming difference, unchanged |
| `git diff --check` | clean |
| `git status --porcelain public/` | **0** |
| Secret scan over every changed file | clean |
| Raw-capability scan | clean — §9b |
| Control bytes in tracked source | none |

New tests: `webhook-crypto` 17, `webhook-address` 22, `webhook-boundary` 15, `webhooks` 23,
`webhook-delivery` 18, `webhook-integrity` 37, `webhooks-ui` 14.

### 9a. One unreproduced flake, reported rather than buried

The **first** full `vitest run` of this work reported `1 failed | 1364 passed`. I piped that run
through `tail`, so the failing test's name was not captured — my mistake.

It did not reproduce in: three subsequent full `vitest run`s (1365 passed each), the gate's own
integration pass, or three consecutive targeted runs of the three new webhook suites (78 passed
each). At the time I could not name it and said so. **It is now diagnosed** — see §13.8: it was machine
starvation from a concurrently running Docker-building gate, not a product defect, and it reproduced
and was confirmed in the next round.

### 9b. The raw-capability scan

1. **Columns** — the three webhook tables hold no URL, body, header, error text, customer, card,
   phone, email, coupon code, wallet payload or amount. Asserted as an exact column list, then again
   by pattern.
2. **Outbound HTTP** — one file under `src/server`: `webhooks/transport.ts`.
3. **Request handlers** — nothing under `src/app/` imports the transport or the runner; no
   server-side `fetch` in any non-client app file.
4. **Providers** — no SDK import anywhere in the webhook modules.
5. **Secrets** — no URL, API key, token, SMTP setting, HMAC or `process.env` in the events module;
   the crypto module reads exactly one variable by name.
6. **Logging** — no `console.*` or `process.stdout` anywhere under `src/server/integrations/`.
7. **Key values** — `git grep` finds the variable NAME in four tracked files and **no value
   anywhere**. The browser suite generates a throwaway key per run in `scripts/e2e-server.mjs`.
8. **B7** — `src/proxy.ts`, `/api/enroll` and `public/` are byte-identical.

### 9c. What was NOT tested, and is not claimed

- **Nothing was deployed.** Not to staging, not to OCI, not to Freebuff.
- **No real endpoint, provider, device, wallet, POS or staging service was contacted.** The only
  server any test talked to is a local HTTPS receiver on loopback with a certificate generated in the
  fixture.
- **No provider account was opened and no credential obtained.** `INTEGRATION_ENCRYPTION_KEY` has no
  value in this repository; provisioning it is Freebuff's step, after review.
- **TLS against a real certificate authority is unexercised.** The tests trust a self-signed
  certificate deliberately, so certificate verification is exercised but only against a CA the test
  supplied.
- **Real-world DNS is unexercised.** Every resolution in the tests comes from a function the test
  supplies; the production resolver path has never run against a real name.
- Deliverability, receiver behaviour, and how a real merchant's endpoint responds under load are all
  entirely unverified.

---

## 10. Screenshots inspected

Seven were generated; five were opened and read.

| File | What it shows |
|---|---|
| `desktop-en-webhooks-empty.png` | the at-least-once notice and the empty state, before anything exists |
| `desktop-en-webhooks.png` | a created destination, disabled, with the one-time secret and its warning |
| `desktop-en-webhooks-test.png` | an enabled destination, a queued test, and the corrected top notice |
| `phone-ar-webhooks.png` | Arabic at phone width, right-aligned throughout |
| `desktop-ar-webhooks.png` | Arabic desktop: nav on the right, disabled badge, LTR hostname |

### What a screenshot found

`desktop-en-webhooks.png` showed the Prompt 1 notice still saying *"there is no email, SMS, WhatsApp,
**webhook**, payment or point-of-sale connection here, and **no key that could make one**"* — both
halves made false the moment Prompt 2 shipped. The screen was claiming the opposite of what it now
does.

Corrected in both languages: no named **provider** is connected, and the only thing the product sends
is a signed copy of these events to an address the owner set up themselves. Nothing but reading the
rendered page would have caught it — the strings were internally consistent and every test passed.

---

## 11. Deployment prerequisites, for Freebuff

| | |
|---|---|
| Variable | `INTEGRATION_ENCRYPTION_KEY` |
| Value | **32 bytes**, as 64 hex characters or base64. `openssl rand -hex 32` |
| Scope | **per environment.** Staging and production must not share one |
| Consumers | the **web** process and the **worker** process — both |
| If absent or malformed | webhook configuration and delivery fail closed; everything else is unaffected |
| Rotation | writes a new key version; older rows stay readable, **but no re-encryption tool exists** (D29) |

**It must never be committed, logged, rendered, or embedded in a test.** No value for it exists in
this repository, and none was generated for any environment by this work. `src/server/env.ts` prints
variable names only; the crypto module's errors name the variable and never the value, asserted by a
test that checks not even an eight-character prefix appears.

The worker must be running for any webhook to be delivered. Nothing else in the deployment changes:
no Caddy, DNS, TLS, firewall, volume or compose change was made, and `.env.example` is the one
template touched — it documents the name, with an empty value.

---

## 12. Residual risks

1. **A merchant can still point a webhook at a host they do not own**, if they control the name. The
   product checks the address is public, not that the owner is entitled to it. Endpoint verification
   by challenge-response is named as not built (§7a).
2. **The one-millisecond and one-minute seams.** Delivery latency is up to a minute by design; a
   receiver expecting immediacy will be surprised, which the UI says.
3. **A signature proves origin, not freshness.** A receiver that does not check the timestamp can be
   replayed. Stated in §7a's receiver responsibilities; it is the receiver's to implement.
4. **Key rotation is not operationally complete** (D29). Rotating today makes existing destinations
   undecryptable — which fails closed and leaks nothing, but stops delivery until each destination is
   recreated.
5. **No retention rule** (D30). Deliveries and attempts accumulate.
6. **The address policy is a seam.** It defaults to the real rule and no production caller overrides
   it, asserted by a source scan — but it is a parameter, and a future caller could pass one.
7. **Five destinations per business**, a code constant, because every enabled one is a fan-out inside
   the till's transaction.
8. **Nothing here has been seen by a real merchant or a real receiver.**

---

## 13. Review hardening — three operational gaps

`9695e17` was reviewed and three gaps in delivery were found. All three are fixed. Migration 15 had
not reached staging, so `20260921120000_webhook_destinations` was **amended**; the count stays at
**15**, and no earlier migration, `master`, `public/`, Caddy, DNS, TLS, firewall, compose
configuration or non-webhook behaviour was touched.

### 13.1 The claim was a read, so two passes could both send

`claimDue` used `findMany`, dispatched, and only then wrote the attempt. Two workers — or two
overlapping passes of one worker, which a slow batch makes likely — could read the same row before
either wrote, and both would send. The receiver got the webhook twice and the attempt history
disagreed with itself.

**The lease.** Three columns (`claimedAt`, `leaseExpiresAt`, `claimToken`), taken by one statement:

```sql
UPDATE "WebhookDelivery" SET "claimedAt" = …, "leaseExpiresAt" = …, "claimToken" = …
 WHERE "id" IN (SELECT "id" FROM "WebhookDelivery"
                 WHERE "status" = 'PENDING' AND "nextAttemptAt" <= $now
                   AND ("leaseExpiresAt" IS NULL OR "leaseExpiresAt" <= $now)
                 ORDER BY "nextAttemptAt" FOR UPDATE SKIP LOCKED LIMIT $n)
RETURNING "id"
```

One statement, so there is no window in which a row is chosen but not claimed. `SKIP LOCKED` means a
second pass steps over rows the first is taking. The `leaseExpiresAt` predicate is what makes a
**crash** recoverable: a worker that dies holding a claim leaves the row untouched, and once the
lease passes it is work again.

Every write afterwards carries `AND "claimToken" = $token`. A worker slow enough to lose its lease
finds zero rows affected, writes **no attempt**, and does not trample whoever took the row next.

Batch size went from 25 to 10, so the worst case (ten requests at the five-second transport timeout)
sits well inside the five-minute lease.

**At-least-once is unchanged and unavoidable**, and is documented as such: a process that dies after
the request reached the receiver but before the outcome was written will retry. A socket and a
database transaction do not commit together.

The lease holds two timestamps and a uuid, constrained to that shape. **No URL, body, secret,
response or error text.**

### 13.2 The disabled/test matrix disagreed with itself

The screen offered a test button on a disabled destination, the service queued it, the trigger
allowed it — and the worker refused every non-`ENABLED` dispatch, so it silently never sent. Worse,
it refused it as `UNSAFE_ADDRESS`, which made "I switched it off" look like an attempted SSRF in the
owner's history.

One table now, and four layers agree on it:

| destination state | a real `IntegrationEvent` | an owner-triggered synthetic test |
|---|---|---|
| `DISABLED` | **never** | **yes** |
| `ENABLED` | yes | yes |
| `REVOKED` | **never** | **never** |

A new error class, `DESTINATION_NOT_ELIGIBLE`, separates an ordinary lifecycle refusal from an
address that was actually dangerous. Tested three ways: disabled-test succeeds, disabled-real is
refused and the receiver sees nothing, revoked-test is refused.

### 13.3 A brief key outage discarded everything

A missing `INTEGRATION_ENCRYPTION_KEY` was permanent, so every queued delivery was refused for good
because a variable was unset for five minutes.

| condition | now |
|---|---|
| key absent or malformed | **RETRYABLE**, bounded by the normal cap, settling `FAILED` only if nobody fixes it |
| ciphertext will not decrypt under a key that IS present | **PERMANENT** — waiting cannot make a row decrypt |

Neither sends anything. **The database enforces both directions**: an attempt recording an
unavailable key as permanent is refused, and one recording a decryption failure as retryable is
refused.

Tested: a key removed for one pass then restored delivers on the next; a key never restored exhausts
to `FAILED` at the cap; a destination whose ciphertext was written under a different key is refused
permanently on the first attempt and the receiver is never contacted.

*On that last test:* it uses a wrong-key ciphertext rather than editing an existing row, because
`webhook_destination_guard` freezes the endpoint and refuses the edit — which is itself the
protection working. `decryptSecret` cannot tell the two apart by design, so it exercises the same
path.

### 13.4 The cutover, and the boundary it cannot cross

The destination's state is re-read before dispatch. **As written in `76edaee` that read was per
BATCH, not per delivery** — a later review found the gap and §14 closes it; what follows describes
the corrected behaviour.

**What that cannot do is unsend a request already on the wire.** If the owner's disable commits after
the body has gone to the socket, the receiver gets it. The window is milliseconds and it is
unavoidable. The same is true of signing-secret rotation: a request already in flight was signed with
the old secret. Both are written into §7a of the matrix rather than promised away.

### 13.5 The owner's wording

The destination row now carries the most recent attempt's category, rendered in operational words
with **no cryptographic detail**:

- *"Paused: this server is missing a setting it needs before it can send. An administrator can
  restore it, and anything waiting will be tried again."*
- *"This destination's saved settings can no longer be read. Create a new destination and remove
  this one."*

No algorithm, no key version, no mention of which value failed — and the two states the review asked
to be distinguishable read as clearly different situations.

### 13.6 Every new rule was watched fail

| protection removed | red of 49 |
|---|---|
| the three lease CHECKs | 3 |
| the attempt-count cap CHECK | 1 |
| "a new delivery is unclaimed" | 1 |
| "a settled delivery holds no claim" | 1 |
| "PENDING at the cap is invalid" | 1 |
| "a permanent class is never FAILED" | 2 |
| "the three permanent classes are PERMANENT" | 2 |
| "an unavailable key is RETRYABLE" | 1 |

Each restored and the suite re-run green.

### 13.7 The quality bar, re-run in full

| Check | Result |
|---|---|
| `node scripts/gate.mjs` | **PASS 15/15**, 685.5s |
| `npx playwright test` — run 1 | **120 passed**, 4.0m |
| `npx playwright test` — run 2 | **120 passed**, 3.9m |
| `npx vitest run` | **96 files, 1388 tests passed**, 576.5s — see §13.8 |
| `npm audit` / `--omit=dev` | 0 vulnerabilities each |
| `node scripts/db-migrate.mjs status` | **15** migrations, up to date |
| `prisma migrate diff` | unchanged — the same pre-existing `ConsentRecord` naming |
| `git diff --check` | clean |
| `git status --porcelain public/` | **0** |
| Secret / raw-capability / control-byte scans | clean |
| Screenshot | `desktop-en-webhooks-disabled-test.png` read |

Webhook suites after the fixes: `webhook-crypto` 17, `webhook-address` 22, `webhook-boundary` 15,
`webhooks` 23, `webhook-delivery` **29**, `webhook-integrity` **49**, `webhooks-ui` **16**.

### 13.8 The earlier flake, finally identified

§9a of this file recorded an unreproduced single-test failure from the previous round that I could
not name. **It reproduced this round, and it is now diagnosed.**

A full `vitest run` reported `2 failed | 1386 passed` with two tests in
`customer-card-page.test.ts` showing durations of **70 and 77 minutes**, against a whole-run duration
of **9378s** — sixteen times the normal 576s. Those are not logic failures; they are a starved event
loop. A backgrounded gate run (Docker image builds) was still competing for the machine.

Confirmed: that file passes alone three times in ~15s each, and a full run on an idle machine passes
**1388 of 1388 in 576s**. The earlier unnamed flake was the same cause.

**This is a harness/environment observation, not a product defect**, and it is recorded here so
nobody re-discovers it as a mystery. It does mean a full Vitest run and a Docker-building gate should
not be run concurrently on one machine.

---

## 14. Review hardening — the dispatch boundary

`9282fa2` was reviewed and one gap was found, correctly: the per-delivery cutover §13.4 described
did not exist. Fixed in **`35b6ab2`**. **No migration and no schema change** — everything needed was
already on the row, so migration 15 was not amended and the count stays at **15**.

### 14.1 What was wrong

`runDueDeliveries` called `loadClaimed(ids, token)` **once for the whole claimed batch**, before the
loop. `attemptOne` then worked from that snapshot: `destinationState`, `endpointCipher` and
`signingSecretCipher` were all as they had been when the batch was claimed.

So the comment above it — *"The destination's state is re-read under the claim, immediately before
dispatch"* — was **false**, and §13.4 of this file repeated it. A batch read cannot be an immediate
pre-dispatch read; those are different moments by definition.

The practical consequence: with ten claimed and the first slow, an owner could disable or revoke the
tenth destination and the tenth delivery would still dispatch on a stale `ENABLED`, and sign with a
stale secret if they had rotated it. The stale window was as long as every earlier delivery took —
with a five-second transport timeout each, most of a minute.

### 14.2 What it is now

`loadForDispatch(id, token)` runs **inside the loop, once per delivery, immediately before that
delivery is sent**, and returns:

- the **current** destination state,
- the **current** endpoint and signing-secret ciphertexts,
- the **current** event.

The **claim token is in the `WHERE`**. A row re-claimed by another pass while this one was slow comes
back `null`: the delivery is skipped, **no request is made and no attempt is recorded**, because this
pass is no longer describing its own work. The run summary gained a `skipped` count so that is
visible rather than silent.

The cost is one indexed primary-key read per delivery, against an outbound HTTP request. That is the
difference between a promise the code keeps and one it only makes.

### 14.3 A second bug, found while writing the tests

`UPDATE … RETURNING` emits rows in whatever order it updated them — PostgreSQL does not specify it.
So the `ORDER BY "nextAttemptAt"` inside the claim's sub-select was deciding **which** rows to take
and **not** the order they came back in. Oldest-first was the intent and was not happening.

The claim is now wrapped in a CTE that orders the ids on the way out. It also makes the interleaving
tests deterministic — without it, which delivery goes first is a coin toss, and a test that depends
on a coin toss lies when it is green.

### 14.4 The tests

Five, each claiming **two** deliveries and committing a change while the first is on the wire. The
change is made inside the first delivery's `send`, keyed on the delivery id rather than a counter,
so it is committed before the second delivery's read **by construction, not by timing**.

| test | proves |
|---|---|
| disable the second destination mid-batch | the second sees `DISABLED`; as a synthetic test it is still allowed, which is the rule |
| revoke the second destination mid-batch | **nothing is sent** — not even a test; `DESTINATION_NOT_ELIGIBLE`, `REFUSED`, one request total |
| disable a destination with a **real** event queued | no request; `DESTINATION_NOT_ELIGIBLE` |
| rotate the second destination's secret mid-batch | its request verifies against the **new** secret and not the old |
| another pass steals the second claim mid-batch | skipped: no request, `attemptCount` 0, no attempt row |

**Red-proved.** Restoring the batch-snapshot loop turns **four of the five red**. The fifth is the
disabled-test case, which is legitimately allowed under both implementations — and saying so is more
useful than pretending all five depend on the fix.

### 14.5 The boundary that remains

A request already on the wire cannot be unsent. The window is now between that per-delivery read and
the moment the socket accepts the body — **microseconds**, where before the fix it was up to most of
a minute. Irreducible: a TCP connection and a database transaction do not commit together.

The same applies to secret rotation: every delivery whose pre-dispatch read happens after the
rotation commits signs with the new secret; one already on the wire was signed with the old. Stated
in §7a of the matrix, and not promised away.

### 14.6 The quality bar, re-run in full

| Check | Result |
|---|---|
| `node scripts/gate.mjs` | **PASS 15/15**, 623.0s |
| `npx playwright test` — run 1 | **120 passed**, 3.6m |
| `npx playwright test` — run 2 | **120 passed**, 3.2m |
| `npx vitest run` | **96 files, 1393 tests passed**, 510.8s |
| `npm audit` / `--omit=dev` | 0 vulnerabilities each |
| `node scripts/db-migrate.mjs status` | **15** migrations, up to date |
| `prisma migrate diff` | unchanged — the same pre-existing `ConsentRecord` naming |
| `git diff --stat` over `prisma/` | **empty** — no migration or schema change this round |
| `git diff --check` | clean |
| `git status --porcelain public/` | **0** |
| Secret / raw-capability / control-byte scans | clean |
| `INTEGRATION_ENCRYPTION_KEY` value anywhere | **none** |

`webhook-delivery` is now **34** tests.

---

## 15. Which SHA to deploy

The tip of `rebuild/phase-0-foundation` — the documentation commit carrying this file, which
contains `770f324`, `9695e17` and the review-fix commit. The final report names the exact hash; a
file cannot name the commit it is part of.

**Neither `9695e17` nor `9282fa2` may be deployed.**

`9695e17` can send a webhook twice under overlapping worker passes, silently never sends the test a
disabled destination's own screen offers, and permanently discards every queued delivery if the
encryption key is briefly unset.

`9282fa2` fixes those three, and still dispatches later deliveries in a batch against a stale
destination state — so a destination disabled or revoked while an earlier delivery was in flight
could still receive one, for up to most of a minute. It also carries a comment and a paragraph in
this file asserting a cutover that did not exist, which is the worse half: a wrong guarantee written
down is one somebody relies on.

Neither has been applied anywhere.

`master` is untouched at `b9ee686`. Staging is Freebuff's after independent review, and nothing in
this report claims a staging, provider, device, POS, wallet or external-network test was performed.
