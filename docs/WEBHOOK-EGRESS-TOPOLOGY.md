# Webhook egress — capability and topology matrix

**Phase 3B Prompt 3.** Written before the implementation, and used to constrain it. Companion to
`docs/INTEGRATIONS-CAPABILITY-MATRIX.md` §7/§7a, which decided *what a webhook is*; this decides
*how a packet is allowed to leave*.

---

## 0. The problem this exists to solve

Prompt 2 built webhook delivery and the worker was the thing that would have made the request. Two
facts about that, both true at once:

1. In both staging compose files the `worker` is attached to `backend` alone, and `backend` is
   `internal: true` — no gateway, no route out. **Outbound delivery from that worker cannot work.**
2. The obvious repair — attach the worker to a routed network — is the one repair that must not
   happen. The worker holds `DATABASE_URL` for the runtime role, the webhook encryption key, every
   decrypted destination URL and every decrypted signing secret. Giving *that* process general
   Internet reach widens the blast radius of any worker-side flaw from "reads and writes rows" to
   "reads rows and can post them anywhere".

So the capability is granted to a **different process**, one that holds none of those things.

**What is approved:** outbound HTTPS to merchant-controlled public endpoints, for webhook delivery,
and nothing else. No inbound exposure. No new Internet reach for any service that already exists.

---

## 1. Topology

### 1.1 Networks

| Network | Routable? | Who is on it | Why |
|---|---|---|---|
| `backend` | **No** (`internal: true`) | db, migrate, web, worker | Unchanged. No gateway, no route in or out |
| `edge` | Yes | proxy (dedicated) / web (co-hosted) | Unchanged. The existing public path |
| `webhook-control` | **No** (`internal: true`) | **worker, webhook-egress** | The only path from the worker to the gateway. No route out; the worker gains no Internet reach by being on it |
| `webhook-egress-out` | Yes | **webhook-egress, and nothing else** | The one new routable attachment in the product |

`webhook-control` being internal is the load-bearing part. The worker gains a *neighbour*, not a
*route*: a container attached only to internal networks has no default gateway, so there is no path
to any external address from it regardless of what it tries to open.

### 1.2 Service × network

Same in every compose variant. `default` appears only in the local development file, which has no
`edge`/proxy split.

| Service | backend / default | edge | webhook-control | webhook-egress-out | Host ports |
|---|:---:|:---:|:---:|:---:|---|
| `db` | ✅ | — | — | — | loopback only (local); none (staging) |
| `test-db` | ✅ (local only) | — | — | — | loopback only |
| `migrate` | ✅ | — | — | — | none |
| `web` | ✅ | ✅ | — | — | none (dedicated); `127.0.0.1:3100` (co-hosted) |
| `worker` | ✅ | — | ✅ | **—** | none |
| **`webhook-egress`** | **—** | **—** | ✅ | ✅ | **none** |
| `proxy` | — | ✅ | — | — | 80/443 (dedicated); 8080 (local) |

Read the gateway's row twice. It is on **exactly two** networks: the internal one the worker reaches
it over, and the routable one it uses to leave. It is **not** on `backend`, so it cannot reach the
database, the migrator or the web container even if it wanted to — and it has no database credential
to use if it could. It publishes **no host port**, so nothing outside the Compose project can call
it: not the host, not OpenClaw/OpenBot, not ROAD8, not a neighbour container in another project.

### 1.3 What did not change

No existing published port. No existing network attachment. No Caddy, DNS, TLS or firewall change.
B7 is untouched — `/api/enroll` still answers a constant 410 and `/join/<anything>` is still the
static notice. Tenant isolation, the two-role database model and the `MIGRATOR_ONLY_TABLES` grants
are untouched. `web` still holds no HTTP client of any kind and still cannot make a webhook call:
that is a structural property asserted by `tests/unit/webhook-boundary.test.ts`, and it survives
this change because the gateway client is reachable only from the delivery runner, which no route
handler imports.

---

## 2. What moved, and what deliberately did not

