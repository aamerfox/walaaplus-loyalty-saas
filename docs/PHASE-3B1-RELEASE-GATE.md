# Phase 3B.1 — public API release gate

| | |
|---|---|
| Baseline audited | `88972b6` — Prompts 1 and 2, including the signed-cursor correction |
| Method | Source, schema, triggers, grants, routes, UI, HTTP behaviour and documentation reconciled against each other and against the database |
| Migration | **19**, `20260925120000_api_key_name_active_only` — additive correction, explained in §3.1 |
| Staging | **not contacted.** No external network call, no provider, no device, no real key, no customer data |

This is an audit of finished work. Everything below is either a claim I checked and found true, or a
defect I found, fixed and red-proved. Where a claim in the existing documentation turned out to be
wrong, that is said plainly rather than quietly corrected.

---

## 1. Findings

| # | Severity | Area | Finding | Status |
|---|---|---|---|---|
| **F1** | **HIGH** | Key lifecycle | **Rotation could not keep its own name.** The owner screen pre-fills the replacement name with the current one, so the default path through the rotation flow failed every time | Fixed — migration 19 |
| **F2** | **HIGH** | Key lifecycle | **A name was burned permanently.** Revoking a key made its name unusable forever; keys expire every ninety days, so names accumulated | Fixed — migration 19 |
| **F3** | **HIGH** | `/api/v1/events` | **The keyset cursor was not a seek.** It read every newer row in the business's feed and discarded it — the `OFFSET` behaviour the cursor exists to avoid, and contrary to what the documentation claimed | Fixed — row-value predicate |
| **F4** | MEDIUM | UI / accessibility | **The one-time reveal was silent to assistive technology**, and the value cannot be recovered | Fixed — live region + focus |
| **F5** | MEDIUM | Public API | **`lastUsedAt` was written on every request** — ten `UPDATE`s a second against one row at the documented rate limit | Fixed — sixty-second resolution |

No critical finding. Nothing found in tenant isolation, authentication, authorisation, secret
handling, CORS, caching or the no-delete guarantees — §4 lists what was checked and holds.

---

## 2. What the two HIGH lifecycle findings actually were

### 2.1 F1 — rotation could not keep its own name

`rotateKey` revokes the predecessor and inserts the replacement **in one transaction**, and the
predecessor's row stays. That is the no-delete rule working exactly as designed: the row is the
record that this business held a credential between two dates.

Migration 18 created `ApiKey_businessId_name_key` as an **unconditional** unique index. So the
replacement collided with the row it was replacing, and the owner got *"You already have a key with
that name."*

This was not an edge case. `ApiKeysClient` pre-fills the replacement name with the current name, so
**pressing Replace and then Replace it — the default path, with nothing typed — failed every time.**
It is also the action `docs/PUBLIC-API-V1.md` §8 tells a consumer to take when they suspect a key.

Found by doing it. The existing rotation test renamed the key ("Before" → "After"), so it passed.

### 2.2 F2 — a name was burned forever

Same root cause, slower to notice: revoke `Reporting` and no key could ever be called `Reporting`
again. Keys expire after ninety days, so a business rotating on schedule accumulates dead names for
as long as it uses the product, and eventually has to call the same job `Reporting 4`.

### 2.3 The fix, and why it is the right scope

Migration 19 replaces it with a partial index under a new stable name:
`ApiKey_businessId_activeName_key`, `UNIQUE (businessId, name) WHERE state = 'ACTIVE'`.

The name is the owner's own label and it exists so they can tell their **live** keys apart in a
list. Two retired keys sharing a name confuses nobody — the list shows state and dates, and audit
rows reference a key by id. So uniqueness belongs on the active set.

**Safe on an environment where migration 18 is already applied.** The new index is strictly weaker:
unconditional uniqueness implies uniqueness over the ACTIVE subset, so the `CREATE` cannot fail on
existing rows whatever they hold. Nothing is deleted, nothing is rewritten, no row changes.

**Still a real mutual exclusion.** A partial unique index is serialized by PostgreSQL, so two
simultaneous creations of the same live name cannot both succeed — the same reason the active-slot
ceiling is an index and not a trigger.

**And the schema stops claiming otherwise.** `prisma/schema.prisma` declared
`@@unique([businessId, name])`, which `migrate diff` reported as new drift the moment the real index
became partial. The declaration was removed rather than documented, following the `activeSlot`
precedent in the same model: a schema that states a uniqueness rule the database does not enforce is
worse than a schema that is silent about it. Nothing looks a key up by that pair.

### 2.4 The order of the two statements, and what it costs — corrected under review

The first draft dropped the old index and then created the new one. That is backwards: it takes the
**most restrictive lock in front of the longest operation.** Migration 19 now creates first.

