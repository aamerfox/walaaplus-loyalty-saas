# Public API and API keys — capability and threat matrix

**Phase 3B.1, written before Prompt 1's implementation and used to constrain it.**

Companion to `docs/PHASE-3B-SCOPE-RECONCILIATION.md` §4.1, which established that this is the only
unblocked option, and to `docs/INTEGRATIONS-CAPABILITY-MATRIX.md`, which classified every provider
family and marked `X-API-Key` out of scope until now.

---

## 0. The sentence this document exists to prevent

> *"We have a public API."*

A key that authenticates is not an API. An API is a surface somebody outside this system can reach,
a contract they can build against, a bound on what they may do with it, a way to take the permission
back, and an answer for what happens when the key leaks. The last of those is the one that gets
skipped.

This prompt builds the **key** and refuses to build the surface. `/api/v1` does not exist when
Prompt 1 ends, and that is deliberate: a key with nothing to open is a key whose failure modes can
be tested without anything being exposed while they are still being got right.

---

## 1. The owner-approved v1 contract

| | |
|---|---|
| Direction | **Read-only.** No write endpoint exists or may be added in 3B.1 |
| Scope | **`events:read`, and only that.** One scope, so "what may this key do" has one answer |
| Tenancy | A key belongs to **exactly one Business**. A Business may hold several named keys |
| Tenant selection | **The caller never supplies a `businessId`.** It is read from the key |
| Disclosure | Shown **once**, at creation or rotation. Stored as a digest. Never recoverable |
| Lifetime | **90 days**, then it stops working. Revocable at any time, exactly once |
| Readable data | Eventually the `IntegrationEvent` envelope and nothing else — the **two** existing event types. **D28 stays closed** |
| Never readable | Customer data, phone, name, card token, share capability, coupon code, wallet payload, any URL, any secret, balance, amount, webhook destination |

---

## 2. What a key is, in this codebase's existing vocabulary

This product has issued bearer capabilities twice before, and both patterns are load-bearing here.

| Precedent | Entropy | Storage | Why that choice |
|---|---|---|---|
| Share link (`src/server/share/share-links.ts`) | 32 random bytes | **Unsalted** SHA-256 digest | 256 bits of randomness has no dictionary to precompute, and lookup must be one indexed read |
| Coupon code (`src/server/promotions/codes.ts`) | Human-chosen, short | **Salted** digest, per business | A six-character code *does* have a dictionary, so a salt is required — and lookup is per business, so a scan is acceptable |

**An API key follows the share-link pattern**, and the reason is not preference. Authentication has
to find the key from the value alone, in one indexed lookup, before it knows which business is
involved. A per-row salt would mean scanning every key in the table and hashing against each — which
is both slow and a timing oracle. 256 bits of `randomBytes` is what makes an unsalted digest safe,
and the digest column is what makes the raw value unrecoverable.

---

## 3. Threat matrix

Each row names the attacker's goal, then what stops it. "Prompt 1" means this prompt closes it.

### 3.1 Against the key itself

| # | Threat | Control | When |
|---|---|---|---|
| T1 | **The key is read out of the database** by anyone with a dump, a backup, or `SELECT` | Only a SHA-256 digest is stored. There is no column holding the value, and no code path that could write one | Prompt 1 — schema + a column-name test |
| T2 | **The key is read back through the product** — a reveal button, a list endpoint, a debug field | `create` and `rotate` are the only functions that ever return a raw key, and they return it from the value they just generated, never from a column. The list projection names its columns literally and the digest is not among them | Prompt 1 |
| T3 | **The key leaks through a log, an error, a URL or telemetry** | Never accepted in a query string; never placed in an error; never written to audit metadata; never logged. Source scans assert each | Prompt 1 |
| T4 | **The key is guessed** | 32 bytes from `crypto.randomBytes` = 256 bits. At a million guesses a second, the expected time exceeds the age of the universe by many orders of magnitude. The rate limiter is not what stops this; the entropy is | Prompt 1 |
| T5 | **A stolen key is used forever** | 90-day expiry, enforced in the database as well as in code, plus revocation at any time | Prompt 1 |
| T6 | **A rotated key's old value keeps working** | Rotation revokes the old row and issues a new one in one transaction. The old digest is still stored — because the *record* that a key existed is kept — but it is revoked, and revoked keys authenticate nothing | Prompt 1 |

