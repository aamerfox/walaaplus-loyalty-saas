# Phase 3B.1 — public API and API keys: implementation notes

Covers **Prompt 1** (the key) and **Prompt 2** (the surface). The reasoning and the threat model are
in `docs/API-KEY-CAPABILITY-MATRIX.md`; the consumer contract is `docs/PUBLIC-API-V1.md`. This is the
engineering record: what was built, where it lives, and the decisions a later reader would otherwise
have to reconstruct.

---

## 1. Where everything is

| File | What it owns |
|---|---|
| `prisma/migrations/20260924120000_api_keys/` | Migration 18: `ApiScope`, `ApiKeyState`, the `ApiKey` table, its CHECKs, its indexes, and two triggers |
| `prisma/migrations/20260925120000_api_key_name_active_only/` | Migration 19: `ApiKey_businessId_activeName_key`, unique among **ACTIVE** keys. Migration 18 made it unconditional, which stopped a rotation keeping its own name. Creates before it drops — see the release gate §2.4 |
| `src/server/api/keys.ts` | Minting, the digest, the slot ceiling, create / rotate / revoke / list |
| `src/server/api/auth.ts` | `X-API-Key` verification, the generic refusal, `ApiContext`, `touchKey` |
| `src/server/api/contract.ts` | The envelope, error codes, the page assembler, page-size clamping. **No key material** — the signer is injected |
| `src/server/api/cursor.ts` | Cursor signing and verification: the derived key, the binding, the constant-time check |
| `src/server/api/rate-limit.ts` | The per-key window, consumed only after authentication |
| `src/server/api/events.ts` | The public event projection, the tenant filter and the sort |
| `src/server/api/request.ts` | The `/api/v1` pipeline: the order of the checks, the headers, the error mapper |
| `src/app/api/v1/events/route.ts` | `GET /api/v1/events` |
| `src/app/api/v1/events/[eventId]/route.ts` | `GET /api/v1/events/{eventId}` |
| `src/app/api/staff/api-keys/route.ts` | The owner's create / rotate / revoke, session-authenticated |
| `src/app/[locale]/business/integrations/ApiKeysClient.tsx` | The owner screen |

---

## 2. The key itself (Prompt 1)

### 2.1 An unsalted digest, which is right here and wrong elsewhere

This is the product's third bearer capability. Share links use an unsalted SHA-256 of 32 random
bytes; coupon codes use a per-business salt because a six-character human-chosen code has a
dictionary. **An API key follows the share-link pattern**, and not by preference: authentication has
to find the key from the value alone, in one indexed lookup, before it knows which business is
involved. A per-row salt would mean scanning every key and hashing against each — slow, and a timing
oracle. 256 bits of `randomBytes` is what makes the unsalted digest safe.

### 2.2 The ceiling is a slot, not a count

`MAX_ACTIVE_KEYS_PER_BUSINESS` is enforced by an `activeSlot INTEGER` column and
`UNIQUE (businessId, activeSlot) WHERE activeSlot IS NOT NULL`.

A count read before an insert is not a ceiling — two concurrent creations each read four and each
insert a fifth. A partial unique index **is** serialized by PostgreSQL: the second inserter blocks on
the first's uncommitted index entry and gets `23505` when it commits. `freeSlot` picks a free slot at
random and `isSlotRace` retries once per slot, so a loser looks again rather than reporting a full
business that is not full.

This is the same lesson as migration 17's `WebhookDelivery` index, learned there and applied here
from the start: **a trigger that reads is a check, not a mutual exclusion.**

### 2.3 Both rest states are terminal

`api_key_guard` allows `ACTIVE → EXPIRED` and `ACTIVE → REVOKED` and permits no state change after
either. The service refuses **exactly** what the trigger would, before the trigger has to: an earlier
`revokeKey` guarded only against `REVOKED`, so an `EXPIRED` key reached the `UPDATE` and came back as
`23514 — "ApiKey: EXPIRED is a rest state"`. That is a raw database error where a conflict was
intended, and through the owner route it would have been a 500 carrying PostgreSQL's words.

The general rule, worth carrying past this table: **a service refuses exactly what the database would
refuse, before the database has to.** A service that refuses less than its triggers do is a service
whose error messages are chosen by PostgreSQL.

### 2.4 `expiresAt` is the authority, not `state`

