# Integrations — capability audit

Written **before** the Phase 3B Prompt 1 implementation and used to constrain it, and extended
**before** Prompt 2 with §7a, the webhook security and decision record. Every row below was decided
first; the code that followed builds the "Supported now" column and nothing else.

The shape of Prompt 1 in one sentence: **the product records, in its own database, that something
happened.** Prompt 2 adds the one way that record may leave: **a custom outbound webhook to a URL
the owner typed, signed, and nothing else.** No named provider is connected, and none of §§2–6 moved
a bucket.

---

## 0. The sentence this document exists to prevent

> *"We integrate with Twilio, SendGrid, Stripe, WhatsApp and your POS."*

A provider logo on a settings screen is not an integration. Neither is a card that says
**Connect**, a field that accepts an API key, or a row in a features table. An integration is a
credential somebody obtained, an account somebody pays for, a contract somebody agreed to, a network
path that reaches the provider, a retry policy for when it does not, and a record of what was
actually delivered.

This phase has **none** of those, and the product must not imply otherwise. Nothing in this codebase
after Phase 3B Prompt 1 can send an email, a message, a webhook or a payment, and there is no screen
that suggests it can.

Four buckets, used consistently:

| bucket | means |
|---|---|
| **Supported now** | built in this phase, testable locally, with no provider, credential, account or network |
| **Foundation now, provider later** | the internal half exists and is real; the provider half needs a credential, an account or a configuration decision nobody has made |
| **Needs approval, contract or account** | blocked on a provider's review, a legal or commercial decision, or an external account somebody must open and pay for |
| **Unsuitable / out of scope** | ruled out by B7, by privacy, by sanctions and market reality, or because it would make this phase something else |

---

## 1. What this prompt actually builds

| capability | bucket | notes |
|---|---|---|
| A tenant-isolated, append-only **internal event record** | **Supported now** | `IntegrationEvent`. One row per completed promotion redemption and per void. Nothing reads it but an owner or manager, and nothing delivers it. |
| A **versioned envelope** | **Supported now** | `envelopeVersion` is on every row and is `1`. A future consumer that cannot read a version it does not know is a consumer that fails safely; one that guesses is a consumer that mis-delivers. |
| Events written **in the same transaction** as the action | **Supported now, and enforced by the database** | No event for an action that failed, and no action that survives a failed event — proved by making the event insert throw and asserting the redemption is not there. And no event for an action that finished earlier: the trigger requires the event's `occurredAt` to equal the redemption's `recordedAt`, which is true only inside one transaction. See §7. |
| Append-only at the **grant** level and the **trigger** level | **Supported now** | Runtime role holds `SELECT`, `INSERT`. Triggers refuse `UPDATE`, `DELETE`, `TRUNCATE` even for the owner. |
| Semantic integrity enforced **in the database** | **Supported now** | The referenced entity must exist, belong to the same business, and be of the kind the event type claims. A direct writer with no service in the way cannot forge a row. |
| An owner/manager **read view** | **Supported now** | `/business/integrations`. Internal ids, types and times. **404 for a cashier.** |
| Anything that leaves the machine | **Was the defining exclusion of Prompt 1** | Prompt 2 opens exactly one door, to one kind of destination, under the rules in §7a. |

### What Prompt 2 adds