### 3.2 Against tenancy

| # | Threat | Control | When |
|---|---|---|---|
| T7 | **A caller names another business** — the classic `?businessId=` escalation | **There is no input to do it with.** The API context carries one business id, read from the key row. No function on this path accepts a business id from a caller | Prompt 1 |
| T8 | **A key is re-pointed at another business** by a direct writer | `businessId` is immutable after insert, by trigger. So are the digest, the issue time and the expiry | Prompt 1 — red-proved |
| T9 | **A key reads another tenant's events** | Every read is `where: { businessId: ctx.businessId }`, and the database's existing tenant triggers are independent of the service | Prompt 2, on the foundation laid here |
| T10 | **The session contract is weakened to accommodate keys** | `TenantContext` is **not** modified. An API caller gets a separate, smaller `ApiContext` with no `userId`, no `membershipId`, no role and no permission set — because it has none of those things. Nothing that takes a `TenantContext` can be called with a key | Prompt 1 — §5 |

### 3.3 Against availability and the database

| # | Threat | Control | When |
|---|---|---|---|
| T11 | **Unbounded key issuance** — a business mints thousands of keys | A bounded number of **active** keys per business, as a code constant *and* a database guarantee that holds under concurrent issue | Prompt 1 — concurrency-proved on separate connections |
| T12 | **Rate-limit table flooded with garbage** — an attacker sends a million random keys, each creating a counter row | **The window is consumed only after the key is known valid.** An unknown key is refused before any row is written. This is the single most important detail in the rate-limit design and it is the opposite of what the auth limiter does, deliberately: there, the identifier is a real email; here, it would be attacker-chosen noise | Prompt 1 |
| T13 | **A valid key floods the read API** | Per-key window, keyed on the key's **id** — not its value, and not a hash of its value | Prompt 1 foundation, enforced at the route in Prompt 2 |
| T14 | **Audit table flooded** — one row per API read | **Lifecycle actions only.** Creation, rotation, revocation. A read writes nothing | Prompt 1 |

### 3.4 Against the reader — what the API may never disclose

| # | Threat | Control | When |
|---|---|---|---|
| T15 | **Customer data reaches an API consumer** | `IntegrationEvent` has typed columns and no JSON bag. The integrity suite already asserts its exact column list and that no column name matches phone, email, name, code, digest, token, secret, url, payload, amount or balance. The API can only project a subset of that | Prompt 1 defines the projection; Prompt 2 exposes it |
| T16 | **An oracle** — "does this phone number belong to a customer?" | The same thing **B7** withdrew from the public web. v1 is read-only over events keyed on internal ids, with **no lookup by phone, name, code or token of any kind**, and no endpoint that takes a customer-supplied identifier | Prompt 1 contract; asserted again at the release gate |
| T17 | **Existence probing through error differences** | One generic refusal for missing, malformed, unknown, revoked and expired keys — same status, same body, same shape. A caller cannot learn that a key *was* real | Prompt 1 |

---

## 4. The generic-refusal rule, stated precisely

Five conditions must be indistinguishable to the caller:

```
no X-API-Key header          →  401, {"error":{"code":"UNAUTHORIZED", …}}
malformed value              →  401, the same body
well-formed, unknown digest  →  401, the same body
known, revoked               →  401, the same body
known, expired               →  401, the same body
```

Same status, same code, same message, no header that differs. An owner who has revoked a key and
wants to know why it stopped working reads their own key list, where the state is shown — because
they are authenticated as a person, which the API caller is not.

**The internal reason is still knowable to us** where it matters: revocation and expiry are visible
in the owner's list. It is only the *caller* who learns nothing.

### 4.1 The owner's side: both ways a key ends are terminal

The caller is told nothing; the **owner** is told plainly, and that half has its own rule.

`ACTIVE` may become `EXPIRED` or `REVOKED`, and `walaaplus_api_key_guard` permits no state change
after either. Both are rest states. So both must produce the same controlled refusal from the
service, under one conflict code:

| Key state | `revokeKey` | `rotateKey` | Row written | Audit row |
|---|---|---|---|---|
| `ACTIVE` | succeeds — state `REVOKED`, slot released | succeeds — predecessor revoked, successor issued | yes | `api_key.revoked` / `api_key.rotated` |
| `EXPIRED` | **409 `API_KEY_NOT_ACTIVE`** — "That key has expired" | 409 `API_KEY_NOT_ACTIVE` | **none** | **none** |
| `REVOKED` | 409 `API_KEY_NOT_ACTIVE` — "That key is already revoked" | 409 `API_KEY_NOT_ACTIVE` | none | none |

The rule behind that table generalises past API keys, and is the one to carry forward:

> **A service refuses exactly what the database would refuse, before the database has to.**

A service that refuses *less* than its triggers do is a service whose error messages are chosen by
PostgreSQL. The earlier `revokeKey` guarded only against `REVOKED`; an `EXPIRED` key reached the
`UPDATE`, and `api_key_guard` answered `23514 — "ApiKey: EXPIRED is a rest state"`. That is a raw
database error where a conflict was intended, and through the Prompt 2 owner route it would have
been a 500 carrying PostgreSQL's own words. The state is also re-checked *inside* the `UPDATE`
predicate, so a key that changes state between the read and the write hits the same conflict rather
than the trigger.

### 4.2 A key past its expiry whose state is still `ACTIVE`

The sweep to `EXPIRED` is **lazy** — `releaseExpiredSlots` runs only when a key is issued — so a
business that stops issuing leaves its lapsed keys at `state = ACTIVE` with their slots still held.
This is the ordinary condition of a lapsed key, not an edge case.

**Such a key can still be revoked**, deliberately:

- The decision is made on `state` alone, the same column the trigger decides on, so the service and
  the database never disagree about what is permitted.
- It releases the slot, which otherwise stays held until something issues a key.
- It records that the owner *ended* the key, which is a different fact from the key running out.

**Access does not turn on any of this.** `authenticateApiKey` reads `expiresAt` directly rather than
trusting `state`, so a lapsed key is refused before the revocation and refused after it — with the
same generic 401 in §4 either way. Nothing in §4 changes here.

The wrinkle, stated rather than smoothed over: whether a lapsed key answers "that key has expired"
or revokes successfully depends on whether the sweep has run for that business yet. Both outcomes
leave the key unusable and its slot free; only the sentence the owner reads differs. Both paths are
covered in `tests/integration/api-keys.test.ts`, including the transition — a lapsed key that is
revocable, then swept by an unrelated `createKey`, then refused.

---

## 5. Why an API caller does not get a `TenantContext`

`TenantContext` requires `userId`, `membershipId`, `role`, `permissions` and a location scope. An
API key has **none of those**. Making them nullable would weaken a type that forty-odd call sites
rely on to mean "an authenticated person with a membership", and every one of those call sites would
silently start accepting a caller that is not a person.

So the key path gets its own type:

```ts
interface ApiContext {
  businessId: string;   // from the key row, never from input
  apiKeyId: string;     // for rate limiting and audit correlation
  scopes: ReadonlySet<ApiScope>;
}
```

It is deliberately smaller, and nothing that takes a `TenantContext` can be handed one. That is the
strongest available guarantee that a key cannot reach a staff service by accident — it does not
type-check.

---

## 6. Retention after expiry or revocation — registered, not guessed

A key row is **not deleted** when it expires or is revoked, and nothing in this prompt deletes one.
The row is the record that a business held a credential between two dates, which is exactly the sort
of thing an audit trail is for.

What that leaves open — a retention period, and what happens to the record when a business closes —
is **not guessed here**. It is registered as a new owner decision alongside D9, D13, D20, D23 and
D30, which are the same question about other append-only records.

**Proposed as D31.** Nothing is blocked by it: the rows are metadata about a credential, hold no
customer data, and hold no recoverable secret.

---

## 7. Core now, versus Prompt 2

