# WalaaPlus Public API v1

**Read-only. One scope. Server-to-server.**

This is the contract a merchant's developer builds against. `docs/API-KEY-CAPABILITY-MATRIX.md` is
the reasoning behind it; this is the reference.

Everything here is implemented and covered by tests that run against a real database. **Nothing here
has been exercised against staging, a real merchant, or any external network** — see §11.

---

## 1. What this API is, and what it is not

| | |
|---|---|
| Direction | **Read-only.** There is no write endpoint, and none may be added in v1 |
| Scopes | **One**: `events:read` |
| Tenancy | A key belongs to **exactly one business**, and the business is never a parameter |
| Transport | HTTPS, server-to-server. **No CORS**, so it cannot be called from a browser |
| Authentication | `X-API-Key` request header, and nothing else |
| Key lifetime | **90 days**, then it stops working |
| Keys per business | Up to **5 active** at once |

It answers one question: *what has this business recorded?* It cannot answer *who* — no endpoint
exposes a customer, a card, a phone number, a coupon code, a balance or an amount.

---

## 2. Getting a key

The owner of the business creates one in **Integrations → API keys**. Not a manager, not a cashier.

The value is shown **once**, at creation and at replacement. It is stored only as a SHA-256 digest,
so no screen, route or support request can produce it again. An owner who loses a key replaces it.

A key looks like:

```
wpk_1a2b3c4d_Xy7...43-characters...
└──┬───┘ └──┬───┘ └─────┬──────┘
  scheme  public id    secret
```

The first twelve characters are the public prefix and are shown in the owner's key list so they can
tell one key from another. The remaining 43 characters are the secret.

**Names.** Each key carries a label the owner chooses. It is theirs, it never appears in this API,
and it is unique among their **active** keys — so a replacement may keep the name of the key it
replaces, and a name becomes available again once the key holding it is revoked or expires.

---

## 3. Authentication

Send the key in the `X-API-Key` header:

```
GET /api/v1/events HTTP/1.1
Host: your-walaaplus-host
X-API-Key: wpk_1a2b3c4d_Xy7...
```

**The header is the only accepted location.**

- **Not the query string.** A request carrying a credential-shaped query parameter — `key`,
  `api_key`, `apikey`, `token`, `secret`, `access_token`, `auth`, `authorization`, `password`,
  `credential`, `bearer`, in any case — is refused `400` before the key is even read. A key in a URL
  is a key in a proxy log, a browser history and an analytics row, none of which we can reach to
  erase.
- **Not a cookie.** No cookie is read.
- **Not the body.** `GET` has no body and none is parsed.

### Every authentication failure gives the same answer

Missing, malformed, unknown, revoked and expired all produce an identical `401`:

```json
{ "apiVersion": "v1", "error": { "code": "UNAUTHORIZED", "message": "A valid X-API-Key is required" } }
```

Same status, same body, every time. A caller cannot learn that a value was once real, or that it
belongs to a business that exists, or that it was revoked rather than never issued. **The owner sees
which of those applies on their own screen**, where they are authenticated as a person.

If a key stops working unexpectedly, check the owner's key list. It shows the state and the expiry.

---

## 4. The envelope

Every response, success or failure, carries `apiVersion`.

**Success — a list:**

```json
{
  "apiVersion": "v1",
  "data": [ { "id": "…", "type": "…", "…": "…" } ],
  "page": { "nextCursor": "v1.eyJhdCI6….kJ8f…", "count": 25 }
}
```

**Success — a single object:** the same, with `data` as the object and **no `page` block**.

**Failure:**

```json
{ "apiVersion": "v1", "error": { "code": "BAD_REQUEST", "message": "…" } }
```

`code` is what you branch on. `message` is for a human reading a log, and its wording may change
without a version bump. Neither ever contains the key you sent, an internal identifier you did not
already have, or a database message.

### Error codes

