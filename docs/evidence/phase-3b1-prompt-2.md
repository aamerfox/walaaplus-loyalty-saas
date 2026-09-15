# Phase 3B.1 Prompt 2 — owner API-key management and the read-only public events API

| | |
|---|---|
| Branch | `rebuild/phase-0-foundation` |
| Baseline | `365fd78` — Prompt 1 plus the `revokeKey` terminal-state correction |
| Capability, data-exposure and threat matrix written first | `docs/API-KEY-CAPABILITY-MATRIX.md` Part II (§9–§16) |
| Consumer contract | `docs/PUBLIC-API-V1.md` |
| Implementation record | `docs/PHASE-3B1-IMPLEMENTATION.md` |
| Migration | **none.** Migration 18 unchanged, not amended, not re-ordered. No migration 19 was needed |
| New secret, env var, Compose, Caddy, DNS or firewall change | **none** |
| Staging | **not contacted.** No external network call, no provider, no device, no real customer data |

---

## 1. What was built

Three routes and one screen.

| Route | Auth | Who |
|---|---|---|
| `GET /api/v1/events` | `X-API-Key` | any holder of a key with `events:read` |
| `GET /api/v1/events/{eventId}` | `X-API-Key` | the same |
| `POST /api/staff/api-keys` | session cookie | the business **owner**, nobody else |

The owner screen is the third section of `/business/integrations`, after the event history and the
webhook destinations. It was not given its own page because the sidebar does not filter by role, so a
new navigation entry would have advertised an owner-only screen to every cashier.

**No migration.** The whole prompt is service, route, UI and documentation. The one schema question —
whether the event projection needed a column that does not exist — was answered by reading
`IntegrationEvent`: it was built a phase earlier with typed columns and no JSON payload precisely so
that all of it could be shown to a consumer, and six of its eight columns are.

---

## 2. Data exposure, decided column by column

`docs/API-KEY-CAPABILITY-MATRIX.md` §11 holds the full table. The short form:

**Exposed:** `id`, `type`, `entityType`, `entityId`, `occurredAt`, `envelopeVersion`.

**Not exposed:** `businessId` — the key already determines it, and a field that looks like a tenant
selector is one a client eventually tries to set. `createdAt` — a duplicate of `occurredAt` with no
distinct meaning out here. Both relations.

**Unreachable rather than filtered:** customer names, phone numbers, email addresses, card ids, wallet
passes, share links, coupon codes, balances, amounts, webhook URLs, signing secrets, key digests,
audit rows. There is no relation from `IntegrationEvent` to a person, and no query path from a key to
one.

Asserted directly: a test enrols a customer with a real Syrian phone number and an Arabic name,
records a redemption, then checks the serialised API response contains none of the phone number, its
last six digits, either name, the card id, the promotion id or the coupon code — and *does* contain
the redemption id, which is the correlation key and an internal uuid holding nothing about anybody.

---

## 3. The five decisions worth arguing about

### 3.1 A credential-shaped query parameter is refused before authentication

`?key=`, `?api_key=`, `?token=`, `?secret=`, `?access_token=`, `?authorization=`, `?password=`,
`?credential=`, `?bearer=` and case variants → `400`, **before the key is read**, whether or not the
header is also present and valid.

v1 has exactly two parameters, so nothing legitimate is refused. What it buys: a merchant who reaches
for the URL form is told at once instead of getting a `401` and retrying it — each retry writing their
key into a proxy log, a browser history and an analytics row we cannot reach to erase. The refusal
names the parameter and never its value.

### 3.2 The cursor is opaque and deliberately unsigned

Signing needs a secret, and this phase may not add one — nor should a pagination token be the reason a
new secret enters a deployment. There is also nothing in it to protect: a timestamp and an id the
caller was just handed.

What makes tampering worthless is that **the tenant filter comes from the key**, not from the cursor.
Two tests hold it: a cursor minted by business A and replayed with business B's key returns B's own
rows; and a hand-built cursor naming one of B's rows, replayed with A's key, still returns only A's.

### 3.3 Clamp what has a default; refuse what does not

`limit` of `0`, `-5`, `abc`, `1e9` → clamped, `200`. `cursor` of anything we did not issue → `400`.

Not inconsistent: a bad `limit` has one obviously-safe reading, a bad cursor has none. Silently
serving page one would restart a consumer's traversal without telling it, and a client looping "fetch
page, follow cursor" would re-ingest the whole feed forever. An **empty** `?cursor=` is treated as
absent, because it cannot have come from following `nextCursor`.

### 3.4 A read writes no audit row

`lastUsedAt` is the record that a key was used. One audit row per read would let a key holder turn
their own rate limit into unbounded writes to a table nobody prunes. Twenty reads, zero rows, asserted.

Lifecycle actions — create, rotate, revoke — **are** audited, with the name and the public prefix and
never the value or its digest.

### 3.5 The revocation window is stated, not closed

Authentication and the event read are two statements, not one transaction, so a key revoked between
them serves that one in-flight request. The test says so rather than claiming otherwise.

Closing it would mean a row lock on the key for the duration of every read, to narrow something a lock
cannot eliminate either. What is guaranteed instead, and asserted: the in-flight request can only ever
return that tenant's own events, which the key was entitled to a moment earlier; the next request is
refused; and nothing is written on the way through except `lastUsedAt`.

---

## 4. Verification