The sweep to `EXPIRED` is lazy — it runs when a key is issued — so a lapsed key keeps
`state = ACTIVE` until the business creates another. `authenticateApiKey` therefore reads `expiresAt`
directly. A security decision does not wait on housekeeping.

A lapsed-but-`ACTIVE` key **can** still be revoked, deliberately: the decision is made on `state`
alone, the same column the trigger decides on, so the service and the database never disagree; and
revoking releases the slot and records that the owner ended the key rather than let it run out.

---

## 3. The surface (Prompt 2)

### 3.1 One pipeline, and the order is the design

`guardApiRequest` runs five steps and they only work in this order:

1. **Refuse credential-shaped query parameters** — before the key is read, so a key in a URL is never
   hashed, never looked up, and never reaches a log line that records the path.
2. **Authenticate** — a read, one generic refusal for all five failure conditions.
3. **Authorise the scope** — separate from step 2, so "who are you" and "may you do this" produce
   different statuses.
4. **Consume the rate-limit window** — the first **write** of the request, and therefore last among
   the checks. Before step 2 it would let an attacker turn each of a million guessed keys into a row
   in `AuthRateLimit`.
5. **Record the use** — `lastUsedAt`, only for a request that is going to be served.

Putting it in one function is not tidiness: a second handler reimplementing this would eventually get
one of them the wrong way round, and step 4 before step 2 is a denial-of-service on our own database.

### 3.2 The event projection was chosen column by column

`IntegrationEvent` was built a phase earlier with typed columns and **no JSON payload**, explicitly so
that a future consumer could be shown all of it. Six of its eight columns are exposed; `businessId`
and `createdAt` are not, and §11.1 of the capability matrix says why for each.

The categories that must never appear are not filtered — **they are unreachable**. There is no
relation from `IntegrationEvent` to a customer, and no query path from a key to a person.

### 3.2a A key's name is unique among live keys only

Migration 18 made `(businessId, name)` unconditionally unique. Rotation revokes the predecessor and
inserts the replacement in one transaction and the predecessor's row **stays** — so the replacement
collided with the row it was replacing, and since the screen pre-fills the current name, the default
rotation path failed every time. Revoking a key also burned its name permanently.

Migration 19 scopes it: `ApiKey_businessId_activeName_key`,
`UNIQUE (businessId, name) WHERE state = 'ACTIVE'`. The name exists so an owner can tell their
**live** keys apart; two retired keys sharing one confuses nobody. The new index is strictly weaker
than the old one, so it cannot fail to build on an environment that already has migration 18.

It **creates the replacement before dropping the original**, under a new name rather than reusing
the old one: dropping first would put an `ACCESS EXCLUSIVE` lock in front of the index build, and
renaming afterwards would buy nothing but another catalog lock. `CREATE INDEX` takes `SHARE` — writers
wait, readers and therefore authentication do not — and the `ACCESS EXCLUSIVE` of the `DROP` lands
last, on a catalog operation. Both are in one Prisma transaction, so no committed state lacks an
active-name guarantee. Release gate §2.4 and §2.5 carry the lock table, the reason `CONCURRENTLY` is
not used, and why no duration is claimed.

### 3.3 The order is total because it has to be

`ORDER BY "occurredAt" DESC, "id" DESC`, with a two-column keyset comparison
(`occurredAt < at OR (occurredAt = at AND id < id)`).

`occurredAt` is `TIMESTAMP(3)` set from `now()`, which is the transaction's start time — two
transactions beginning in the same millisecond produce two events that compare exactly equal. A sort
with ties may be returned differently on each execution, which is precisely how a paginating client
sees one row twice and another never. Proved with six events forced onto one timestamp.

### 3.3a The keyset comparison has to be a row-value comparison

`ORDER BY` alone does not make a cursor a seek — the predicate does. Prompt 2 used
`at < X OR (at = X AND id < Y)`, which is what a Prisma `where` expresses, and PostgreSQL cannot push
an OR across two columns into an index range: it read every newer row in the business's feed and
discarded it, at a cost that grew with depth exactly as `OFFSET` does. 20,001 rows discarded and 595
buffers to return 26, against 1 row and 5 buffers for the row-value form.

