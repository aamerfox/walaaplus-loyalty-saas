# Phase 3B Prompt 2 — implementation notes

Prompt 1 built the internal record and nothing that could publish it. Prompt 2 opens **one door**: a
custom outbound webhook to a URL the owner typed.

No named provider is connected. No email, SMS, WhatsApp, Meta, Google, Stripe, PayPal or POS
integration exists, and none of §§2–6 of the capability matrix moved a bucket. What exists is a
signed POST to a merchant's own server, and every lock the matrix's §7a says it needs.

---

## 1. The shape, in one paragraph

The owner types an HTTPS URL. It is validated, encrypted and stored **disabled**. When they enable
it, every subsequent `IntegrationEvent` also writes a `WebhookDelivery` row **in the same
transaction**. The worker **claims** due rows atomically under a lease, re-reads the destination's
state, decrypts the URL, re-resolves the hostname, connects only to an address validated in that
instant, posts the signed envelope, and records an outcome. Nothing is sent from a request handler;
nothing is retried that should not be.

---

## 2. Encryption, and why there is no fallback

`AES-256-GCM`, a fresh 96-bit nonce per value, algorithm and key version in their own columns, and
the envelope `v1.<nonce>.<tag>.<ciphertext>` in base64url.

Two things are encrypted: the **URL** — which may carry a path or query token the receiver treats as
authentication — and the **signing secret**. The name and the hostname are plaintext, because the
owner has to read their own list and neither is a credential.

**There is no plaintext mode.** Not in development, not behind a flag, not when the key is missing.
`encryptSecret` has exactly two outcomes: ciphertext, or `EncryptionUnavailableError`. A unit test
asserts there is no source and no argument combination that returns the plaintext.

### The database enforces the same thing

A CHECK constraint requires four dot-separated base64url parts with an **exact** 16-character nonce
and 22-character tag. A plaintext URL cannot satisfy it, so there is no path by which one is stored
by accident — and a truncated tag, which is how an authenticated cipher quietly stops
authenticating, is refused too.

### Fail closed, and only here

Without `INTEGRATION_ENCRYPTION_KEY`, webhook configuration and delivery refuse. **Nothing else
notices**: enrolment, stamps, points, redemptions, referrals, consent, campaigns, the scanner, B7 and
the worker's `/health` do not import the crypto module. There is an integration test that removes the
key and then redeems a coupon at the till successfully.

`src/server/env.ts` takes the variable as an **optional, unvalidated string**, deliberately. Checking
its format at boot would mean a mistyped key stops the till over a feature nobody had configured. The
authority is the crypto module, at the moment the value is needed.

---

## 3. SSRF, and the check that actually matters

Validating the URL when the owner saves it proves nothing later: the same hostname can resolve to a
public address then and to `10.0.0.1` a second afterwards. That is **DNS rebinding**, and it is not
exotic — it is a TTL of zero and a cooperative resolver.

So there are two checks, and the important one is at connection time:

| | |
|---|---|
| `assertSafeWebhookUrl` | the shape. HTTPS only, no user-info, no IP literal, no loopback or private name, no single-label host, no control characters. Runs on save **and again before every request** |
| `makeGuardedLookup` | resolves, validates **every** answer, and returns only an address that has just passed. Handed to Node as the agent's `lookup`, so the socket connects to the address that was checked |

The second is the whole defence. A design that resolved, validated, then connected by hostname would
re-resolve inside the agent and could get a different answer. The `lookup` hook makes the check and
the connection the same decision.

If **any** answer is private, the whole resolution is refused — a name that returns one public
address and one `10.0.0.1` is an attempt, and picking the public one would leave the next resolution
free to pick the other.

**Redirects are not followed.** A 200 from a validated host that redirects to `169.254.169.254` is
the classic bypass, so a 3xx is an outcome, not a hop.

### A bug this caught

Node calls a custom `lookup` with `{ all: true }` whenever Happy Eyeballs is on — the default since
Node 20 — and then expects an **array**. Answering with a bare string produces
`ERR_INVALID_IP_ADDRESS: undefined`, which looks like a DNS problem and is not one. Both shapes are
honoured now, and a unit test covers the array form specifically.

### An honest note about the test seam

The local HTTPS receiver the delivery tests talk to is on loopback, and the address policy refuses
loopback — correctly and unconditionally, because that is the rule production needs. Rather than
soften the rule, `resolveSafeAddress` takes an `AddressPolicy` whose **default is the rule**. The
tests pass a policy permitting exactly the receiver's address and deferring to the real one for
everything else, so a test resolving to `169.254.169.254` is still refused by production logic.

No production caller passes one, and `webhook-boundary.test.ts` asserts the worker job and the
delivery runner never do.

---

## 4. Signing, and what the receiver has to do

`HMAC-SHA-256` over `"{timestamp}.{body}"`, sent as `X-Walaaplus-Signature: v1=<hex>`.