| Check | Result |
|---|---|
| `node scripts/gate.mjs` | **GATE PASSED, 16/16 steps, 736.9s** |
| Unit tests | **637** passed (43 files) |
| Integration tests | **1072** passed (66 files) |
| Playwright, run 1 | **133** passed |
| Playwright, run 2 | **133** passed |
| `npm audit --omit=dev` | 0 vulnerabilities |
| `npm audit` (including dev) | 0 vulnerabilities |
| `prisma migrate diff` | only the pre-existing cosmetic `ConsentRecord` FK/index naming difference from Phase 2 Prompt 2. **No new drift**, which is what confirms no schema change was made |
| Migration status | 18 migrations, none pending, **migration 18 unchanged** |
| `git diff --check` | clean |
| Raw-key scan (`wpk_` shape, whole repo) | no match |
| Secret-literal scan | no match |
| Control-byte scan (17 changed files) | none |
| `public/` | 0 changed files |
| `prisma/` | 0 changed files |
| `docker-compose*.yml`, `deploy/` | 0 changed files |

### 4.1 What the production build reports

Both public routes build as **dynamic**, never prerendered:

```
ƒ /api/v1/events
ƒ /api/v1/events/[eventId]
```

That matters: a statically optimised copy of a response selected by a secret header would be one
tenant's page served from a build artefact.

### 4.2 One failure, found and fixed

The first full gate run failed on **one** test out of 1072: `api-keys.test.ts` still asserted
`src/app/api/v1` did not exist, which was Prompt 1's correct claim and became false the moment this
prompt mounted the surface. It was replaced with the bound that is now true — two `GET` routes and no
write verb — rather than deleted. The run recorded above is the one after that fix.

---

## 5. Guarantees red-proved

Each protection was removed in turn and the suite re-run. Every one took its own test red, and none
of them was already failing.

| Removed | Tests that failed | Including |
|---|---|---|
| the tenant filter on the list | 2 | "returns only its own events" |
| the tenant filter on the single read | 3 | "gives one 404 for an unknown id, a malformed id and another tenant's id" |
| the `id` tie-break in the sort and the cursor | 3 | "does not duplicate or skip when several events share a millisecond" |
| the credential-shaped-parameter refusal | 2 | "refuses a credential-shaped parameter BEFORE authenticating" |
| `Cache-Control: no-store` and `Vary` | 5 | "is uncacheable and carries no CORS header" |
| the rate-limit consumption | 3 | "opens one window per key and refuses with a retry hint at the cap" |

---

## 6. Screenshots

`playwright-results/visual/`:

| File | Shows |
|---|---|
| `desktop-en-api-keys-empty.png` | The scope notice, the ninety-day lifetime and the ceiling, before a key exists |
| `desktop-en-api-key-revealed.png` | The one moment the value exists: warning, value, **Copy**, "I have saved it" |
| `desktop-en-api-key-rotated.png` | A replacement, with the predecessor already retired |
| `desktop-en-api-key-revoked.png` | A revoked row, with neither action offered |
| `desktop-ar-api-keys-empty.png` | The same screen in Arabic, right-to-left |
| `desktop-ar-api-key-revealed.png` | The Arabic reveal, with the key isolated left-to-right in a `<bdi>` |
| `phone-ar-api-key-revealed.png` | Phone width, Arabic |
| `desktop-en-api-keys-manager-denied.png` | A manager's view: the event history, and **no key section at all** |

These are viewport screenshots of the section rather than full-page ones. The shell scrolls `main`
rather than the document, so a full-page capture returns the top of the page and this section — which
sits below two others — never appears in it.

---

## 7. What is NOT claimed

- **No staging deployment, and no contact with staging.** Staging remains at `9ff24e6`; migration 18
  is Freebuff's to apply, and applying it is not a prerequisite for reviewing this work.
- **No external network call.** No system outside this repository has ever called `/api/v1`. Every
  test calls the route handler in-process against the local test database.
- **No provider, device, POS, wallet or OAuth work**, and none became possible. A read-only event feed
  is not a provider integration.
- **No load or performance claim.** The rate limit is enforced and tested at its boundary; it has not
  been measured under real traffic.
- **No CDN, reverse-proxy or TLS-termination behaviour claimed.** `Cache-Control: no-store` and `Vary`
  are set and asserted on the response; how a particular intermediary treats them is untested.
- **No claim about a real merchant's consumer.** `docs/PUBLIC-API-V1.md` §8 is advice, not evidence.

---

## 8. Files

**New**

```
src/server/api/events.ts
src/server/api/request.ts
src/app/api/v1/events/route.ts
src/app/api/v1/events/[eventId]/route.ts
src/app/api/staff/api-keys/route.ts
src/app/[locale]/business/integrations/ApiKeysClient.tsx
tests/integration/public-api-events.test.ts
tests/integration/api-keys-routes.test.ts
tests/e2e/api-keys-ui.spec.ts
docs/PUBLIC-API-V1.md
docs/PHASE-3B1-IMPLEMENTATION.md
docs/evidence/phase-3b1-prompt-2.md
```

**Changed**

```
src/app/[locale]/business/integrations/page.tsx   third section, owner-only
messages/en.json, messages/ar.json                the ApiKeys namespace, 40 keys each
tests/unit/api-contract.test.ts                   the source scans, updated for a surface that now exists
docs/API-KEY-CAPABILITY-MATRIX.md                 Part II
docs/BOOMERANGME-PARITY.md                        the public-API row
```

**Untouched, and checked**: `prisma/`, `public/`, `docker-compose*.yml`, `deploy/`, every scanner and
card route, the webhook system and its egress topology, B7.