| | Prompt 1 — **this prompt** | Prompt 2 |
|---|---|---|
| Schema | `ApiKey` model, migration 18, triggers and indexes | — |
| Key generation | 32 random bytes, digest-only storage, non-secret prefix | — |
| Lifecycle services | create, list metadata, revoke, rotate — **owner only** | — |
| Authentication | `X-API-Key` verification, generic refusal, `ApiContext` | Applied at a real route |
| Rate limiting | Per-valid-key foundation | Enforced on the endpoint |
| Contracts | Response envelope, error shape and cursor pagination **defined internally** | **Exposed as `/api/v1`** |
| Audit | Lifecycle actions | — |
| **Not built here** | — | The owner's key-management screen, both locales, copy-once UI, the events endpoints themselves, OpenAPI or any published documentation |

**`/api/v1` does not exist when this prompt ends.** The contracts are written and unit-tested; no
route serves them.

---

## 8. Explicitly out of scope for the whole of 3B.1

Write endpoints of any kind. Idempotency-key handling — there is nothing to make idempotent while
the API is read-only. CORS and browser calling — a key in a browser is a key published. OAuth. GHL.
POS. Any provider, credential or outbound call. New event types (**D28**). Any endpoint that takes a
phone number, a name, a code, a card token or a share capability.

---
---

# Part II — Prompt 2: the surface

**Written before Prompt 2's implementation and used to constrain it.** Everything above describes
the key. Everything below describes what the key now opens, and is the part §0 said would be the
easy thing to get wrong.

---

## 9. What Prompt 2 builds, and what it still refuses

| Capability | Prompt 1 | **Prompt 2** |
|---|---|---|
| Key lifecycle services | built | unchanged |
| Owner **screen** for keys | — | **built** — list, create, rotate, revoke, in English and Arabic |
| Show-once reveal with a copy affordance | — | **built** |
| `X-API-Key` authentication | built, unmounted | **mounted on a real route** |
| Per-key rate limiting | built, uncalled | **enforced on every `/api/v1` read** |
| Envelope, error shape, cursor | defined, unserved | **served** |
| `GET /api/v1/events` | — | **built** |
| `GET /api/v1/events/{eventId}` | — | **built** |
| Published consumer documentation | — | **built** — `docs/PUBLIC-API-V1.md` |
| Any write through `/api/v1` | refused | **still refused** |
| A second scope | refused | **still refused** — `events:read` is the only one |
| CORS, cookies, browser calling | refused | **still refused** |
| Key deletion | refused | **still refused** — D31 |

---

## 10. The route surface, exactly

| Method and path | Authenticated by | Authorised by | Answers |
|---|---|---|---|
| `GET /api/v1/events` | `X-API-Key` header **only** | scope `EVENTS_READ` | a bounded page of this key's business's events |
| `GET /api/v1/events/{eventId}` | `X-API-Key` header **only** | scope `EVENTS_READ` | one event, or `404` |
| `POST /api/staff/api-keys` | the session cookie | `OWNER` of the business | create / rotate / revoke |

Three routes, and the third is not public. There is no `OPTIONS` handler, no write verb, no
discovery index, no OpenAPI endpoint and no `/api/v1/keys` — **a key cannot read, create or revoke a
key**, which is what keeps a leaked key from extending its own life.

### 10.1 Where the tenant comes from

`ApiContext.businessId` is read from the key row and from nowhere else. There is no path parameter,
query parameter, header or body field in `/api/v1` through which a business can be named — the
routes take exactly two query parameters, `limit` and `cursor`, and a single path parameter that is
an event id filtered *by* the tenant rather than selecting it.

### 10.2 Key material may arrive in exactly one place

The header. Not a query string, not a cookie, not a body — `GET` has no body and neither handler
reads one.

Stronger than "we do not read it": a request carrying a **credential-shaped query parameter**
(`key`, `api_key`, `apikey`, `token`, `secret`, `access_token`, `password`, in any case) is refused
`400` **before authentication runs**, so the value is never hashed, never looked up and never
reaches a log line that records the path. v1 has no legitimate parameter by those names, so nothing
correct is refused — and a merchant who tries the URL form is told immediately rather than retrying
it, each retry writing their key into somebody's access log.