| Responsibility | Before | After |
|---|---|---|
| Decrypt destination URL and signing secret | worker | **worker** (unchanged) |
| Build the canonical event envelope | worker | **worker** (unchanged) |
| HMAC-sign the body with the destination's secret | transport, in-process | **worker** — the signing secret never leaves it |
| Delivery lease, claim token, per-delivery re-read | worker | **worker** (unchanged) |
| Attempt rows, retry schedule, append-only history | worker | **worker** (unchanged) |
| URL shape validation | transport | **worker, and again in the gateway** |
| DNS resolution, address policy, connect-time guard | transport | **gateway** |
| The outbound TLS socket | transport, in the worker process | **gateway** |
| Response body | discarded | **discarded, in a process that has no database** |

The division is deliberate: **the worker knows the secrets and cannot reach the Internet; the
gateway can reach the Internet and knows no secrets.** The gateway never receives a signing secret,
never receives the encryption key, never receives a database URL, and cannot decrypt anything.

What it does receive is one destination URL per dispatch, in the clear, over an internal network —
see §6.2, which states that as a residual risk rather than hiding it.

---

## 3. The dispatch contract

The gateway is **not a proxy.** It accepts one request shape and refuses everything else.

### 3.1 Request

```
POST /dispatch HTTP/1.1
host: webhook-egress:8082
content-type: application/json
x-walaaplus-gw-timestamp: <unix seconds>
x-walaaplus-gw-signature: v1=<hex HMAC-SHA-256 of "<timestamp>.<body>" under WEBHOOK_GATEWAY_SECRET>

{"url":"https://…","body":"<the signed canonical envelope, verbatim>","headers":{…}}
```

| Rule | Value |
|---|---|
| Method | `POST` only. Anything else → 405, including `CONNECT`, `GET`, `PUT`, `OPTIONS` |
| Path | `/dispatch` only. Anything else → 404. An absolute-form request-target (`http://host/…`, the proxy spelling) → 400 |
| Request body | JSON, **hard cap 8 KiB**, read with a running byte count and the socket destroyed on overflow |
| `url` | `https://`, port **443 only**, public DNS name only — §4 |
| `body` | a string, at most `MAX_BODY_BYTES` (4096) as UTF-8. Sent verbatim: the gateway does not reformat, re-serialise or re-sign it, because those bytes are what the destination's HMAC covers |
| `headers` | an object whose keys are **exactly** the five allow-listed names below, each a string ≤ 256 bytes. Any other key → 400. The gateway sets `content-type`, `content-length` and `user-agent` itself and refuses to let the caller set them |
| Authentication | HMAC-SHA-256 over `"<timestamp>.<raw body>"`, constant-time compared, timestamp within ±300 s |

Allow-listed headers: `x-walaaplus-event-id`, `x-walaaplus-delivery-id`, `x-walaaplus-attempt`,
`x-walaaplus-timestamp`, `x-walaaplus-signature`. That list is the entire vocabulary; there is no
pass-through, so a caller cannot add a `cookie`, an `authorization`, a `host` or an `x-forwarded-*`.

### 3.2 Response

```
200 {"outcome":"DELIVERED"|"RETRYABLE"|"PERMANENT","errorClass":"…","httpStatus":200|null}
```

**Never the receiver's response body, never a response header, never a resolved IP address, never an
error string.** A status code and a bounded classification, which is exactly what the database has
columns for.

A refusal by the gateway itself is an HTTP 4xx/5xx with `{"error":"<code>"}` from a fixed list
(`BAD_METHOD`, `BAD_PATH`, `BAD_CONTRACT`, `BAD_AUTH`, `SECRET_UNAVAILABLE`, `TOO_LARGE`, `BUSY`).
Those codes describe *the caller's request to the gateway*; none of them describes the destination.

### 3.3 Bounds

| Bound | Value | Why |
|---|---|---|
| Request body from the worker | 8 KiB | Envelope 4 KiB + URL + headers, with room and nothing more |
| Outbound request timeout | 5 s, connect + response | Unchanged from Prompt 2. A slower receiver is a retry |
| Response bytes read | 2048, then the socket is destroyed | Nothing is kept anyway |
| Concurrent dispatches in flight | 4 | A one-vCPU host is shared. Over the limit → `BUSY`, retryable, nothing sent |
| Requests the worker sends per run | ≤ `BATCH_SIZE` (10), sequentially | Unchanged: the runner was already sequential. **Global**, not per tenant — see R8 |
| Test deliveries waiting per destination | **1** | Migration 17. An unbounded test queue was one tenant's lever on every other tenant's latency |