| capability | bucket | notes |
|---|---|---|
| **Custom outbound webhook** to an owner-supplied HTTPS URL | **Supported now** | The only outbound capability in the product. Carries the `IntegrationEvent` envelope and nothing else. |
| Owner-only destination management | **Supported now** | Create, rotate, enable, disable, revoke, test. A manager and a cashier can do none of it and cannot see that the screen exists. |
| **AES-256-GCM** encryption of the URL and the signing secret at rest | **Supported now** | `INTEGRATION_ENCRYPTION_KEY`, random 96-bit nonce per value, algorithm and key version stored explicitly. **No plaintext fallback.** |
| **HMAC-SHA-256** request signing | **Supported now** | Over `timestamp.body`, so a captured body cannot be replayed under a new timestamp. |
| SSRF and DNS-rebinding defence | **Supported now** | §7a. Re-resolved immediately before every request; the socket connects only to an address that was validated in that moment. |
| Bounded retries with exponential backoff | **Supported now** | Transient failures only. An unsafe-URL refusal is never retried. |
| A durable, tenant-isolated delivery record and an append-only attempt history | **Supported now** | Outcome category, HTTP status and a bounded error class. **No body, no headers, no URL, no error text.** |
| Delivery from a request handler | **Out of scope, structurally** | The only HTTP client in the product lives in the worker's delivery module, and a source scan asserts nothing under `src/app/` imports it. |
| Inbound webhooks, public webhook creation, public API tokens | **Out of scope** | Unchanged from Prompt 1. |

---

## 2. Email

| family | bucket | notes |
|---|---|---|
| **Custom SMTP** | **Needs account and deployment decision** | Needs a host, port, username, password and a TLS mode — five values, four of which are secret. This phase adds **no secrets table, no encryption key and no environment variable**; where those live, and who may see them, is an explicit owner and deployment decision (§8). |
| **SendGrid** | **Needs account** | API key, verified sender identity, domain authentication (SPF/DKIM records the owner must add to DNS — which this phase may not touch). Availability from the target market is unverified. |
| **Mailgun** | **Needs account** | Same shape. Region matters: EU and US endpoints are different base URLs and a sending domain belongs to one of them. |
| **Resend** | **Needs account** | Same shape; simplest of the three to start, and the least proven for high-volume transactional Arabic mail. |
| Transactional email at all (password reset) | **Foundation now, provider later** | **D3** has been open since Phase 0. The product still has no way to send a password-reset email, and says so rather than shipping a reset flow that silently does nothing. |
| Marketing email to a segment | **Foundation now, provider later** | The draft, the revisions, the approval and the frozen audience all exist (Phase 2). `src/server/campaigns/delivery.ts` is the named place delivery will arrive and its only implementation refuses. |

**None of these may be started without answering: who owns the account, who pays, which domain
sends, and where the key is stored.** The last of those is a deployment change this phase may not
make.

---

## 3. SMS and messaging

| family | bucket | notes |
|---|---|---|
| **Twilio SMS** | **Unsuitable for the launch market, as far as is known** | **D2** since Phase 0. Twilio's coverage for Syria is the open question and it has never been verified from inside this project. Building against Twilio before that is answered risks building the wrong adapter entirely. |
| SMS by any provider | **Needs commercial decision** | A regional aggregator is the likely answer and none has been chosen. Sender-ID registration is a separate, slow, per-country process. |
| **WhatsApp** (Business Platform) | **Needs Meta approval, contract and account** | A Meta Business account, a verified business, a WhatsApp Business Account, a registered number that is not already on consumer WhatsApp, and **template messages approved by Meta one at a time**. Per-conversation pricing. The product's placeholder grammar is not Meta's; the two would have to be reconciled. |
| **Facebook Messenger** | **Needs Meta approval and a Page** | Requires a Facebook Page, a Page access token, and App Review for `pages_messaging`. Messenger's 24-hour window rules mean most useful sends are message tags, which are themselves policy-reviewed. Note this is also why Phase 3A shipped no Messenger share button: its web dialog needs a registered app id. |
| **Telegram Bot** | **Foundation now, provider later** | Genuinely the least encumbered: a bot token from BotFather, no review, no contract. **But it can only message a user who started the chat**, so it is not a channel for reaching customers — it is a channel for reaching *staff*. Worth building for that, honestly labelled. |
| **Telegram Report Bot** (a daily/weekly digest to the merchant) | **Foundation now, provider later** | The same token, aimed at the owner rather than the customer. This is the single most plausible first outbound integration in the whole document: the recipient is the person who set it up, consent is not in question, and there is no per-message cost. It still needs the token stored somewhere (§8). |
| Any of the above without routing through the consent contract | **Out of scope** | A message to a customer is a message. The product has one consent scope, `MARKETING`, an append-only history, and a rule that an unknown answer is not a yes. A channel that skipped it would be a side door around it. |

