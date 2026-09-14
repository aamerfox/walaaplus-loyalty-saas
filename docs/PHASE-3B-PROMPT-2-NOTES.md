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
transaction**. The worker scans for due rows once a minute, decrypts the URL, re-resolves the
hostname, connects only to an address validated in that instant, posts the signed envelope, and
records an outcome. Nothing is sent from a request handler; nothing is retried that should not be.

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
is that the worker looks for work rather than being handed it: a `WHERE status = 'PENDING' AND
nextAttemptAt <= now()` against a partial index, once a minute. That latency is on the owner's
screen rather than left to be discovered.

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
| encryption key missing or malformed | no — a retry cannot fix a deployment |

Five attempts, backing off 1 min → 5 → 25 → ~2 h. A timeout or network error is **never** recorded as
delivered, and the database refuses a row that claims otherwise.

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

## 9. A pre-existing defect found on the way

The widened control-character scan found a literal **backspace byte** in
`tests/integration/customer-card-page.test.ts`, sitting where a word-boundary escape was meant. The
assertion had been passing for a reason unrelated to what it claimed to check. Corrected, and the
encoding guard now covers every control byte rather than only NUL.