---

## 4. SSRF, enforced a second time at the boundary

Every rule Prompt 2 applied in the worker is applied again in the gateway, on the gateway's own copy
of the URL, at the moment it is about to connect. Not because the worker's check is doubted, but
because the gateway is the process with the route: it must be safe against a caller that is wrong,
including a future caller nobody has written yet.

**And refused twice.** Since the save-time port rule, a destination whose effective port is not 443
never reaches the database at all — `createDestination` refuses it before encryption, persistence,
the audit entry, any queueing or any secret disclosure, with a message the owner reads in their own
language. What the gateway's copy still covers is everything the save path cannot see: a row written
before that rule existed, one restored from a backup, or one inserted by something that is not the
create path. The two share one constant, `WEBHOOK_PORT` in `address.ts`, so they cannot drift.

| Refused | Examples |
|---|---|
| Any scheme but `https:` | `http:`, `file:`, `gopher:`, `ftp:` |
| Any port but 443 | `:8443`, `:80`, `:22`, `:0` — **and at save time as well as at dispatch** |
| IP literals | `https://93.184.216.34/…`, `https://[2606:2800::1]/…` |
| Loopback, private, link-local, CGNAT, multicast, reserved, documentation | `127.0.0.0/8`, `10/8`, `172.16/12`, `192.168/16`, `100.64/10`, `169.254/16`, `224/4`, `240/4`, `::1`, `fc00::/7`, `fe80::/10`, `ff00::/8`, `2001:db8::/32`, `64:ff9b::/96` |
| Cloud metadata | `169.254.169.254`, `fd00:ec2::254` — covered by link-local and unique-local above, and named here because it is the target that matters |
| Internal-looking names | `localhost`, `*.local`, `*.internal`, `*.intranet`, `*.localhost`, `*.home.arpa` |
| Userinfo in the URL | `https://user:pass@host/…` |
| Whitespace or control characters | request-splitting attempts |
| Redirects | a 3xx is an outcome (`HTTP_REDIRECT`, permanent), never a hop |
| Tunnelling | `CONNECT` is not a method this server implements |

**Resolution happens immediately before the connection, and the address checked is the address
connected to.** The agent's `lookup` hook returns only an address that has just passed the policy —
every answer is checked, not just the first, so a name answering with one public address and one
`10.0.0.1` is refused outright rather than being connected to on its "good" answer. SNI and the
`Host` header stay the hostname, so a receiver on shared hosting still gets the right certificate
and the right virtual host.

None of this is new logic. It is `src/server/integrations/webhooks/address.ts`, unchanged, imported
by the gateway — one implementation, two enforcement points.

---

## 5. Failure classification

Two new bounded classes are needed, and they need a migration. Stated plainly because Prompt 3 asks
for a migration only if unavoidable:

| Class | Outcome | When |
|---|---|---|
| `GATEWAY_UNAVAILABLE` | **Retryable** | The gateway could not be reached, answered 5xx, timed out, refused our authentication, reported its own secret missing, or was at its concurrency limit. **Nothing was sent.** |
| `GATEWAY_REJECTED` | **Permanent** | The gateway refused the dispatch *contract* — a malformed URL, an oversized body, a header outside the allow-list. That is a defect on our side, not a transient. |

**Why not reuse `NETWORK`.** Recording our own infrastructure failure as though it were the
merchant's network writes a false statement into an append-only history that the owner reads on
screen. An owner seeing `NETWORK` would go and debug their own endpoint; the fault would be ours,
in a container they cannot see. This codebase has already been corrected three times for writing
down a guarantee that was not quite true — the same standard applies to writing down a *diagnosis*
that is not true. Two enum values are the honest encoding, and `ALTER TYPE … ADD VALUE` neither
rewrites a row nor takes a table lock.