| HTTP | `code` | Means |
|---|---|---|
| `400` | `BAD_REQUEST` | A cursor this API did not issue to you, or a credential in the query string |
| `401` | `UNAUTHORIZED` | Any authentication failure. All five are identical |
| `403` | `FORBIDDEN` | Authenticated, but the key's scope does not cover this endpoint |
| `404` | `NOT_FOUND` | No such event **for this key's business** |
| `429` | `RATE_LIMITED` | Over the per-key limit. Honour `Retry-After` |
| `500` | `INTERNAL` | Our fault. The message is fixed and carries no detail |

### Response headers

| Header | Value | Why |
|---|---|---|
| `Cache-Control` | `no-store` | The response is selected by a secret header and must never sit in a shared cache |
| `Vary` | `X-API-Key` | Belt-and-braces for an intermediary that ignores `no-store` |
| `Retry-After` | seconds | On `429` only |

**No `Access-Control-Allow-Origin` is ever sent.** This API is not callable from a browser, by
design: a key in a browser is a key published.

---

## 5. `GET /api/v1/events`

A page of this business's integration events, **newest first**.

### Query parameters

| Name | Type | Default | Behaviour |
|---|---|---|---|
| `limit` | integer | `25` | Clamped to `1…100`. An absent, zero, negative or unparseable value gets the default — never an error |
| `cursor` | opaque signed string | — | From the previous page's `page.nextCursor`, **passed back unchanged**. An empty value means "no cursor" |

Any other parameter is ignored, **except** the credential-shaped names in §3, which are refused.

A `cursor` that this API did not issue **to you** is a `400`. That covers an edited one, a
truncated one, one issued to another business, and one of the unsigned cursors this API produced
before the format was authenticated.

It is deliberately not treated as "start again": quietly serving page one would restart your
traversal without telling you, and a client looping "fetch page, follow cursor" would re-ingest the
whole feed forever.

### The event object

```json
{
  "id": "0f1c2d3e-4a5b-6c7d-8e9f-0a1b2c3d4e5f",
  "type": "PROMOTION_REDEMPTION_RECORDED",
  "entityType": "PROMOTION_REDEMPTION",
  "entityId": "9b8a7c6d-5e4f-3a2b-1c0d-9e8f7a6b5c4d",
  "occurredAt": "2026-09-15T10:04:31.221Z",
  "envelopeVersion": 1
}
```

| Field | Type | Meaning |
|---|---|---|
| `id` | uuid | This event. Stable, unique, and what `/events/{id}` takes |
| `type` | enum | `PROMOTION_REDEMPTION_RECORDED` or `PROMOTION_REDEMPTION_VOIDED` |
| `entityType` | enum | `PROMOTION_REDEMPTION` — what `entityId` refers to |
| `entityId` | uuid | The thing that happened. **The correlation key**: a recorded event and its later void share it |
| `occurredAt` | ISO-8601 UTC | Assigned by our database at the moment of the action. The sort key |
| `envelopeVersion` | integer | Currently `1`. **If you meet a version you do not know, stop rather than guess** |

**There is no other field, and there is no payload.** The event says *a promotion redemption was
recorded (or voided) at this moment, and here is its internal id*. It does not carry the customer,
the card, the promotion, the coupon code, the benefit or any amount, and no future v1 field will.

`businessId` is not returned: your key already determines the business.

### Pagination

Keyset, ordered by `(occurredAt, id)` descending. The `id` is a genuine tie-break — `occurredAt` has
millisecond precision, and two actions in the same millisecond produce two events with the same
value.

Paging deep into a long feed costs the same as paging at the top: the cursor is an indexed seek, not
a scan with an offset. That is now measured rather than asserted — see
`docs/PHASE-3B1-RELEASE-GATE.md` §3, which also records that it was **not** true before the release
gate found it.

```
GET /api/v1/events?limit=50
→ page.nextCursor = "v1.eyJhdCI6….kJ8f…"

GET /api/v1/events?limit=50&cursor=v1.eyJhdCI6….kJ8f…
→ page.nextCursor = null      ← you have reached the end
```