The refusal names the parameter's **name** and never its value.

### 10.3 No CORS, on purpose

No `Access-Control-Allow-Origin` is ever sent, by any `/api/v1` response, success or failure. This
is server-to-server: a key in a browser is a key published.

The shape of the API enforces that on its own even before the missing header does. `X-API-Key` is
not a CORS-safelisted request header, so any cross-origin browser call must preflight; the preflight
is an `OPTIONS` request; there is no `OPTIONS` handler and no allow-origin header, so the browser
refuses before the real request is sent.

### 10.4 Caching

Every `/api/v1` response carries `Cache-Control: no-store` and `Vary: X-API-Key`. A response
selected by a secret header must never be stored by an intermediary, and `no-store` says so;
`Vary` is belt-and-braces for an intermediary that ignores it.

---

## 11. Data exposure — decided column by column

The public event shape was chosen by reading `IntegrationEvent` and everything reachable from it,
not by picking fields that seemed useful.

### 11.1 Every column of `IntegrationEvent`

| Column | In `/api/v1`? | Why |
|---|---|---|
| `id` | **yes**, as `id` | the event's own identity, the cursor's tie-break, and the path parameter of the single read |
| `eventType` | **yes**, as `type` | the vocabulary a consumer switches on |
| `entityType` | **yes** | says what kind of thing `entityId` names |
| `entityId` | **yes** | the correlation key — `RECORDED` and `VOIDED` for one redemption share it. An internal uuid belonging to this business, holding no customer data |
| `occurredAt` | **yes**, ISO-8601 | database-assigned, and the ordering authority |
| `envelopeVersion` | **yes** | a consumer meeting an unknown version should stop rather than guess |
| `businessId` | **no** | the key already determines it, so a per-row copy is redundant — and a field that looks like a tenant selector is one a client eventually tries to set |
| `createdAt` | **no** | a duplicate of `occurredAt` with no distinct meaning to a consumer; publishing two near-identical times invites ordering by the wrong one |
| `deliveries` (relation) | **no** | our delivery attempts to the merchant's webhooks are operational detail about us, not about the event |
| `business` (relation) | **no** | name, plan and contact details; none of it is event data |

The `select` in the service lists the six exposed columns literally. Nothing is spread, and no
relation is traversed.

### 11.2 The categories that must never appear, and why they cannot

| Must never appear | Where it actually lives | What keeps it out |
|---|---|---|
| Customer PII, phone, email, name | `CustomerBusinessProfile`, `Customer` | `IntegrationEvent` has **no relation** to either. There is no query path from a key to a person |
| Raw event payload | nowhere — **the column does not exist** | The table was built with typed columns and no JSON bag, precisely so there is nowhere for one to go |
| Webhook ciphertext, signing secret | `WebhookDestination` | Not selected, not joined, and no `/api/v1` route mentions the model |
| API-key digest or raw value | `ApiKey.keyDigest` | `KEY_SELECT` omits it; the only read of `ApiKey` on the public path is authentication, which selects five columns and returns three |
| Key prefix | `ApiKey.keyPrefix` | Owner UI only — it is how an owner recognises a row in their own list. Never in `/api/v1` |
| Internal or provider errors | thrown values, `WebhookDeliveryAttempt.errorClass` | `/api/v1` has its own error mapper; an unrecognised throw becomes a fixed `INTERNAL` sentence |
| Audit metadata | `AuditLog` | Never read by `/api/v1` |
| Cross-tenant identifiers | other businesses' rows | `businessId` from the key is in the `WHERE` of every query, including the single-event read |

### 11.3 What an event does **not** tell a consumer

Worth stating so nobody is surprised: an event says *a promotion redemption was recorded (or
voided) at this moment, and here is its internal id*. It does **not** carry the customer, the card,
the promotion, the coupon code, the benefit or any amount. A consumer needing those asks the
merchant through an authorised read that does not exist yet — which keeps the authorisation
decision in one place instead of copying a customer's data into a feed nobody re-checks.

---

## 12. Ordering, pagination and what tampering with a cursor buys

### 12.1 The order is total