**And the database is what enforces both meanings, not the code that writes them.** Migration 16
redefines the two trigger functions migration 15 created, because those functions enumerate the
permanent and retryable classes *by name*: a value the enum knows and the triggers do not is a
value the database has no opinion about. Concretely, `walaaplus_validate_webhook_attempt` now
refuses an attempt that records `GATEWAY_REJECTED` as anything but permanent or
`GATEWAY_UNAVAILABLE` as anything but retryable, and `walaaplus_webhook_delivery_guard` refuses a
delivery that exhausts `GATEWAY_REJECTED` to `FAILED`, settles a retryable class as a permanent
`REFUSED`, or reaches `FAILED` with one before the five-attempt cap. Every class comparison in
both functions is made against `::text`, because PostgreSQL will not let a value added by
`ALTER TYPE … ADD VALUE` be used as an enum literal in the same transaction and Prisma runs each
migration in one.

Migration **16**, additive only — two enum values and two `CREATE OR REPLACE FUNCTION` statements.
No table is created, altered, rewritten or locked, and replacing a function body leaves the
triggers that reference it pointing at the same function. Migration 15 is untouched; it is already
applied on staging.

Everything else is unchanged: `DELIVERED` only for 2xx, 3xx permanent, 429 retryable, 4xx permanent,
5xx retryable, `UNSAFE_ADDRESS` permanent, `TIMEOUT`/`NETWORK`/`TLS` as before, and the retry
schedule, the five-attempt cap, the lease and the append-only attempt history all exactly as
Prompt 2 left them.

The classes the database constrains are the ones that encode a **decision** — ours or the owner's —
where recording the opposite would make the history say something false about what was *done*. The
HTTP and network classes are deliberately left unconstrained: each follows from a status code or an
error code rather than from a policy a trigger could restate, and a rule asserting
"`HTTP_SERVER_ERROR` must be retryable" would be re-deriving the same fact from less information.
`tests/integration/webhook-error-class-integrity.test.ts` holds a declared classification for
**every** value of the enum, including the reason each unconstrained one is unconstrained, and
fails if a value is ever added without one.

---

## 6. Secrets

### 6.1 Which service receives what

Named variables only. No `env_file`, in any file, for any service.

| Variable | web | worker | **webhook-egress** | db | migrate | proxy |
|---|:---:|:---:|:---:|:---:|:---:|:---:|
| `DATABASE_URL` (runtime role) | ✅ | ✅ | **—** | — | ✅ | — |
| `MIGRATE_DATABASE_URL` (owner role) | — | — | **—** | — | ✅ | — |
| `POSTGRES_PASSWORD` | — | — | **—** | ✅ | ✅ | — |
| `NEXTAUTH_SECRET` | ✅ | ✅ | **—** | — | — | — |
| `INTEGRATION_ENCRYPTION_KEY` | ✅ | ✅ | **—** | — | — | — |
| **`WEBHOOK_GATEWAY_SECRET`** | **—** | ✅ | ✅ | — | — | — |
| `WEBHOOK_GATEWAY_URL` (not a secret) | — | ✅ | — | — | — | — |

`WEBHOOK_GATEWAY_SECRET` is **new, distinct, and per-environment**. It is never the encryption key
and never derived from it: one authenticates a caller on an internal hop, the other protects data at
rest, and a single value doing both means a compromise of either is a compromise of both.

`web` receives the gateway secret **not at all**. It could not usefully call the gateway — it is not
on `webhook-control` — and giving it the secret would turn a web-side flaw into a dispatch
capability. The gateway receives `INTEGRATION_ENCRYPTION_KEY` **not at all**: it decrypts nothing.

**Absent or malformed, on either side:** webhook delivery fails closed and bounded —
`GATEWAY_UNAVAILABLE`, retryable, nothing sent — and **nothing else is affected**. Enrolment,
stamps, points, redemptions, referrals, consent, campaigns, the scanner, the till and B7 do not
touch this path. Both compose interpolations are `${VAR:-}`, never `${VAR:?}`, for the same reason
`INTEGRATION_ENCRYPTION_KEY` is: an absent optional secret must not stop an application that does
not need it.

### 6.2 Residual risks, stated rather than hidden