Stop when `nextCursor` is `null`. **`page` never carries a total**: a total over a growing table is a
second scan and is wrong by the time you read it.

**The cursor is opaque and signed.** It carries a message authentication code, so the server can
tell a cursor it issued from one it did not. Do not construct, parse, edit or store assumptions
about one — its encoding may change without a version bump, and an altered one is a `400`.

A cursor is valid **for the business it was issued to**, not for the individual key. So:

- a cursor from one of your keys works with another of your keys, and **replacing a key does not
  invalidate a traversal in progress** — including a replacement that keeps the same name;
- a cursor issued to a different business is a `400`, not a silently reinterpreted position.

New events arriving while you page are **not** inserted into your traversal — a keyset walk moves
strictly backwards from where you started. Poll from the top again for anything newer.

---

## 6. `GET /api/v1/events/{eventId}`

One event, in the same shape, with no `page` block.

```json
{ "apiVersion": "v1", "data": { "id": "…", "type": "…", "…": "…" } }
```

`404` if there is no such event **for this key's business**. An id belonging to another business and
an id that never existed produce the identical `404`.

---

## 7. Rate limits

| | |
|---|---|
| Limit | **600 requests per key per minute** (ten a second, averaged) |
| Keyed on | the key, not your IP address |
| Over the limit | `429` with `Retry-After` in seconds |

Each key has its own window, so a second key does not share the first one's budget — but creating
keys to raise your limit is not the intended use, and the ceiling of five active keys is not a rate
limit control.

An **unauthenticated** request costs nothing and counts against nothing: the window is consumed only
after a key is found.

---

## 8. Writing a consumer

- **Poll the top.** Fetch page one every minute or so; walk `nextCursor` only to catch up after an
  outage.
- **Deduplicate on `id`.** It is stable and unique.
- **Correlate on `entityId`.** A `..._VOIDED` event names the same entity as the `..._RECORDED` one
  it withdraws.
- **Order on `occurredAt`, break ties on `id`** — the same rule we sort by.
- **Check `envelopeVersion`.** Stop on a version you do not know.
- **Treat `429` as normal** and honour `Retry-After`.
- **Pass `nextCursor` back byte for byte.** It is signed; trimming, re-encoding or "tidying" it
  will fail verification. If you persist it between runs, persist the exact string.
- **Store the key like a password.** Not in source control, not in a URL, not in a browser.
- **Replace a key you suspect** — it takes effect immediately and the old value stops working in the
  same transaction the new one is created in.

### Webhooks are the other half

If you want events pushed rather than polled, the owner can add a webhook destination on the same
Integrations screen. Deliveries are **at-least-once** — deduplicate on the event id there too.

---

## 9. What this API will never expose

Stated so that nobody has to ask: customer names, phone numbers, email addresses, card ids, wallet
passes, share links, coupon codes, balances, amounts, webhook URLs, webhook signing secrets, API-key
digests, audit records, internal errors, another business's anything.

Several of these are not filtered out — **they are not reachable.** The table these events come from
has typed columns and no JSON payload, and no relation from it leads to a person.

---

## 10. Versioning

`v1` is in the path and in every response body. A breaking change means `v2` and a period where both
run. The following are **not** breaking and may happen without notice:

- a new value of `type` or `entityType` (**handle unknown values by ignoring the event**);
- a new **optional** field on the event object;
- a change to the cursor's encoding or signing — outstanding cursors may stop verifying, so treat a
  `400` on a stored cursor as "start from the top", not as an outage;
- a change to an error `message` — never to a `code`.

---

## 11. What has and has not been verified

**Verified** by tests running against a real PostgreSQL database and the real route handlers:
authentication and every refusal, tenancy isolation, cursor traversal under ties and under
concurrent insertion, cursor tampering, limit clamping, response shape and absence of customer data,
headers, the rate-limit boundary, `lastUsedAt`, and the owner screen in both languages.

**Not verified, and not claimed:** behaviour against staging, against a real merchant system, across
a real network, through a CDN or reverse proxy, or at production load. No external system has ever
called this API.