| Statement | Lock on `ApiKey` | Effect |
|---|---|---|
| `CREATE UNIQUE INDEX … WHERE state = 'ACTIVE'` | `SHARE` | blocks writers; **readers are served**, so authentication keeps working through the build |
| `DROP INDEX` (old) | `ACCESS EXCLUSIVE` | blocks readers and writers — but runs **last**, and is a catalog operation rather than a build |

Locks are held until the transaction commits, so from the `DROP` onwards the table is unavailable to
everyone for the remainder of the transaction. That remainder is now one catalog update instead of
an index build, which is the entire point of the reordering.

**Uniqueness is never absent.** During the build the old unconditional index still enforces a
stricter rule; once the new index is valid both enforce; then the stricter one is dropped. Prisma
runs the file in one transaction, so no committed state lacks an active-name guarantee, and any
failure rolls back to migration 18's arrangement. Walked one statement at a time in
`tests/integration/api-key-name-reuse.test.ts`.

**Why not `CONCURRENTLY`.** `CREATE INDEX CONCURRENTLY` and `DROP INDEX CONCURRENTLY` cannot run
inside a transaction block, and Prisma runs a migration file inside one. Using them would mean
giving up the guarantee above — committed intermediate states an operator could observe with only
one index present, and, if a concurrent build failed, an `INVALID` index enforcing nothing that has
to be dropped by hand before a retry. Atomicity is worth more here than availability, because the
alternative failure mode is a half-migrated production database that has quietly stopped
constraining live key names.

### 2.5 No duration is claimed, and why the first draft's was wrong

The first draft said the build takes milliseconds "because a business holds at most five active
keys". That reasoning does not hold: **the five-key ceiling bounds ACTIVE rows only.** Retired
predecessors are never deleted — `ApiKey` has no retention or deletion policy at all, which is the
open owner decision **D31** — and keys expire every ninety days, so the table grows without bound
for as long as the product is used. The build scales with total rows, not with live ones.

So no duration is stated. What is stated instead: writes block for the build and reads do not;
reads block only from the `DROP` to the commit; nothing else in the product touches this table.
**Deploy in a controlled low-traffic window** — not because the cost is known to be high, but
because it is not known at all, and `SELECT count(*) FROM "ApiKey"` is the only honest way to size
one.

---

## 3. F3 — the cursor was not doing what the documentation said

### 3.1 Measured, at 40,000 events

| Predicate | Index Cond | Rows discarded | Buffers | Time |
|---|---|---|---|---|
| `at < X OR (at = X AND id < Y)` — what shipped | `businessId` only | **20,001** | 595 | 13.8 ms |
| `(at, id) < (X, Y)` — the fix | `businessId` **and** `occurredAt` | 1 | **5** | **0.12 ms** |

The OR form is what a Prisma `where` can express, and PostgreSQL cannot push an OR across two
columns into an index range. So the cursor read every row between the top of the feed and the
caller's position and threw it away: **cost growing linearly with depth, exactly as `OFFSET` does.**

The documentation claimed "an indexed seek at any depth". It was not one. Correctness was never
affected — every pagination test passed throughout, which is precisely why this needed measuring
rather than reading.

### 3.2 The fix

`listApiEvents` now emits the row-value comparison, which requires raw SQL because a Prisma `where`
cannot express it. Every value is a bound template parameter, `businessId` still comes from the
authenticated key and is the first term of the `WHERE`, and the six exposed columns are listed
literally. `$queryRawUnsafe` is not used and a test asserts it never appears in that file.

### 3.3 No index was added, deliberately

The obvious follow-up is `(businessId, occurredAt DESC, id DESC)` to absorb the remaining
incremental sort. After the predicate fix the query reads **five buffers** and the sort touches one
tie group — so that index would cost a write on every event insert to solve a problem that no longer
exists. Measured, then left alone.

### 3.4 Three attempts at the test, two of which proved nothing

Worth recording, because the failure mode is the one this gate exists to catch:

1. **EXPLAINing a hand-written statement** of the same shape proved what PostgreSQL does with the
   predicate and **nothing about what the service sends**. Reverting the service left it green.
2. **Reading `pg_stat_user_tables.idx_tup_fetch`** around a service call measured nothing at all:
   those statistics are per-backend and pending, the service runs on the application pool, and
   `pg_stat_force_next_flush()` flushes only the connection that calls it. The delta was **zero in
   both states**, so every assertion passed vacuously.
3. **Capturing the statement the service actually sends** and EXPLAINing that. `src/server/db.ts`
   caches its client on `globalThis.__walaaplusPrisma` — a global that exists for hot-reloads — so a
   test can install a query-logging client there, read the SQL off the wire, and explain it. No
   shipped code changed.

Only the third goes red when the fix is reverted. The first two were removed, not kept alongside.

---

## 4. F5 — a busy key was a write storm

The rate limit permits **600 requests per key per minute** and `touchKey` wrote on every one: ten
`UPDATE`s a second against a **single row**. Ten row locks a second that every other request for
that key queues behind, ten dead tuples a second, and a database round-trip awaited on the latency
path of every read — to move a timestamp nobody reads more than once a day.