---

## 4. Advertising, analytics and business listings

| family | bucket | notes |
|---|---|---|
| **Google Business API** (reviews, posts, hours) | **Needs account and OAuth** | A Google Cloud project, OAuth consent screen verification, and the merchant's own verified Business Profile. The useful capability — soliciting reviews — is a *message to a customer*, so it lands back in §3's consent rule. |
| **Google Tag Manager** | **Unsuitable / out of scope** | GTM is a container that loads arbitrary third-party JavaScript decided after deployment. On a page that shows a customer's name, card and balance, that is a data-exfiltration vector with a friendly name. `tests/unit/*` already assert no third-party script origin loads on any surface, and the browser suite re-checks it against the page's own origin. |
| **Meta Ads** (Pixel, Conversions API) | **Unsuitable / out of scope for customer-facing surfaces** | A pixel on a card page reports a customer's visit to Meta. The Conversions API is server-side and would mean sending customer events to Meta from the backend — which is precisely the thing this phase's event model exists to *not* do. If a merchant wants ad attribution, that belongs on their own marketing site, not on a loyalty card. |
| Any analytics script at all | **Out of scope** | Unchanged from Phase 0. No tracker, no pixel, no session recorder, no error-reporting SaaS. |

---

## 5. Payments

| family | bucket | notes |
|---|---|---|
| **Stripe** | **Unsuitable for the launch market** | **E1** since Phase 0: Stripe does not operate in Syria. Agency billing needs an alternative or a foreign legal entity — which is **E3**, a decision with tax and liability attached. |
| **PayPal** | **Unsuitable for the launch market** | Same reason, same blocking decisions. |
| Any payment at all | **Needs legal and commercial decision** | **E1–E5**. And note what it would mean for this phase: a payment integration puts money in the product, and every safety argument in `PROMOTIONS-CAPABILITY-MATRIX.md` rests on there being none. A redemption records that a customer is *owed* something; a person hands it over. That stays true. |
| Storing a card, a token or a customer's payment identifier | **Out of scope** | PCI scope is not something a loyalty product acquires by accident. |

---

## 6. Affiliate, CRM and point of sale

| family | bucket | notes |
|---|---|---|
| **FirstPromoter** | **Needs account; and a policy decision first** | Affiliate tracking for the *agency* side, not the merchant's customers. It is also the wrong tool to reach for while **D15** — the referral reward policy — is unanswered: Phase 3A built referral *attribution* and deliberately nothing that credits anybody. Wiring an affiliate platform in would answer D15 by accident. |
| **LeadConnector / GoHighLevel** | **Needs marketplace approval and an account** | OAuth install, contact sync, custom fields, SSO menu, workflow actions and triggers. A private app first; a public listing is **E7** and needs explicit owner approval. Contact sync means exporting customer records to a third party, which needs the same privacy, retention and authorization contract that **D7** (customer export) has been waiting on. |
| **POS systems** (Toast, Square, Shopify, Lightspeed, GloriaFood, Altegio, WooCommerce) | **Needs account, approval, and a validated merchant** | Each is a separate marketplace, review process and data model. The reference product exposes accrue and reverse endpoints; ours would have to decide what a POS is allowed to do to an append-only ledger, which is a real design question and not a connector. **At most one validated connector, on demonstrated demand from a real merchant.** |
| Zapier, Make, Pabbly, Integrately, Albato, KonnectzIT | **Deferred** | All of them are reachable through outbound webhooks. Building six adapters instead of one webhook is how an integrations page becomes a graveyard. |

