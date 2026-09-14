# Phase 3B, Prompt 2 — secure custom outbound webhooks and controlled delivery

**Branch** `rebuild/phase-0-foundation` · **baseline** `e34e765` · **local only, nothing deployed**

| | |
|---|---|
| Code, migration and tests | `770f324` |
| Documentation | the commit carrying this file |
| **Deploy this** | the tip of `rebuild/phase-0-foundation` |
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
retried**, missing key never retried. Five attempts, 1 min → 5 → 25 → ~2 h. A timeout or network
error is **never** recorded as delivered, and the database refuses a row that claims otherwise.

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
each). **I cannot name it**, and I am not claiming four clean runs when the first was not. The most
plausible candidate is a timing-sensitive delivery test — the timeout case waits on a 5-second
transport timeout — but that is a hypothesis, not a diagnosis.

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

## 13. Which SHA to deploy

The tip of `rebuild/phase-0-foundation` — the documentation commit carrying this file, which contains
`770f324`. The final report names the exact hash; a file cannot name the commit it is part of.

`master` is untouched at `b9ee686`. Staging is Freebuff's after independent review, and nothing in
this report claims a staging, provider, device, POS, wallet or external-network test was performed.