- **R1 — the worker→gateway hop is plaintext HTTP on an internal Docker network.** The dispatch body
  carries the destination URL, which may contain a path or query token the receiver treats as
  authentication. It is authenticated (HMAC) and integrity-protected, so it cannot be forged or
  altered, but it is not confidential against something that can already read that network's
  traffic — which means root on the Docker host. Mutual TLS between two containers was rejected for
  now: it needs a certificate to issue, distribute, rotate and expire, on a host where the existing
  TLS story belongs to someone else's Caddy. **Anyone with root on the host can already read the
  worker's memory, where the same URL is decrypted.** The hop adds no exposure that position did not
  already have.
- **R2 — the gateway can reach the whole public Internet at the IP layer.** The allow-list is the
  *contract*, not the route: nothing stops the container from opening a socket if its code were
  replaced. What bounds it is that the image runs one bundled entry point with no shell tooling, the
  container publishes no port, and the only thing that can ask it to connect is a caller holding the
  gateway secret on an internal network.
- **R3 — a merchant endpoint on shared hosting resolves to an address we cannot distinguish from any
  other customer's.** DNS-based egress control cannot fix that; it is the nature of the capability
  the owner approved.
- **R4 — a destination whose DNS changes between the worker's shape check and the gateway's
  resolution** is caught by the gateway's connect-time guard, not by the worker's. That is the
  design, and it means the worker's copy of the check is advisory. It is kept because a URL that
  fails it never reaches the gateway at all.
- **R5 — in both staging files the worker still has no route out, and that is now correct.** It
  reaches the gateway over `webhook-control`. If `webhook-egress` is not running, delivery is
  `GATEWAY_UNAVAILABLE` and retries; it does not fail permanently and does not lose the queue.
- **R8 — delivery throughput is a GLOBAL ceiling, not a per-tenant one.** `claimDue` takes
  `BATCH_SIZE` (10) rows per minute across every business on the deployment — roughly 600 an hour —
  ordered by `nextAttemptAt`, which is first-come rather than fair between tenants. A busy business
  therefore delays a quiet one's webhooks, within the limits of how much business actually happens.
  The release gate closed the one way a tenant could do this *deliberately* (an unbounded test
  queue — see `docs/PHASE-3B-RELEASE-GATE.md` §2, F1); what remains is ordinary contention. If a
  deployment outgrows it, the honest fix is a larger batch or per-tenant fairness in `claimDue`, not
  a longer lease.
- **R9 — nothing prunes deliveries or attempts.** A delivery row lives for every (event ×
  enabled destination) pair and keeps up to five attempt rows. Bounded in practice by business
  activity and by the five-attempt cap; there is no retention job.

---

## 7. What is deliberately still not built

- No inbound webhooks, no callback endpoint, no new public route.
- No general HTTP capability for any other feature. The gateway speaks one contract; it is not a
  place to add "and also fetch this".
- No provider SDK, no queue to an external service, no analytics, no payment path.
- No egress allow-list of *specific* merchant hosts. The owner approved merchant-controlled
  endpoints; a per-host allow-list would be a product feature (and a support burden) nobody asked
  for. The address policy is the control.
- No re-encryption tool for `INTEGRATION_ENCRYPTION_KEY` rotation (still D29).

---

## 8. Deployment requirements, for Freebuff

| | |
|---|---|
| New service | `webhook-egress`, built from the repository, target `egress`. No host port |
| New networks | `webhook-control` (`internal: true`), `webhook-egress-out` (routable, gateway only) |
| New variable | `WEBHOOK_GATEWAY_SECRET` — 32 bytes, 64 hex characters or base64, `openssl rand -hex 32`, **per environment**, different from every other secret including `INTEGRATION_ENCRYPTION_KEY` |
| Receives it | `worker` and `webhook-egress`, both, by name. Nothing else |
| Also on the worker | `WEBHOOK_GATEWAY_URL`, not a secret; defaults to the in-network address |
| Absent or malformed | webhook delivery retries and sends nothing; every other workflow is unaffected |
| Migration | **16**, additive: two enum values. Migration 15 is untouched and stays applied |
| Firewall | the host must permit outbound 443 from the Docker bridge, which it already does for image pulls. No inbound rule, no new port, no DNS record, no certificate |

**No value for the new secret exists in this repository and none was generated for any environment
by this work.** Provisioning it is Freebuff's step, after independent review. No staging deployment,
no real merchant endpoint, no provider account and no external network test was performed.