---

## 7. Outbound webhooks and the public API

| capability | bucket | notes |
|---|---|---|
| An internal record that an event happened | **Supported now** | This prompt. `IntegrationEvent`. |
| An endpoint URL a merchant can register | **Supported now (Prompt 2)** | HTTPS only, owner only, validated on save **and again immediately before every request**. §7a. |
| Outbound HTTP | **Supported now, in exactly one module** | `src/server/integrations/webhooks/delivery.ts`, called only by the worker. `src/server/integrations/events.ts` still has no HTTP client, no queue and no timer, and the source scan still asserts it. |
| HMAC request signing | **Supported now (Prompt 2)** | HMAC-SHA-256 over `timestamp.body`, with a per-destination secret revealed once and thereafter stored encrypted. |
| A retry policy and a delivery log | **Supported now (Prompt 2)** | Bounded exponential backoff for transient failures; an append-only attempt history holding outcome, status and error class. A dead letter is a delivery that reached `FAILED`; nothing is deleted. |
| A public API with `X-API-Key` | **Out of scope for this prompt** | Keys are secrets; see §8. Also a rate limiter per key, a response envelope, pagination, and versioning. |
| Event types beyond the two built here | **Out of scope for this prompt** | The reference product has roughly forty. This prompt has **two**, both for a workflow that is already finished and already safe. Adding an event for a workflow is a decision about what that workflow is allowed to tell the outside world. |
| **Backfilling historical events** | **Out of scope, and refused by the database** | No event exists for any redemption or void that happened before this migration, and none can be created afterwards. `occurredAt` is assigned by the trigger, so nobody can date one into the past — and the trigger additionally requires it to **equal the redemption's own `recordedAt`**, which is true exactly when the two rows were written in the same transaction. A writer cannot imitate that by supplying a matching value, because the value it supplies is discarded before it is compared. |

---

## 7a. Webhook security and decision record

Written before Prompt 2 was implemented. Each heading is a decision somebody has to be able to
disagree with later.

### Encryption at rest

A destination holds two values worth stealing: the **URL** (which may carry a path or query token
the receiver treats as authentication) and the **signing secret**. Both are encrypted with
**AES-256-GCM** — authenticated encryption, so a tampered ciphertext fails to decrypt rather than
decrypting to something else.

- **Key**: `INTEGRATION_ENCRYPTION_KEY`, 32 bytes, per environment. Approved by the owner for
  deployment; see §8a for the exact requirement.
- **Nonce**: 96 bits, freshly random per value. Never reused, never derived from the plaintext.
- **Metadata**: the algorithm and the key version are stored in their own columns, not inferred.
  A future key rotation writes version 2 alongside version 1 rows and knows which is which.
- **No fallback.** There is no plaintext mode, no "if the key is missing, store it raw", no
  development shortcut. If the key is absent or malformed, webhook configuration and delivery
  **fail closed** — and nothing else does: enrolment, stamps, points, redemptions, referrals, the
  scanner, B7 and `/health` are all untouched, because none of them imports the crypto module.
- **What is not encrypted**: the destination's name and hostname, which the owner needs to read on
  their own screen, and which are not credentials.

### Signing

`HMAC-SHA-256` over `"{timestamp}.{body}"`, hex, sent as `X-Walaaplus-Signature: v1=…`.

The timestamp is inside the signed string rather than only in a header, so a captured body cannot
be replayed later under a fresh timestamp. Receivers should reject a timestamp far from their own
clock. The scheme is versioned (`v1=`) so a future algorithm can be added without ambiguity.

**A signature proves the body came from this product. It does not prove the body is new** — that is
what the event id is for.

### SSRF and DNS rebinding

A merchant-supplied URL is a request the server makes to an address it was told to trust. The rules,
all enforced:

| rule | why |
|---|---|
| **HTTPS only** | plaintext would expose the signed body and the URL's own path token |
| no user-info in the URL (`https://user:pass@host/`) | credentials in a URL end up in logs and in error strings |
| no IP-literal host | a hostname can be checked against DNS policy; a literal bypasses the question |
| no `localhost`, `*.localhost`, `.local`, `.internal`, or a bare single-label host | the loopback and the cluster are not customers |
| no private, loopback, link-local, multicast, broadcast, unique-local, or otherwise reserved address | RFC1918, 127/8, 169.254/16, `::1`, `fc00::/7`, `fe80::/10`, and the rest |
| **no redirects** | a 200 from a validated host that redirects to `169.254.169.254` is the classic bypass. A 3xx is a refusal, not a hop |
| **re-resolved immediately before every request** | the decision that matters is the one made at connection time |
| the socket connects only to the address validated in that moment | via a custom `lookup`, so there is no gap between checking and connecting |

**DNS rebinding is the reason the last two rules exist.** Validating the hostname when the owner
saves it proves nothing later: the same name can resolve to a public address then and to
`10.0.0.1` a second afterwards. So the check is not "was this safe once" but "is this address safe
now, and is it the address this socket is using". Node's `lookup` hook is what makes those the same
question — the resolver returns only an address that has just passed validation, and the agent
connects to that.

TLS SNI and the `Host` header stay the hostname, so a receiver behind virtual hosting still works.

### Transport limits

Short connect and total timeouts. No redirects. The response body is read to a hard cap and then the
socket is destroyed; **the body is never logged, stored, returned or classified.** Only the status
code is kept. The request body is a fixed, small JSON envelope, and is refused before sending if it
somehow exceeds its cap.

### Delivery semantics — at-least-once, never exactly-once

This is the single most important sentence for a receiver to read, and it is in the UI in both
languages as well as here:

> **A receiver may get the same event more than once. It must de-duplicate by event id.**

Exactly-once delivery over a network does not exist. A request can succeed and the response be lost;
a retry then delivers a second copy of something already processed. `X-Walaaplus-Event-Id` is stable
across every attempt and across every destination, and a receiver that keys on it is correct. One
that does not is the receiver's own problem, stated in advance rather than discovered.

**The claim and the lease.** A delivery is taken atomically — one
`UPDATE … WHERE id IN (SELECT … FOR UPDATE SKIP LOCKED) RETURNING` — so two workers, or two
overlapping passes of one worker, cannot both dispatch the same row. The claim carries an expiry, so
a worker that **crashes** holding one does not strand it: once the lease passes, the row is due
again and another pass takes it. Every write afterwards is conditional on the claim token, so a
worker slow enough to lose its lease cannot overwrite whoever took the row next.

That expiry is also exactly where at-least-once comes from, and it is worth saying out loud: a
process that dies **after** the request reached the receiver but **before** the outcome was written
will retry. A socket and a database transaction do not commit together, and nothing in a lease can
make them. The receiver de-duplicates; that is the contract.

The lease itself holds a business id, two timestamps and a uuid. **No URL, no body, no secret, no
response and no error text** — a claim is a claim on a row, not a record of what was attempted.

### Retries

Bounded exponential backoff, and **only for failures that could plausibly succeed later**:

| outcome | retried? |
|---|---|
| network error, connect failure, timeout | yes |
| HTTP 429, HTTP 5xx | yes |
| HTTP 4xx other than 429 | no — the receiver has said no |
| a 3xx redirect | no — a misconfiguration, and following it is the bypass |
| TLS failure | no — needs the owner to fix a certificate, not time |
| **unsafe URL or unsafe resolved address** | **never** — retrying an SSRF attempt is attempting it again |
| the destination disabled or revoked before dispatch | no — the owner's decision is not a transient condition |
| **the environment key missing or malformed** | **yes**, bounded — see below |
| a stored value that will not decrypt under a present, well-formed key | no — waiting cannot make a row decrypt |