`ORDER BY "occurredAt" DESC, "id" DESC`.

`occurredAt` alone is **not** a total order: it is `TIMESTAMP(3)`, and two transactions beginning in
the same millisecond produce two events that compare equal. A sort with ties is a sort the database
may return in a different order each time, which is how a paginating client sees one row twice and
another never. `id` breaks every tie.

### 12.2 The cursor is keyset, not offset — and the FORM of the comparison decides it

`OFFSET 10000` makes PostgreSQL walk ten thousand rows in order to throw them away, so a small
request buys arbitrary server work. It is also wrong under insertion: a row arriving ahead of the
window shifts every later page.

The cursor carries the last row's `(occurredAt, id)` and the next page asks for strictly-earlier
rows under the same two-column order. It neither repeats nor skips when rows are inserted ahead of
the window.

> **Corrected at the Phase 3B.1 release gate.** This section used to end "that is an indexed seek at
> any depth". It was not one. Prompt 2 expressed the comparison as
> `at < X OR (at = X AND id < Y)` — the form a Prisma `where` can produce — and PostgreSQL cannot
> push an OR across two columns into an index range, so the query read every row between the top of
> the feed and the caller's position and discarded it. Cost grew linearly with depth, exactly as
> `OFFSET` does. Correctness was never affected, which is why every pagination test passed
> throughout and only a query plan showed it.
>
> Measured at 40,000 events, reaching a cursor at depth 20,000:
>
> | Predicate | Index Cond | Rows discarded | Buffers |
> |---|---|---|---|
> | `at < X OR (at = X AND id < Y)` | `businessId` only | 20,001 | 595 |
> | `(at, id) < (X, Y)` | `businessId` **and** `occurredAt` | 1 | **5** |
>
> `listApiEvents` now emits the row-value form, which needs raw SQL because a Prisma `where` cannot
> express it — parameterised throughout, with `businessId` still the first term and still from the
> key. `docs/PHASE-3B1-RELEASE-GATE.md` §3 has the detail, including why no additional index was
> added and why the first two attempts at a regression test proved nothing.

### 12.3 It is opaque **and authenticated**

> **This section was rewritten after review.** The first version argued the cursor did not need
> signing, because the tenant filter comes from the key, so tampering could only move a caller's
> window within their own events.
>
> That is true and it is beside the point. **"Tampering is harmless" is not "tampering is
> detected"**, and this document promised the second. Worse, the argument rested entirely on one
> `WHERE` clause elsewhere in the codebase: a defence that survives exactly as long as nobody edits
> that line. The review was right and the cursor is now signed.

A cursor is `v1.<payload>.<mac>`:

| Part | What it is |
|---|---|
| `v1` | the format. A different value is refused, so the construction can change later without ambiguity |
| `payload` | base64url of `{at, id}` — the same two fields as before, and still nothing else |
| `mac` | HMAC-SHA256, full 32 bytes, over a domain-separated canonical message |

**The key is derived, never a raw secret.** `createHmac("sha256", NEXTAUTH_SECRET)` over the label
`walaaplus:api:v1:cursor` — the same idiom `src/server/security/rate-limit.ts` already uses for its
pepper, deliberately, so this codebase has one way of turning a root secret into a scoped one. Two
derivations from one root under different labels cannot collide, so a cursor MAC is no use as a
rate-limit hash and neither is any use for signing a session.

**Why not `INTEGRATION_ENCRYPTION_KEY`.** The review offered it as the first option. It is
**optional by deliberate design** (`src/server/env.ts`: a deployment that sends no webhooks must
start normally). Signing cursors with it would mean `/api/v1` served page one and refused every
cursor wherever webhooks were unconfigured — one feature failing because an unrelated one is not set
up, which is the coupling that rule exists to prevent. "Use it if present, else fall back" is worse:
the signing key would change the day webhooks were configured, silently invalidating outstanding
cursors, and the security property would depend on deployment configuration rather than on code.
`NEXTAUTH_SECRET` is required, validated at boot, and present everywhere.

**The signed message is length-prefixed**, field by field, so no choice of values can produce the
same bytes as a different choice. Today's fields could not collide anyway; the next one added
cannot reintroduce the problem.