The timestamp is **inside** the signed string, not only in a header, so a captured body cannot be
replayed under a fresh timestamp — the signature would not cover the new one.

The body is the seven-field `IntegrationEvent` envelope and nothing else: `id`, `envelopeVersion`,
`eventType`, `entityType`, `entityId`, `occurredAt`, `businessId`. Delivery reads no customer, card,
promotion or audit row, because the module imports nothing that could.

Serialisation is a literal with the keys in a fixed order — not `Object.keys().sort()`, which is a
rule somebody can change by renaming a field. The bytes signed are the bytes sent.

### At-least-once, never exactly-once

Stated in the UI in both languages, in the matrix, and here:

> **A receiver may get the same event more than once. It must de-duplicate by event id.**

A request can succeed and its response be lost; the retry then delivers a second copy.
`X-Walaaplus-Event-Id` is stable across every attempt and every destination.

---

## 5. The outbox, and why it is not a queue message

A `WebhookDelivery` row is written in the **same transaction** as the `IntegrationEvent` it carries.
If the redemption rolls back, so does the event, and so does the obligation to tell anybody.

Sending a pg-boss message instead would be a second write that could succeed when the first rolled
back, or fail when it committed — a distributed-transaction problem nobody needs to have. The cost
is that the worker looks for work rather than being handed it, once a minute. That latency is on the
owner's screen rather than left to be discovered.

**The claim is atomic.** One `UPDATE … WHERE id IN (SELECT … FOR UPDATE SKIP LOCKED) RETURNING`
stamps a lease of three columns, so two workers cannot both take a row and a crashed one strands
nothing — §9.1. A batch is ten, so the worst case (ten requests at a five-second timeout) sits well
inside the five-minute lease.

**Each delivery is then read again, on its own, immediately before it is sent** — §9.5. The claim
says which rows are this pass's; the per-delivery read says what is true about one of them right
now.

**A destination enabled after an event exists gets no delivery for it** — the same no-backfill rule
as Prompt 1, one layer out.

---

## 6. Retries

| outcome | retried? |
|---|---|
| network error, connect failure, timeout | yes |
| HTTP 429, 5xx | yes |
| HTTP 4xx other than 429 | no — the receiver has said no |
| 3xx redirect | no — a misconfiguration, and following it is the bypass |
| TLS failure | no — needs a certificate fixed, not time |
| **unsafe URL or resolved address** | **never** |
| destination disabled or revoked before dispatch | no — the owner's decision is not transient |
| **environment key missing or malformed** | **yes**, bounded — an operator fixes it in minutes (§9.3) |
| a stored value that will not decrypt under a present key | no — waiting cannot make a row decrypt |

Five attempts, backing off 1 min → 5 → 25 → ~2 h. A timeout or network error is **never** recorded as
delivered, and the database refuses a row that claims otherwise — as it refuses a permanent class
recorded as retryable, and an unavailable key recorded as permanent.

---

## 7. What the database refuses

Seven triggers across three tables. The ones worth naming:

- a destination **cannot be created enabled**, and its endpoint, host, digest, business and creation
  facts are frozen; `REVOKED` is terminal
- a rotated secret and its disclosure time **move together**, or neither moves — a rotated secret the
  owner never saw would be a row claiming a disclosure that did not happen
- a delivery **cannot name another business's destination or event**, which a foreign key would have
  accepted
- a real delivery **cannot exist for a destination that is not enabled**
- the attempt counter **only rises, and only by one**
- a settled delivery **stays settled**
- `DELIVERED` **requires a 2xx and no error class**
- `UNSAFE_ADDRESS` **can never be a FAILED delivery** — it is refused, never retried to exhaustion
- an attempt's number **must follow its delivery's count**, and its outcome and error class must agree
- attempts are **append-only**; destinations and deliveries are **never deleted**
- the **lease** is three columns that move together, ordered, with a uuid-shaped token; a new
  delivery holds none and a settled one holds none
- the **attempt cap** is a CHECK as well as a code constant, and a delivery left `PENDING` at the cap
  is refused — it would be a row the worker picks up forever

### Two findings from writing the tests

The host CHECK accepted `10.0.0.1`, because digits and dots make a legal-looking hostname. A real
top-level domain always contains a letter, so a second CHECK requires one in the last label. Found by
the integrity test, not by reading the regex.

The column-name scan tripped on `WebhookDestination.name` — the owner's own label for their own
destination. The pattern was looking for a **person's** name and said so badly; it now names the
forms it means.

### Every rule was watched fail

| protection removed | red |
|---|---|
| `webhook_destination_guard` | 5 of 37 |
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

Each restored and re-run green.

---

## 8. Authorization

**Owner only** — stricter than every other screen in this product, and deliberately. A destination is
a standing instruction to send this business's activity to a third party for as long as it exists. A
manager who could create one could arrange for every redemption to be copied somewhere the owner
never looked.