**Two failures that look alike and are not.** A missing or malformed `INTEGRATION_ENCRYPTION_KEY` is
a deployment condition an operator corrects in minutes. Refusing every queued delivery permanently
because a variable was briefly unset would turn a five-minute outage into lost webhooks — so it is
**retryable**, bounded by the same cap as anything else, and settles `FAILED` if nobody fixes it.

A ciphertext that will not decrypt under a key that *is* present is tampered, or was written under a
key that no longer exists. No amount of waiting changes that, and retrying would hide a corrupted
destination behind five quiet failures. **Permanent.**

**Neither sends anything**, and the database enforces both: an attempt row recording an unavailable
key as permanent is refused, and one recording a decryption failure as retryable is refused.

A timeout or a network error is **never** recorded as delivered. Attempts are capped; the delivery
then rests at `FAILED` and is visible to the owner.

### Endpoint verification

A destination **begins disabled** and receives nothing until the owner explicitly enables it. Before
that, the owner may send **one fixed synthetic test envelope** — no customer, no card, no real
event — through the same signing, the same SSRF checks and the same transport limits.

One table, and the worker, the service, the screen and the database trigger all agree on it:

| destination state | a real `IntegrationEvent` | an owner-triggered synthetic test |
|---|---|---|
| `DISABLED` | **never** | **yes** — that is what a test is for: checking an address before turning it on |
| `ENABLED` | yes | yes |
| `REVOKED` | **never** | **never** |

The disabled-test row is the one worth being explicit about. It is safe because the envelope
describes nothing real — a constant entity id, `eventType: "TEST"`, no customer and no card — and it
is necessary because the alternative is an owner enabling a live destination in order to find out
whether the address works.

A test delivery is never triggered automatically, never by a schedule, and never by another user's
action. It is audited by row id, without the URL and without the secret.

**What verification deliberately is not**: there is no challenge-response handshake in which the
receiver echoes a token. That is a real design worth having and it needs the receiver to implement
something; today the owner reads a status and decides.

### The delivery-state cutover, and the boundary it cannot cross

The destination's state, its ciphertexts and its event are read **per delivery, in the dispatch
loop, immediately before that delivery is sent** — not once for the claimed batch.

That distinction is the whole point, and it was wrong once: a batch read is a snapshot, and a
snapshot taken when ten deliveries were claimed is stale by the time the tenth is sent if the first
was slow. An owner could disable the tenth destination and the tenth delivery would still go, on a
state that was true a minute earlier. Fixed, and the tests that prove it interleave a committed
change between two dispatches in the same batch.

So: a destination disabled or revoked so that the change is **visible to a later delivery's own
dispatch read** sends nothing to it for that delivery, and the attempt is recorded as
`DESTINATION_NOT_ELIGIBLE` — permanent, because an owner's decision is not a transient condition. A
signing secret rotated visibly to that same read signs with the **new** value, because the
ciphertext is read in the same statement as the state.

The read also requires the **claim token**. A row re-claimed by another pass while this one was slow
comes back empty: no request is made and **no attempt is recorded**, because this pass is no longer
describing its own work.

**What that cannot do is unsend a request already on the wire.** The rule is about visibility, not
timing, and PostgreSQL's own consistency model is what decides it — not a Node-level moment such as
a function returning. Each delivery performs one fresh read (`loadForDispatch`) immediately before
it begins its outbound attempt, in place of the earlier batch snapshot. A disable, revoke or rotation
committed early enough to be **visible to that read's own statement snapshot** is observed by it. If
the owner's commit and the dispatch read race — which this design does not serialize against one
another — there is no ordering guarantee: whichever state PostgreSQL's snapshot actually gave that
SELECT is the state this delivery acts on. Once the read has observed a state and the outbound
attempt has begun — decryption, URL re-validation, signing, DNS resolution, the TCP/TLS handshake,
and the request itself — it cannot be reliably cancelled by a later owner action. **This is not a
short or fixed window.** DNS resolution and the TLS handshake in particular can each take a
meaningful fraction of a second or more under a slow or degraded network, so no duration —
"microseconds" or otherwise — is promised. What is guaranteed is the boundary itself: a database
transaction and a socket cannot commit together, so there is no way to make an owner's action apply
retroactively to a dispatch already under way.