**The MAC is checked before the payload is parsed.** Attacker-chosen bytes never reach `JSON.parse`
or a date parser, and **no event row is read** on a failing path. The comparison is
`timingSafeEqual`.

### 12.3.1 Bound to the business, and not to the individual key

The binding is `businessId`. Whether to add `apiKeyId` was asked explicitly at review, so the answer
is written down rather than assumed:

**Business binding is necessary.** It is the tenant boundary, and it makes a cursor minted for one
merchant fail verification outright for another rather than being quietly reinterpreted against the
second merchant's rows. The check and the isolation then agree instead of one relying on the other.

**Key binding would be wrong**, for three reasons:

1. **It would refuse requests that are entitled to succeed.** A cursor names a position in a feed
   the business owns, and every active key of that business may read exactly the same rows.
2. **It would punish the one action we tell people to take.** `docs/PUBLIC-API-V1.md` tells a
   consumer to replace a key they suspect. Under key binding, replacing one mid-traversal would
   invalidate the cursor in hand and force a restart from the top — re-ingesting the whole feed as
   the price of rotating a credential.
3. **It would buy nothing.** A cursor is not a capability and opens nothing without a valid key.
   Anyone holding a key for this business can mint fresh cursors at will.

Revocation is unaffected either way: a revoked key is refused at authentication, long before its
cursor is looked at.

### 12.3.2 What is refused

Each of these is the fixed `400`, with the submitted value never echoed and **no row read**:

| Input | Why |
|---|---|
| an altered `at` | the MAC covers it |
| an altered `id` | the MAC covers it |
| an altered, truncated or absent signature | the MAC comparison fails |
| a cursor minted for another business | the binding is in the signed message |
| **an unsigned cursor of the shape this API issued before the fix** | one segment, not three |
| any other shape, or anything over 512 characters | refused before anything is hashed |

### 12.4 Clamp what has a default; refuse what does not

| Input | Bad value | Behaviour |
|---|---|---|
| `limit` | absent, `0`, `-5`, `abc`, `1e9`, `NaN` | **clamped** to `[1, 100]`, default `25`. Never an error |
| `cursor` | absent | page one |
| `cursor` | malformed, truncated, tampered, not ours | **`400 BAD_REQUEST`** |

That looks inconsistent and is not. A `limit` of `abc` has one obviously-safe reading — the
default — and getting it wrong costs nothing. A `cursor` of `abc` has **no** safe reading: silently
serving page one would restart a client's traversal without telling it, and a client that loops
"fetch page, follow cursor" would re-ingest the whole feed forever. The rule is *clamp what has a
sensible default, refuse what does not*.

---

## 13. Threat matrix — Prompt 2

Continues T1–T17. "Prompt 2" means this prompt closes it.

### 13.1 Against the surface

| # | Goal | What stops it |
|---|---|---|
| T18 | **Read another tenant's events** | `businessId` comes from the key row; it is in the `WHERE` of the list and of the single read. No parameter can name a business |
| T19 | **Reach events by guessing an event id** | The single read filters by `businessId` too, so another tenant's id is `404`. Identical `404` for "never existed" and "not yours" |
| T20 | **Write through the read-only API** | No write handler exists. `GET` is the only exported method on both routes; anything else is a framework `405` |
| T21 | **Use a key in a browser** | No CORS headers, no `OPTIONS` handler, and `X-API-Key` is not safelisted, so a cross-origin call cannot even preflight |
| T22 | **Get a key into an access log via a URL** | Credential-shaped query parameters are refused `400` before authentication, and the refusal echoes the name, never the value |
| T23 | **Have an intermediary cache one tenant's page and serve it to another** | `Cache-Control: no-store` on every response, plus `Vary: X-API-Key` |
| T24 | **Escalate from a key to a staff service** | `ApiContext` is not a `TenantContext` and does not type-check where one is required. No `/api/v1` handler imports a staff service |
| T25 | **Use a key to manage keys** | There is no key endpoint under `/api/v1`. Lifecycle is session + `OWNER` only |

### 13.2 Against pagination

