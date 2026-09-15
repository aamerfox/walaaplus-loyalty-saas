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