So `listApiEvents` builds raw SQL. Every value is a bound template parameter, `businessId` is the
first term and still comes from the key, `$queryRawUnsafe` is never used, and a test asserts all of
that. `docs/PHASE-3B1-RELEASE-GATE.md` §3 records the measurement and why no extra index was added.

### 3.4 The cursor is opaque **and authenticated**

This shipped wrong the first time and was corrected under review. The original argument — that
signing was unnecessary because the tenant filter comes from the key, so tampering could only move a
caller's window within their own events — was true and beside the point. **"Tampering is harmless"
is not "tampering is detected."** It also left the whole property resting on one `WHERE` clause
somewhere else, which is a defence that lasts until somebody edits that line.

`src/server/api/cursor.ts` now signs: `v1.<payload>.<HMAC-SHA256>`.

**The key is derived, never raw.** `createHmac("sha256", NEXTAUTH_SECRET).update("walaaplus:api:v1:cursor")`
— the same idiom `src/server/security/rate-limit.ts` uses for its pepper, so there is one way this
codebase scopes a root secret. `INTEGRATION_ENCRYPTION_KEY` was considered first and rejected
because it is **optional by design**: signing cursors with it would break page two wherever webhooks
are unconfigured, and a present-or-fallback arrangement would make the signing key change the day
webhooks were configured.

**Bound to the business, not to the key.** A cursor names a position in a feed the business owns and
every active key may read the same rows; key binding would refuse entitled requests and would break
a traversal the moment a consumer did the thing we tell them to do — replace a key they suspect. It
would buy nothing, because a cursor opens nothing without a key.

**MAC before parse.** Attacker-chosen bytes never reach `JSON.parse`, and **no event row is read** on
a failing path. Length-prefixed fields in the signed message, `timingSafeEqual` for the comparison.

The behaviour change worth noting for anyone reading the old tests: a cross-tenant cursor replay used
to be **honoured** as a position in the replayer's own feed. It is now a `400`. Both are safe; only
the second is detected.

### 3.5 Clamp what has a default; refuse what does not

A `limit` of `abc` is clamped to the default. A `cursor` of `abc` is a `400`. That looks inconsistent
and is not: the first has one obviously-safe reading and the second has none, and quietly serving page
one would restart a consumer's traversal without telling it — a client looping "fetch page, follow
cursor" would re-ingest the whole feed forever.

### 3.6 No CORS, enforced twice

No `Access-Control-Allow-Origin` is sent by any response. The shape of the API enforces it before the
missing header does: `X-API-Key` is not a CORS-safelisted request header, so a cross-origin call must
preflight with `OPTIONS`; no route exports an `OPTIONS` handler; the browser refuses before the real
request leaves.

### 3.6a `lastUsedAt` is written at most once a minute

It used to be written on every request. At the documented ceiling of 600 requests per key per minute
that is ten `UPDATE`s a second against one row: ten row locks that every other request for that key
queues behind, ten dead tuples a second, and a round-trip awaited on the latency path of every read —
to move a timestamp nobody reads more than once a day.

A sixty-second floor in the `WHERE` turns the other 599 into a statement that matches no row and
writes nothing. The cost is that `lastUsedAt` can be a minute behind, which is inside what the column
already promised: the trigger makes it monotonic precisely so the record of use can only ever
understate how recently it happened.

### 3.7 A read writes no audit row

`lastUsedAt` is the record that a key was used. One audit row per read would let a key holder turn
their own rate limit into unbounded writes to a table nobody prunes. Lifecycle actions — create,
rotate, revoke — **are** audited, with the name and the public prefix and never the value or its
digest.

---

## 4. The owner screen

It is the third section of `/business/integrations`, after the event history and the webhook
destinations, and owner-only like the second.

**Why not its own page.** The sidebar does not filter by role, so a new navigation entry would have
advertised an owner-only screen to every cashier. The three sections are also one subject: what
reaches this business from outside, and what leaves it.

**Why there is no reveal button.** There is nothing to reveal. The digest is one-way and no route can
produce a key from a row. The value is shown once, held in React state, offered with a copy button,
and gone on dismissal or navigation. Nothing writes it to `localStorage`, `sessionStorage`,
`indexedDB`, a cookie or the URL — asserted twice, once by reading the source and once by reading the
browser's storage after a real creation.

The copy button fails honestly: `navigator.clipboard` needs a secure context and permission, and when
it is refused the value stays on screen and selectable with a sentence saying to copy it by hand.