Before the per-delivery read existed, the same non-cancellable gap covered the whole rest of the
batch — every delivery queued after a slow one, potentially minutes. The per-delivery read narrows
that gap to one attempt's own dispatch time, but does not make it a fixed or negligible duration.
Nothing in this product promises otherwise, and an owner who needs a guarantee that a specific event
never arrives has to arrange it at the receiver.

The same boundary applies to **signing-secret rotation**. A rotation visible to a delivery's
`loadForDispatch` read is used by that delivery; one that is not — because it raced with, or
followed, that read — leaves the ciphertext already captured and the old secret already decrypted
from it. A receiver that switches to the new secret at the instant the owner rotates may reject a
request that was already using the old one. The owner is told to update the receiver in the same
sitting, and the precise description is: **rotation applies to every request whose signing-secret
read has not yet observed the new value, not to every request that has not yet arrived at the
receiver — and this design does not guarantee which value a read racing with a rotation will see.**

### Key rotation

Two independent rotations:

- **The signing secret** rotates per destination, on the owner's request. The new value is shown
  once and never again; the old value stops working immediately. A receiver must be updated in the
  same sitting, so the UI says so before the rotation happens.
- **`INTEGRATION_ENCRYPTION_KEY`** rotates per environment. Rows carry their key version, so a
  rotation writes version *n+1* and leaves version *n* rows readable while they are re-encrypted.
  **The re-encryption tool does not exist yet** — the schema is ready for it, the code is not, and
  pretending otherwise would be the kind of claim this document exists to prevent. Recorded as
  **D29**.

### Retention

Nothing deletes a delivery or an attempt. A revoked destination keeps its history, because the
history is a record of what this business sent to whom. There is **no retention period**, and one is
a decision with the same shape as D9, D13, D20 and D23 — recorded as **D30**.

### Owner authority

Only an `OWNER` may create, edit, reveal, rotate, enable, disable, revoke, test or list destinations.
A `MANAGER` holds `VIEW_INTEGRATIONS` and may read the *event* history; that is where their access
stops. A destination is a standing instruction to send this business's activity to a third party,
which is an owner's decision in the same way approving a campaign is.

### The receiver's responsibilities, stated so nobody assumes otherwise

1. **De-duplicate by `X-Walaaplus-Event-Id`.** Delivery is at-least-once.
2. **Verify the signature** before trusting the body.
3. **Reject an old timestamp**, or a replayed request is accepted forever.
4. **Answer quickly** — 2xx as soon as the event is durably accepted, and do the work afterwards.
   A slow receiver is a timed-out delivery and a retry.
5. **Expect the event id and nothing else to identify the subject.** The body carries internal ids;
   resolving them to a customer is an authorized read the receiver does not have.

---

## 8. Where a secret would have to live — a decision, not a column

This phase adds **no** secrets table, **no** generic JSON configuration column, **no** master
encryption key, **no** environment variable and **no** deployment change. That is not an omission; it
is the point.

Every single family in §2–§6 needs at least one secret. Before any of them can be built, somebody has
to decide:

1. **Where the ciphertext lives** — a dedicated table with typed columns per provider, or one
   encrypted blob. (A generic JSON blob is how a phone number ends up in a config column.)
2. **Where the key lives** — an environment variable on the host, a KMS, or a file mounted by
   Compose. Each is a deployment change and each has a different answer to "what happens when the
   host is restored from a backup".
3. **Who may read a credential back** — the honest answer is nobody, the same as a coupon code: an
   owner who has lost their API key rotates it at the provider.