| # | Goal | What stops it |
|---|---|---|
| T26 | **Make the database do unbounded work** | `limit` is clamped to 100 and the query is a keyset seek, never an offset scan |
| T27 | **Cross a tenant boundary with a forged cursor** | Two independent things stop it: the cursor is MAC-bound to the business, so another tenant's cursor fails verification; and the tenant filter comes from the key regardless, so even a correctly-signed cursor naming a foreign row returns only this tenant's events. §12.3 |
| T27a | **Alter a position to reach rows outside the page we offered** | The MAC covers `at` and `id`. A changed cursor is a `400` before any row is read, not a different window |
| T27b | **Downgrade to the unsigned cursor format** | Verification requires three parts and a valid MAC; the old single-segment form is refused |
| T28 | **Silently restart a consumer's traversal** | A malformed cursor is `400`, not page one. §12.4 |
| T29 | **See a row twice, or miss one, while events arrive** | Total order on `(occurredAt, id)` and a strict keyset comparison. Traversal is proved under concurrent insertion |

### 13.3 Against the key and the state behind it

| # | Goal | What stops it |
|---|---|---|
| T30 | **Turn guesses into rows in the rate-limit table** | The window is consumed only *after* the key is found. An unknown key costs one indexed read and writes nothing |
| T31 | **Turn a valid key into unbounded audit writes** | A read writes **no** audit row. `lastUsedAt` is the record, and it is one `UPDATE` that moves forward only |
| T32 | **Learn whether a key was real, revoked or expired** | One refusal for all five conditions, from a function that takes no argument |
| T33 | **Keep reading after the owner revokes** | The next request is refused. The in-flight one is not — see §14, stated rather than papered over |
| T34 | **Get a PostgreSQL message out of a terminal-state key** | Prompt 1's conflict handling. `revokeKey` refuses exactly what the trigger would |

---

## 14. The revocation window, stated honestly

Authentication and the event read are **two statements, not one transaction**. So:

> A key revoked after `authenticateApiKey` returns and before the event query runs **will serve that
> one in-flight request.**

The window is the gap between two statements in one request. It is not closed, and the alternative —
holding a row lock on the key for the duration of every read, or re-checking inside a transaction
that still cannot see a commit that has not happened yet — would slow every request to narrow
something that cannot be eliminated by either technique.

What is guaranteed instead, and tested:

- the in-flight request can only ever return **that tenant's own events**, which the key was
  entitled to a moment earlier — the failure is safe, not merely brief;
- the **next** request is refused, with the generic `401`;
- nothing is written on the way through except `lastUsedAt`.

The same is true of expiry, with the extra property from Prompt 1 that `expiresAt` — not the
bookkeeping `state` — is the authority, so a lapsed key is refused whether or not the sweep has run.

---

## 15. What Prompt 2 records, and what it refuses to record

| Fact | Recorded? | Where |
|---|---|---|
| A key was used, and when | **yes** | `ApiKey.lastUsedAt`, monotonic, one `UPDATE`, failure swallowed |
| A key was created / rotated / revoked | **yes** | `AuditLog`, with the name and the **public** prefix |
| Which events a caller read | **no** | One audit row per read turns a rate limit into unbounded writes |
| Response bodies | **no** | Never |
| The raw key, or its digest | **no** | Neither appears in an audit row, a log line, an error or a metric |
| A failed authentication | **no row** | Deliberately: writing one would let an unauthenticated caller cause writes |

---

## 16. Still out of scope after Prompt 2

Everything in §8, unchanged. Plus: no OpenAPI or machine-readable schema endpoint, no webhooks
*into* the API, no per-key scope selection while one scope exists, no key-level IP allow-listing,
no sandbox or test-mode key, and no endpoint that exposes a customer, a card, a promotion, a coupon
code or an amount.

And one absence worth naming rather than leaving implicit: **nothing warns an owner that a key is
about to expire.** The date is on their screen and that is all, so the realistic failure is silent —
a merchant's reporting job stops one morning and the key list says why, to nobody who is looking.
Registered as **D32**, because a banner and an email are different answers with different costs and
the second one needs a provider (**D27**).