---

## 5. The revocation window, not papered over

Authentication and the event read are **two statements, not one transaction**. A key revoked between
them serves that one in-flight request.

The window is not closed. Holding a row lock on the key for the duration of every read would slow
every request to narrow something a lock cannot eliminate either — a revocation committing one
microsecond later is still one the in-flight request did not see.

What is guaranteed, and tested: the in-flight request can only ever return that tenant's own events,
which the key was entitled to a moment earlier; the **next** request is refused; and nothing is
written on the way through except `lastUsedAt`.

---

## 6. Test coverage

| File | Tests | What it holds |
|---|---|---|
| `tests/integration/api-keys.test.ts` | 32 | The services: minting, show-once, the ceiling, terminal states, authentication |
| `tests/integration/api-key-integrity.test.ts` | 21 | The database refuses a wrong row, under the restricted runtime role |
| `tests/integration/api-key-concurrency.test.ts` | 7 | The slot ceiling under overlapping transactions |
| `tests/integration/api-keys-routes.test.ts` | 10 | The owner route: who may reach it, what it returns, the controlled conflict |
| `tests/integration/public-api-events.test.ts` | 30 | `/api/v1`: authentication, tenancy, pagination, headers, rate limiting, the revocation boundary |
| `tests/integration/public-api-cursor.test.ts` | 13 | The signed cursor: round-trip, every tamper case, the binding, the legacy format |
| `tests/integration/api-key-name-reuse.test.ts` | 10 | Migration 19: rotation keeping its name, name reuse after revocation and expiry, the partial index as the runtime role sees it |
| `tests/integration/public-api-scale.test.ts` | 8 | The feed is a seek at depth — measured from the service's own SQL — and a busy key is not a write storm |
| `tests/unit/api-contract.test.ts` | 21 | The envelope, the cursor, and the source scans that keep the key out of places it must not reach |
| `tests/e2e/api-keys-ui.spec.ts` | 11 | The owner screen in English and Arabic, and what a browser session cannot do |

### Guarantees red-proved

Each was removed in turn and the suite re-run; every one took its own test red.

One entry is honestly different. Replacing the **derivation** with the raw `NEXTAUTH_SECRET` as the
HMAC key still produces cursors that sign and verify correctly, so no behavioural test can see it —
it is a key-hygiene property, not a functional one. It is caught by a source assertion in
`tests/unit/api-contract.test.ts`, and that is the right instrument for it rather than a behavioural
test that would have to pretend to observe something it cannot.

| Removed | Tests that failed |
|---|---|
| the tenant filter on the list | 2 |
| the tenant filter on the single read | 3 |
| the `id` tie-break in the sort and the cursor | 3 |
| the credential-shaped-parameter refusal | 2 |
| `Cache-Control: no-store` and `Vary` | 5 |
| the rate-limit consumption | 3 |
| the cursor MAC entirely | 7 |
| the business binding in the MAC | 4 |
| verify-before-parse ordering | 7 |
| the route's call to `verifyCursor` | 7 |
| the labelled key derivation | 1 (source assertion — see below) |

---

## 6a. The release gate

`docs/PHASE-3B1-RELEASE-GATE.md` audits all of the above against source, schema, triggers, grants,
routes, UI and HTTP behaviour. It found five defects — two of them breaking the owner's rotation
flow, one making the cursor a scan — fixed and red-proved each, and records what was checked and
left alone, including two regression tests that passed for the wrong reason and had to be replaced.

---

## 7. What is deliberately absent

No write endpoint. No second scope. No key management through `/api/v1` — a leaked key cannot extend
its own life. No key deletion (**D31**). No OpenAPI endpoint. No CORS. No sandbox key, no IP
allow-listing, no per-key scope selection while one scope exists. No provider, OAuth, POS, or
outbound call of any kind; the webhook egress built in Phase 3B is the only outbound path this
product has, and it is unrelated to this one.

---

## 8. Verified, and not

**Verified locally**: everything in §6, against a real PostgreSQL database and the real route
handlers, plus the full gate, the browser suite twice, `npm audit`, migration status and diff, and
secret and raw-capability scans.

**Not verified, and not claimed**: staging, any provider, any device, any point-of-sale, any wallet,
any external network. No external system has called this API. Staging evidence is Freebuff's to
supply after an independent review.