A manager keeps `VIEW_INTEGRATIONS` and the event history. On the integrations page they see that
half and **no webhook section at all** — not an empty list, not a disabled form. A cashier still gets
a 404 for the page.

No permission was added or changed: `EDIT_INTEGRATIONS` already existed and is held only by `OWNER`.

---

## 9. Review hardening — three operational gaps

Found reviewing `9695e17`, before anything was deployed. Migration 15 had not reached staging, so it
was **amended**; the count stays at 15.

### 9.1 The claim was a read

`claimDue` used `findMany`, sent, and only then wrote the attempt. Two workers — or two overlapping
passes of one worker, which a slow batch makes likely — could read the same row before either wrote,
and both would send. The receiver saw the webhook twice and the attempt history disagreed with
itself.

Now: a lease of three columns (`claimedAt`, `leaseExpiresAt`, `claimToken`), taken by a single
`UPDATE … WHERE id IN (SELECT … FOR UPDATE SKIP LOCKED) RETURNING`. One statement, so there is no
window in which a row is chosen but not claimed. The lease expires, so a crashed worker strands
nothing. Every write afterwards carries `AND "claimToken" = $token`, so a worker that lost its lease
writes nothing rather than trampling whoever took the row next.

Batch size dropped from 25 to 10 so the worst-case pass (ten requests at a five-second timeout) sits
comfortably inside the five-minute lease.

**At-least-once is unchanged and unavoidable**: a process that dies after the request reached the
receiver but before the outcome was written will retry.

### 9.2 The disabled/test matrix disagreed with itself

The screen offered a test button on a disabled destination, the service queued it, the trigger
allowed it — and the worker refused every non-`ENABLED` dispatch, so it silently never sent. Worse,
it refused it as `UNSAFE_ADDRESS`, which made "I switched it off" look like an attempted SSRF in the
owner's history.

Now there is one table (§7a of the matrix) and four layers agree on it. A new error class,
`DESTINATION_NOT_ELIGIBLE`, separates an ordinary lifecycle refusal from an address that was
actually dangerous.

### 9.3 A brief key outage discarded everything

A missing `INTEGRATION_ENCRYPTION_KEY` was permanent, so every queued delivery was refused for good
because a variable was unset for five minutes.

Now: **unavailable key → retryable**, bounded by the normal cap, settling `FAILED` only if nobody
fixes it. **Undecryptable ciphertext under a present key → permanent**, because waiting cannot make a
row decrypt. Neither sends anything, and the database enforces both directions — an attempt
recording an unavailable key as permanent is refused, and one recording a decryption failure as
retryable is refused.

The owner's screen says which is which in operational words: *"Paused: this server is missing a
setting it needs before it can send"* versus *"This destination's saved settings can no longer be
read"*. No algorithm, no key version, no mention of which value failed.

### 9.4 Each new rule was watched fail

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

---

### 9.5 The dispatch read was per batch, and the comment said otherwise

`loadClaimed(ids, token)` ran once for the whole claimed batch, before the loop, and `attemptOne`
used that snapshot. The comment above it said the destination's state was "re-read under the claim,
immediately before dispatch". **It was not, and a batch read cannot be.**

With ten claimed and the first slow, an owner could disable or revoke the tenth destination and the
tenth delivery would still dispatch against a stale `ENABLED` — and sign with a stale secret if they
had rotated it. The stale window was as long as every earlier delivery took.

Now `loadForDispatch(id, token)` runs **inside the loop, per delivery**, and returns the current
destination state, the current ciphertexts and the current event. The claim token is in the `WHERE`,
so a row re-claimed by another pass comes back empty and is skipped with no request and no attempt.

**A second bug fell out of writing the tests.** `UPDATE … RETURNING` emits rows in whatever order it
updated them — PostgreSQL does not specify it — so the `ORDER BY nextAttemptAt` inside the claim's
sub-select was choosing *which* rows to take and not the order they came back in. Oldest-first was
the intent and was not being honoured. The claim is now wrapped in a CTE that orders the ids on the
way out; without that, an interleaving test cannot be deterministic either.

Five deterministic tests, each claiming two deliveries and committing a change while the first is on
the wire. **Four of the five go red** against the restored batch-snapshot implementation; the fifth
is the disabled-test case, which is allowed either way by design.

The one remaining boundary is now microseconds rather than most of a minute: a request already on
the wire cannot be unsent. That is stated, not promised away.

---

## 10. A pre-existing defect found on the way

The widened control-character scan found a literal **backspace byte** in
`tests/integration/customer-card-page.test.ts`, sitting where a word-boundary escape was meant. The
assertion had been passing for a reason unrelated to what it claimed to check. Corrected, and the
encoding guard now covers every control byte rather than only NUL.