`lastUsedAt` is now written at most once a minute per key. The other 599 requests match zero rows,
and `updateMany` with no match is not a write: no tuple, no lock, no bloat.

**What it costs, stated:** `lastUsedAt` can be up to a minute behind. That is inside what the column
already promised — `api_key_guard` makes it monotonic precisely so the record of use can only ever
*understate* how recently it happened — and an owner reading their key list is answering a question
about days.

Asserted with `xmin`, not just the timestamp: a same-value `UPDATE` would still take the lock and
still leave a dead tuple, and a timestamp comparison would call that unchanged.

---

## 5. Checked and holding

Each of these was reconciled against source and, where it is a database guarantee, against the
database as the **restricted runtime role** rather than the migrator.

### 5.1 Key lifecycle

| Claim | Verdict |
|---|---|
| Owner-only create / list / rotate / revoke | Holds — `requireApiKeyOwner` in the service, not the route; manager and cashier get 403 and the screen 404s |
| Cross-tenant isolation | Holds — `businessId` in every `WHERE`; another tenant's key id is a 404 that does not confirm existence |
| Five active keys per business | Holds — partial unique index on `activeSlot`, proved under overlapping transactions |
| Expiry, lazy sweep, revocation, rotation | Holds — `expiresAt` is the authority, not `state` |
| Both rest states terminal | Holds — controlled 409, never a PostgreSQL message |
| Audit history | Holds — created / rotated / revoked, with the name and public prefix only |
| No delete | Holds — removed at the grant **and** refused by the trigger; proved for the runtime role by `permission denied` and for the migrator by the trigger |
| Raw key shown once, no reveal path | Holds — returned from the minted value, never from a column; no action, route or column can produce it again |

### 5.2 Authentication and authorisation

| Claim | Verdict |
|---|---|
| `X-API-Key` only | Holds — credential-shaped query parameters refused `400` **before** authentication; no cookie read; `GET` has no body |
| One generic refusal for all five conditions | Holds — byte-identical bodies asserted |
| Tenant only from the key | Holds — no parameter anywhere can name a business |
| Scope enforced | Live, and **unreachable end to end today** because `ApiScope` has one value. Asserted at the predicate instead, and said plainly rather than faked |
| Rate limit after authentication | Holds — an unknown key writes nothing at all |
| `no-store`, `Vary`, no CORS | Holds on every status: 200, 400, 401, 404, 429 |
| No OPTIONS or write surface | Holds — `GET` is the only export on both routes |

### 5.3 The revocation race, stated precisely

Authentication and the event read are **two statements, not one transaction**. A key revoked between
them serves that one in-flight request. That is unchanged, still not closed, and still correct to
leave open: a row lock on the key for the duration of every read would narrow something a lock
cannot eliminate either.

What is guaranteed and tested: the in-flight request can only return that tenant's own events, the
next request is refused, and nothing is written on the way through except `lastUsedAt`.

### 5.4 Cursor integrity

Signed with a key derived from `NEXTAUTH_SECRET` under a distinct label, bound to the business,
verified **before** the payload is parsed and before any row is read, constant-time comparison,
bounded length. Altered `at`, altered `id`, altered signature, another business's cursor and the
pre-fix unsigned format are each the fixed `400` with nothing echoed.

**Key rotation does not invalidate a cursor**, because the binding is the business and not the key.
That is deliberate and documented: a consumer told to replace a suspect key must not lose their
place in the feed as the price of doing it.

### 5.5 Checked, and deliberately not changed

| Considered | Why it is not a finding |
|---|---|
| Dates rendered as `toISOString().slice(0, 10)` in `<bdi>` | The product-wide convention — campaigns, customers, redemptions, referrals all do this. The keys screen conforms; changing only this screen would make it the odd one out |
| `apiInternal` logging `e.message` | Narrowed to `{name, message}`, mirroring `src/server/http.ts`. Prisma validation errors do embed arguments, but reaching one here requires a malformed call and `keyDigest()` always produces 64 hex characters. No demonstrable path; not "fixed" on speculation |
| An extra covering index for the feed | §3.3 — measured away rather than added |
| Binding the cursor to the API key | §5.4 — would refuse entitled requests and punish rotation |

### 5.6 Regressions

`B7` still answers a constant 410 and `/join/<anything>` is unchanged. Cards, scanner, referrals,
promotions, wallet and share links, the webhook system and its egress topology, and `/health` are
untouched — no file under any of them is modified, and the full suite covers them. `public/` is
byte-identical.

---

## 6. Verification

Recorded in `docs/evidence/phase-3b1-prompt-3.md` with the exact figures.

---

## 7. Decisions

**No new owner decision arises from this gate.** D31 (API-key retention) and D32 (warning an owner
before a key expires) are unchanged and still open. The name-uniqueness scope in §2.3 is a defect
correction, not a choice to put to the owner: the previous behaviour prevented an action the product
already told owners to take.