4. **What happens on key rotation**, and whether an old ciphertext must remain decryptable.
5. **Whether a credential is per business or per platform**, which decides whether a merchant brings
   their own account or rides on ours — a commercial question, not a technical one.

None of these is guessed here for a *provider* credential. **Recorded as decision D27.**

### 8a. The one key that now has an answer — `INTEGRATION_ENCRYPTION_KEY`

The owner has approved a dedicated per-environment secret for Prompt 2's webhook encryption. It
answers question 1 and 2 above for this one purpose and for no other.

**The exact deployment requirement, for whoever provisions the environment:**

| | |
|---|---|
| Name | `INTEGRATION_ENCRYPTION_KEY` |
| Value | **32 bytes**, supplied as 64 hex characters or as standard/URL-safe base64. Generate with `openssl rand -hex 32` |
| Scope | **per environment.** Staging and production must not share one |
| Consumers | the web process and the worker process — both, or delivery fails closed |
| Absent or malformed | webhook configuration and delivery fail closed; **every other workflow is unaffected** |
| Rotation | writes a new key version; version *n* rows stay readable. The re-encryption tool does not exist yet (**D29**) |

**It must never be committed, logged, rendered, printed in an error, or embedded in a test fixture.**
`src/server/env.ts` prints variable NAMES only, and the crypto module's errors name the variable and
never the value. No value for it exists anywhere in this repository, and none was generated for any
environment by the work that added support for it: **provisioning it is Freebuff's step, after
review.**

---

## 9. What the event row may never contain

Enforced by the schema itself: the table has typed columns and **no free-form JSON**, so there is
nowhere for any of this to go even by accident. A column-name check in the integrity suite fails if
one is ever added.

Never, in any event row:

- a phone number, an email address, a customer name or any contact detail
- a raw QR, share or coupon capability — **or its digest**
- a wallet payload, pass, serial or device token
- a coupon code, a promotion code or a normalised form of one
- a secret, key, token or password of any kind
- a payment identifier, amount, currency, tax figure or invoice reference
- a referral reward, a balance, points or stamps — none of which exist to leak

What it does contain: the business, the event type, the entity type and its internal id, the
occurrence time the **database** assigned, and the envelope version. A consumer that wants detail
asks for it through an authorized read, which is what keeps the authorization in one place.

---

## 10. Manual gate — before any production integration claim

None of this can be checked by a test on this machine, and none of it is claimed:

- [ ] no provider account has been opened, funded or verified
- [ ] no credential has been obtained, stored or rotated
- [ ] no outbound request has been made to any provider, from anywhere
- [ ] no POS, wallet, payment or messaging system has been contacted
- [ ] no external network path has been exercised
- [ ] deliverability, message templates, sender reputation and per-country regulation are entirely
      unverified

Staging is Freebuff's after review. Nothing in this phase has been deployed.

---

## 11. Roadmap, in the order the gates open

1. **Now** — the internal event record, append-only, tenant-isolated, read by an owner. This prompt.
2. **Next, and cheapest** — a Telegram report bot to the *merchant*. One token, no review, no
   per-message cost, and the recipient is the person who configured it. Blocked only on **D27**
   (where a token lives).
3. **Then** — outbound webhooks with HMAC signing, once D27 is answered and the SSRF question in §7
   has a written design behind it.
4. **Then** — email, once **D3** names a provider and somebody owns the domain and the DNS records.
5. **Later** — SMS, once **D2** is answered by a provider that actually serves the market.
6. **Later still** — WhatsApp, once Meta approval is a project somebody has started rather than a
   line in a table.
7. **On demonstrated demand only** — one POS connector, for one real merchant, after deciding what a
   POS may do to an append-only ledger.
8. **Blocked on commercial and legal decisions** — payments (**E1–E5**), agency listings (**E7**).

Every step after the first needs something this project does not have yet. Saying so is the whole
purpose of writing the matrix before the code.
