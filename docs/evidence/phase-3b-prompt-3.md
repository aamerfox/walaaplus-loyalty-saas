# Phase 3B Prompt 3 — isolated secure webhook egress

| | |
|---|---|
| Branch | `rebuild/phase-0-foundation` |
| Baseline | `79a9f7c` — Prompt 2 plus the compose secret-wiring correction (60499) |
| Capability matrix written first | `docs/WEBHOOK-EGRESS-TOPOLOGY.md` |
| Migration | **16**, `20260922120000_webhook_egress_gateway_classes` — two enum values **and the two trigger functions that decide what they mean**, additive. Amended after review; see §12. Migration 15 untouched and still applied on staging |
| New secret | `WEBHOOK_GATEWAY_SECRET`, per environment, **no value exists in this repository** |
| Staging | **not deployed.** No external network test, no merchant endpoint, no provider account |

---

## 1. What was wrong, and what the fix could not be

Prompt 2 built delivery and the worker would have made the request. Two true things:

1. In both staging files the `worker` was attached to `backend` alone, and `backend` is
   `internal: true`. **Outbound delivery from it could not work at all** — reported at the end of
   60499 rather than quietly fixed.
2. The obvious repair is the one repair that must not happen. The worker holds `DATABASE_URL` for
   the runtime role, `INTEGRATION_ENCRYPTION_KEY`, every decrypted destination URL and every
   decrypted signing secret. Giving *that* process general Internet reach widens the blast radius of
   any worker-side flaw from "reads and writes rows" to "reads rows and can post them anywhere".

So the capability went to a different process. **The process that holds the secrets has no route to
the Internet; the process with the route holds none of the secrets.** Everything below is one half
of that sentence.

## 2. Topology

| Network | Routable? | Members |
|---|---|---|
| `backend` | no (`internal: true`) | db, migrate, web, worker |
| `edge` / `default` | yes | proxy, web — unchanged |
| **`webhook-control`** | **no (`internal: true`)** | **worker, webhook-egress** |
| **`webhook-egress-out`** | **yes** | **webhook-egress, and nothing else** |

The load-bearing part is that `webhook-control` is internal. The worker gains a **neighbour**, not a
**route**: a container attached only to internal networks has no default gateway, so there is no
path to any external address from it whatever its code tries to open.

`webhook-egress` is on exactly two networks and **publishes no host port in any variant**, so
nothing outside the Compose project can address it — not the host, not the system Caddy, not
OpenClaw/OpenBot, not ROAD8, not a container in another project.

The local `docker-compose.yml` needed one structural change to satisfy this: it had no networks at
all, so `worker` was on the routable default bridge. It now has `backend` (internal, shared with
`db`) plus the two new ones, and `db` keeps `default` so its loopback port and `web`'s path to it are
exactly as they were.

**Nothing else moved.** No existing published port, no existing network attachment, no Caddy, DNS,
TLS or firewall change, no B7 change, no tenant-isolation or database-role change.

## 3. What moved into the gateway, and what deliberately did not

| Responsibility | Where it runs now |
|---|---|
| Decrypt URL and signing secret | worker (unchanged) |
| Canonical envelope | worker (unchanged) |
| **HMAC-sign the body with the destination's secret** | **worker** — the secret never crosses the hop |
| Lease, claim token, per-delivery re-read, attempt rows, retry schedule | worker (unchanged) |
| URL shape validation | worker **and again** in the gateway |
| DNS resolution, address policy, connect-time guard | **gateway** |
| The outbound TLS socket | **gateway** |

`src/server/integrations/webhooks/transport.ts` is gone; its client is
`src/egress/dispatch.ts`. The worker's only remaining HTTP client is
`src/server/integrations/webhooks/gateway.ts`, which addresses one origin from configuration at a
compile-time-constant path.

Because the worker signs, **a compromised gateway cannot forge a webhook a receiver would accept**:
it never holds the key that makes one valid.

## 4. The gateway is not a proxy

One route, one verb, one contract, and every proxy-shaped affordance refused explicitly:

| Affordance | Answer |
|---|---|
| any method but `POST` | 405 |
| any path but `/dispatch` | 404 |
| absolute-form target (`POST http://host/x`) | 404 `BAD_PATH`, before anything else is read |
| `CONNECT` | socket destroyed — no tunnel |
| `Upgrade` | socket destroyed — no WebSocket |
| a body not declared `application/json` | 400 |
| a fourth JSON key, a missing key, a non-string body | 400 `BAD_CONTRACT` |
| any header name outside the five | 400 — and `content-type`, `content-length`, `user-agent` are set by the gateway, not the caller |
| a body over 4 KiB, a request over 8 KiB | 400 / 413, refused while streaming, nothing buffered |
| more than 4 dispatches in flight | 503 `BUSY` |

It **builds its own outbound request** from the parts it accepted. The only thing copied verbatim is
the body, because the destination's HMAC covers those exact bytes — and it is capped and never
inspected.

What it says back is `{outcome, errorClass, httpStatus}` and nothing else: **never the receiver's
body, never its headers, never a resolved address, never an error string.**

## 5. SSRF, enforced a second time at the boundary

Every rule is applied again in the gateway, on its own copy of the URL, immediately before it
connects: `https:` only, **port 443 only**, public DNS name only, no IP literals, no loopback,
private, CGNAT, link-local, multicast, reserved or documentation ranges, no metadata addresses, no
`localhost`/`.local`/`.internal`/`.intranet`/`.home.arpa`, no userinfo, no whitespace or control
characters, no redirects followed.

Resolution happens immediately before the connection and **the address checked is the address
connected to** — every answer is checked, not just the first, so a name answering with one public
address and one `10.0.0.1` is refused outright. SNI and `Host` stay the hostname.

One implementation, two enforcement points: the gateway imports `address.ts` and nothing else from
the application.

## 6. Failure classification, and the one migration

Two new bounded classes, additive — **and, after the review correction in §12, two redefined
trigger functions so the database enforces what they mean**:

| Class | Outcome | When |
|---|---|---|
| `GATEWAY_UNAVAILABLE` | **retryable** | gateway unreachable, 5xx, timed out, refused our authentication, its own secret unset, at its concurrency limit, or the worker's secret is absent. **Nothing was sent.** |
| `GATEWAY_REJECTED` | **permanent** | the gateway refused the *contract* — malformed URL, oversized body, header outside the allow-list. Our defect; waiting does not fix it. |

**Why this was not avoidable.** Both could have been recorded as `NETWORK` and the system would
still *behave* correctly — retryable, bounded by the five-attempt cap, nothing sent. What would be
wrong is the record. The attempt history is append-only and is shown to the business owner, and
`NETWORK` means "we tried to reach your endpoint and the network failed". An owner reading that
would go and debug an endpoint that was never contacted while the fault sat in a container they
cannot see. This codebase has already been corrected three times for writing down a *guarantee* that
was not quite true; the same standard applies to writing down a *diagnosis* that is not true.

`ALTER TYPE … ADD VALUE` twice. No table created, altered, rewritten or locked; no row changed; no
existing value renamed or removed, so every row already written keeps its meaning. **Migration 15 is
not amended.**

## 7. Secrets

`WEBHOOK_GATEWAY_SECRET` — new, distinct, per environment, 32 bytes, never derived from
`INTEGRATION_ENCRYPTION_KEY`. One authenticates a caller on an internal hop; the other protects data
at rest. A single value doing both means a compromise of either is a compromise of both.

| Variable | web | worker | webhook-egress | db | migrate | proxy |
|---|:---:|:---:|:---:|:---:|:---:|:---:|
| `DATABASE_URL` | ✅ | ✅ | **—** | — | ✅ | — |
| `INTEGRATION_ENCRYPTION_KEY` | ✅ | ✅ | **—** | — | — | — |
| `NEXTAUTH_SECRET` | ✅ | ✅ | **—** | — | — | — |
| **`WEBHOOK_GATEWAY_SECRET`** | **—** | ✅ | ✅ | — | — | — |

The gateway's complete environment is `NODE_ENV`, `WEBHOOK_EGRESS_PORT` and
`WEBHOOK_GATEWAY_SECRET`. It decrypts nothing, so it is given no key; it queries nothing, so it is
given no database URL.

`web` receives the gateway secret **not at all** — it is not on `webhook-control` and holds no HTTP
client, so a credential there would be pure downside. `scripts/e2e-server.mjs` deliberately does not
set it either, so the one place a reader might copy from agrees with the topology.

Both interpolations are `${VAR:-}`, never `${VAR:?}`: an unset optional secret must not stop the
till. Absent or malformed, on either side, webhook delivery is `GATEWAY_UNAVAILABLE`, retryable,
nothing sent, and **nothing else is affected**. The gateway starts, says so once by variable name,
and refuses every dispatch rather than crash-looping a container on a shared box.

## 8. The image

A separate Dockerfile target, `egress`, built from `scripts/build-egress.mjs` — a self-contained
esbuild bundle with **nothing marked external**. The image has no `node_modules`, no Prisma client,
no PostgreSQL driver, no source tree and no scripts. It could not open a database connection if it
were asked to. 21 KB of JavaScript and a `node:24-alpine` base, running as a non-root user.

## 9. Verification

Everything ran on this machine, against a local HTTPS receiver started and stopped by the tests.
**No merchant endpoint, provider account, external service, customer record, card, coupon or share
token was involved, and nothing was deployed.**

### 9.1 Suites

| Suite | Result |
|---|---|
| `tests/unit/webhook-gateway-contract.test.ts` (new) | 33 passed |
| `tests/unit/webhook-egress-boundary.test.ts` (new) | 19 passed |
| `tests/unit/compose-exposure.test.ts` (extended) | 113 passed |
| `tests/unit/webhook-boundary.test.ts` (updated) | 16 passed |
| `tests/unit/deploy-config.test.ts` (extended) | 42 passed |
| `tests/integration/webhook-egress.test.ts` (new) | 29 passed |
| `tests/integration/webhook-delivery.test.ts` (rewired through a real in-process gateway) | 34 passed |

The delivery suite is the significant one: it was not stubbed out. Every existing assertion —
signing, retries, backoff, leases, the claim token, disable/revoke/rotation cutover, append-only
attempt history, SSRF refusal — now runs with a **real egress gateway in the loop**, and passes
unchanged.

### 9.2 What the tests prove that a runtime check cannot

`webhook-egress-boundary.test.ts` is a dependency-graph scan, because the division this design rests
on is a property of the graph and not of any observable behaviour:

- no `@prisma/client`, `.prisma/client`, `pg`, `pg-boss` or `server/db` anywhere under `src/egress`;
- no reference to `INTEGRATION_ENCRYPTION_KEY`, `NEXTAUTH_SECRET` or `DATABASE_URL` there either;
- the only application module the gateway reaches into is `address.ts`, whose own imports are
  `node:dns` and `node:net`;
- `transport.ts` no longer exists, and exactly one module under `src/server` holds an HTTP client;
- that module's path is the imported constant and its origin comes from `WEBHOOK_GATEWAY_URL`;
- the signing secret is not among the fields put into the dispatch object;
- nothing under `src/app/` imports any egress module, the gateway client, or names the gateway
  secret;
- and the production entry point passes none of the three test seams (`lookup`, `addressPolicy`,
  `allowedPorts`).

### 9.3 Red proofs — every critical guard watched fail

| Regression introduced | What failed |
|---|---|
| `worker` joined `webhook-egress-out` | 9 assertions across all three variants, including "leaves the worker on internal networks only" |
| `webhook-control` stopped being `internal: true` | 8, including "makes the control network internal, so reaching the gateway is not a route out" |
| gateway given `INTEGRATION_ENCRYPTION_KEY` | 8, including "the gateway gets neither key nor database" |
| gateway published `127.0.0.1:8082:8082` | 8, including "publishes no host port from the gateway, in any variant" |
| `web` given `WEBHOOK_GATEWAY_SECRET` | "passes it to no other service, above all not to web", naming `web` |
| gateway's authentication check disabled | **7** integration tests, including every unsigned/forged/replayed case and "sends nothing to the receiver for any of those" |
| gateway's own SSRF re-check replaced with a bare `new URL()` | **7** unit and **1** integration |

Each was reverted and the suites returned to green.

**One red proof found a real weakness in a test rather than in the code.** The first attempt at the
SSRF proof passed: the unsafe URLs in the integration test carried a port the gateway was not
configured for, so the *port* rule refused them and the address rule was never reached. The test was
rewritten to put the allowed port on every unsafe URL — `https://127.0.0.1:<port>/x`,
`https://169.254.169.254:<port>/…`, `https://[::1]:<port>/x`, `https://db.internal:<port>/x` — so
only the address rule can be what refuses them. It then failed as it should. A guard that is never
the reason a test fails is not a guard that has been tested.

### 9.4 Compose configuration, resolved, without printing values

`docker compose config --format json` for all three files, with placeholder secrets and again with
them absent, piped through a script that prints service names, network names and a
present/absent verdict only.

| | `worker` | `webhook-egress` | `web` | `db` / `migrate` / `proxy` |
|---|---|---|---|---|
| networks | `backend`, `webhook-control` — **both internal** | `webhook-control`, `webhook-egress-out` | unchanged | unchanged |
| published ports | none | **none** | unchanged | unchanged |
| gateway secret | present | present | **absent** | **absent** |
| encryption key | present | **absent** | present | **absent** |
| database URL | present | **absent** | present | migrate only |

With **both** secrets removed from the env file, every file still resolves with **exit 0** and the
services receive an empty variable rather than the deployment failing — the "must not stop the
till/core application" requirement. Nothing printed a value in either direction, including the
placeholder.

### 9.5 Gate and browser suite

`npm run gate` — **PASSED, 16/16 steps in 667.5 s**, including the new `egress build` step that
compiles the gateway bundle so a broken import is a gate failure rather than a container that will
not start. Dependency audit, lint, typecheck, `prisma validate`, unit, migrate deploy/status,
runtime role grants, integration, worker build, egress build, production build, migrate image
dependencies and web image container health all pass.

Browser suite (`npx playwright test`, `mobile-chromium`) run **twice**: **120 passed** in 3.5 min,
then **120 passed** in 3.3 min. No flake, no retry, no skipped test. B7 is covered there and is
unchanged.

`git diff --check` clean. A control-byte scan over **every** changed and new file finds none, and a
secret-shaped-literal scan restricted to **added lines** finds none — the two long hex strings the
whole-file scan flags in `src/server/env.ts` and `docs/STAGING-RUNBOOK.md` are pre-existing
git-history secret hashes, untouched by this work.

Two control-byte incidents **were** found and fixed during the work, both the same mistake in
different files: a backslash-`u` escape written into source text arrived as the literal byte it
names. In `src/egress/contract.ts` a header-validation regular expression became literal NUL and
`0x1f`; in `tests/unit/webhook-gateway-contract.test.ts` a test string became a literal NUL. Both are
now built from `charCodeAt` / `String.fromCharCode`, with no escape in the source to mangle.
`tests/unit/source-text-encoding.test.ts` is what would have failed the gate on either regardless —
it is the guard added after the same thing happened in Phase 3A.

## 10. Residual risks, stated rather than hidden

- **R1 — the worker→gateway hop is plaintext HTTP on an internal Docker network.** The dispatch body
  carries the destination URL, which may contain a path or query token the receiver treats as
  authentication. It is HMAC-authenticated and integrity-protected, so it cannot be forged or
  altered, but it is **not confidential** against something that can already read that network's
  traffic — which means root on the Docker host. Mutual TLS between two containers was rejected for
  now: it needs a certificate to issue, distribute, rotate and expire, on a host whose existing TLS
  story belongs to someone else's Caddy. Anyone with root on that host can already read the worker's
  memory, where the same URL is decrypted; the hop adds no exposure that position did not have.
- **R2 — replay inside the timestamp window.** A party who can read the internal network can re-send
  a captured dispatch within ±300 s and cause **one duplicate delivery**. Delivery is already
  at-least-once and every envelope carries a stable `x-walaaplus-event-id` for the receiver to
  de-duplicate on, so the consequence is a duplicate the protocol already permits — not a forged
  one. A nonce store was rejected: the gateway has nowhere to keep one, and giving it one would mean
  giving it state.
- **R3 — the gateway can reach the public Internet at the IP layer.** The allow-list is the
  *contract*, not the route. What bounds it is that the image runs one bundled entry point with no
  shell tooling or package manager, publishes no port, and can only be asked to connect by a caller
  holding the gateway secret on an internal network.
- **R4 — a merchant endpoint on shared hosting** resolves to an address indistinguishable from any
  other customer's. DNS-based egress control cannot fix that; it is the nature of the approved
  capability.
- **R5 — the worker's copy of the URL check is advisory.** A destination whose DNS changes between
  it and the gateway's resolution is caught by the gateway's connect-time guard, not by the worker's.
  That is the design; the worker's copy is kept because a URL that fails it never crosses the hop.
- **R6 — CLOSED, not accepted.** A destination on a port other than 443 used to save, sit in the
  list looking configured, and fail every attempt as `GATEWAY_REJECTED`. It is now refused at the
  moment the owner presses Save, in both languages, before anything is encrypted, written, audited,
  queued or disclosed. See §13. The gateway's own check is unchanged and still covers a row this
  path never saw.
- **R7 — no healthcheck on the gateway**, deliberately: a health route would be a second contract.
  `docker compose ps` and its one `listening` log line are how you tell. If it is down, delivery
  retries and loses nothing.

## 11. What was deliberately not done

No inbound webhooks, no callback endpoint, no new public route. No general HTTP capability for any
other feature. No provider SDK, queue to an external service, analytics or payment path. No per-host
merchant allow-list — the owner approved merchant-controlled endpoints, and the address policy is
the control. No re-encryption tool for key rotation (still D29). No `env_file` anywhere. No change
to B7, tenant isolation, Caddy, database isolation, published ports, or any neighbouring service.

No staging deployment, no real merchant endpoint, no provider account, no customer data, no card,
coupon or share token, no external production service, and no Caddy, DNS or firewall change was
made or tested by this work. Freebuff performs deployment only after independent review.

---

## 12. Review correction — the database did not know what the new classes meant

Found in `3ffa089`, before deployment. The finding was correct and the gap was real.

### 12.1 What was wrong

Migration 16, as first written, added `GATEWAY_UNAVAILABLE` and `GATEWAY_REJECTED` to the enum and
stopped. But the two trigger functions migration 15 created enumerate the permanent and retryable
classes **by name**:

- `walaaplus_validate_webhook_attempt` required `PERMANENT` for `UNSAFE_ADDRESS`,
  `CIPHERTEXT_INVALID` and `DESTINATION_NOT_ELIGIBLE`, and `RETRYABLE` for
  `ENCRYPTION_UNAVAILABLE`;
- `walaaplus_webhook_delivery_guard` forbade `FAILED` for those same three permanent classes.

A value the enum knows and the triggers do not is a value the database has **no opinion about**. So
the restricted runtime role — the role `web` and `worker` actually use — could have written
`GATEWAY_REJECTED` as `RETRYABLE`, exhausted it to `FAILED`, or recorded `GATEWAY_UNAVAILABLE` as
`PERMANENT`, and the append-only attempt history would have said something false about work that was
never done.

The application never writes any of those. **That is the point.** Every other rule in those
functions is also one the application never breaks; they exist because "the code is currently
correct" is not a constraint, and an append-only table cannot be corrected afterwards. Shipping two
classes the code understands and the database does not is the exact drift those triggers exist to
prevent.

### 12.2 What migration 16 now does

Migration 16 was **amended** — it had not reached staging — and migration 15 was not touched. Both
functions are reproduced in full and re-created with `CREATE OR REPLACE`. The bodies were **sliced
out of migration 15 by script rather than retyped**, so "preserve every existing rule exactly" is a
property of the process; a line-by-line diff of the two versions shows only the edits listed here.

| Rule | Where |
|---|---|
| `GATEWAY_REJECTED` must be `PERMANENT` | attempt validator, added to the permanent list |
| `GATEWAY_REJECTED` can never settle `FAILED` | delivery guard, added to the never-exhausted list |
| `GATEWAY_UNAVAILABLE` must be `RETRYABLE` | attempt validator, added beside `ENCRYPTION_UNAVAILABLE` |
| a retryable class can never settle `REFUSED` | delivery guard, **new mirror rule** |
| a retryable class reaches `FAILED` only at the attempt cap | delivery guard, **new mirror rule** |

**Every error-class comparison is now made against `::text`.** Not a style preference: PostgreSQL
refuses to let a value added by `ALTER TYPE … ADD VALUE` be used as an enum literal in the same
transaction, and Prisma runs each migration in one — so a redefined function comparing
`NEW."errorClass" = 'GATEWAY_REJECTED'` would have made the migration itself unapplyable. Comparing
the label as text changes no semantics. The `status` and `outcome` enums gain no values here and are
compared as before.

**One deviation from the literal brief, reported rather than buried.** The two new mirror rules are
written for **both** database-declared retryable classes — `GATEWAY_UNAVAILABLE` *and*
`ENCRYPTION_UNAVAILABLE` — not only the new one. Writing a rule for one of two identically
classified values is the same drift this correction exists to close, the function was being
redefined anyway, and production code never produces either forbidden combination (`recordAttempt`
settles `REFUSED` only for a `PERMANENT` outcome and `FAILED` only at `MAX_ATTEMPTS`). No existing
rule was weakened or altered.

`ALTER TYPE … ADD VALUE` twice plus two `CREATE OR REPLACE FUNCTION`. No table created, altered,
rewritten or locked; no row changed; replacing a function body leaves the triggers that reference it
pointing at the same function, so no trigger is dropped or recreated.

### 12.3 The tests

`tests/integration/webhook-error-class-integrity.test.ts`, **14 tests**, every write through the
**restricted runtime Prisma client** with no service in the way:

| | |
|---|---|
| reject | `GATEWAY_REJECTED` recorded retryable |
| reject | `GATEWAY_REJECTED` recorded delivered (the pre-existing coherence rule, on the new class) |
| reject | `GATEWAY_REJECTED` exhausted to `FAILED` — below the cap **and** at it |
| reject | `GATEWAY_UNAVAILABLE` recorded permanent |
| reject | `GATEWAY_UNAVAILABLE` settled as a permanent `REFUSED` |
| reject | `GATEWAY_UNAVAILABLE` reaching `FAILED` at 1, 2 and 4 attempts |
| accept | `GATEWAY_UNAVAILABLE` recorded retryable |
| accept | `GATEWAY_UNAVAILABLE` reaching `FAILED` at exactly `MAX_ATTEMPTS` |
| accept | `GATEWAY_REJECTED` as a permanent attempt and a `REFUSED` delivery |

### 12.4 The drift guard

The point of a regression guard here is that **the next enum value must not be able to repeat this**.
The test file carries a `CLASSIFICATION` table declaring, for *every* value of `WebhookErrorClass`,
one of `PERMANENT`, `RETRYABLE` or `UNCONSTRAINED` — the last with the reason it is one. Four
assertions hang off it:

1. the table's keys equal the enum's values **exactly**, so a class added later and not declared
   fails immediately, with no database needed;
2. every `PERMANENT` declaration is proved on a **live insert** through the runtime role;
3. every `RETRYABLE` declaration likewise;
4. every constrained class is shown to appear inside the **live** function definitions, read back
   with `pg_get_functiondef` — not the migration file, which could have been edited without being
   applied, and not the application, which is the thing being checked. *This is the assertion that
   would have failed on the first version of migration 16: both new classes existed in the enum and
   neither appeared in either function.*

The HTTP and network classes are `UNCONSTRAINED` deliberately, and the table says why: each follows
from a status code or an error code rather than from a policy a trigger could restate, and a rule
asserting "`HTTP_SERVER_ERROR` must be retryable" would re-derive the same fact from less
information. The constrained classes are the ones encoding a **decision** — ours or the owner's —
where recording the opposite makes the history false about what was *done*.

### 12.5 Red proofs

Each new classification check was removed **on its own**, the disposable test database was recreated
so the amended migration reapplied, and the suite was run:

| Check removed | Failed | Positive controls |
|---|---|---|
| `GATEWAY_REJECTED` from the attempt permanent list | 2 — "records it as retryable", "enforces every PERMANENT declaration" | green |
| `GATEWAY_REJECTED` from the never-exhausted list | 1 — "exhausted to FAILED with it" | green |
| `GATEWAY_UNAVAILABLE` from the must-be-retryable rule | 2 — "records it as permanent", "enforces every RETRYABLE declaration" | green |
| the whole retryable mirror block | 2 — "settled as a permanent REFUSAL", "FAILED before the attempt cap" | green |
| a class left undeclared in the `CLASSIFICATION` table | 1 — "declares a classification for every value the enum has" | green |

Every edit was reverted, the database recreated once more, and the suite returned to **14/14**.

### 12.6 Checksum and staging

Migration 16 was amended, so its checksum changed. The **disposable test database** was recreated
(`docker compose down test-db && up -d --wait test-db`) and all sixteen migrations reapplied from
scratch, which is the only place the old checksum existed. **Staging is untouched and was never
contacted**: migration 16 has never been applied there, migration 15 remains exactly as deployed,
and nothing in this correction reaches a running environment.

---

## 14. Release gate — the audit of the whole Phase 3B release

Full matrix: **`docs/PHASE-3B-RELEASE-GATE.md`**. Audited `338023e`, against the code, the tests,
the database rules, the Compose topology and the docs rather than against the previous prompts'
claims about them.

**Three findings, all fixed and red-proved.**

### 14.1 HIGH — one tenant could set every other tenant's delivery latency

`queueTestDelivery` had no bound; a probe queued fifty and every one was accepted. On its own a row
count — but `claimDue` takes ten rows a minute **across every business**, ordered by when they
became due, and a test delivery is created due **immediately**. One owner's loop therefore put an
unbounded number of their own rows at the front of a queue every tenant shares.

Stated precisely: nothing was exposed, no other tenant's delivery was marked failed, and a delivery
that is never claimed consumes no attempt. What the caller gained was **control over how long every
other business's webhooks wait** — without limit, and with no access beyond their own owner session.

Closed in three layers, **and only one of them is the guarantee** - see §15, which corrects what
this section originally claimed. The service refuses a second test while one is waiting
(`409 WEBHOOK_TEST_PENDING`, both locales); a **partial unique index** serializes two overlapping
inserts; and the trigger supplies a readable sentence for the sequential case. Outstanding test
deliveries are bounded by the number of destinations, itself bounded at five.

### 14.2 LOW — the batch-size rationale computed from a constant that no longer exists

`BATCH_SIZE`'s comment said "ten requests at the transport's five-second timeout is under a minute".
There is no transport module since Prompt 3, and the worker's per-delivery ceiling is
`GATEWAY_TIMEOUT_MS` = 15 s — so the worst case is about **150 s**, not under a minute. The
conclusion (inside the 300 s lease) still held, so nothing misbehaved; but anyone tuning `BATCH_SIZE`
or `LEASE_SECONDS` would have computed from a wrong number. Corrected, with the consequence stated:
a full slow batch outlasts the one-minute schedule, which is safe by construction — `singletonKey`,
`SKIP LOCKED`, and the claim token on every write.

### 14.3 LOW — the stored job result was under-declared

`WebhookDeliveryResult` omitted `skipped`, which the summary does carry into the result pg-boss keeps
in a table. A count, so nothing leaked; declared, because the type is the description of what is
kept.

### 14.4 Two claims that were already true, and are now asserted

Both were verified by probe during the audit and neither had a permanent test:

- **the runtime role cannot touch `_prisma_migrations`** — SELECT, DELETE and TRUNCATE all refused
  with `permission denied`, DROP with `must be owner`. `db-roles.mjs` prints that claim on every
  deployment and nothing was checking it;
- **a database refusal does not echo the ciphertext or the plaintext URL.** Prisma's message carries
  the call-site source and our own trigger sentence, not the row. That is a property of Prisma's
  error formatting, so an upgrade could change it.

### 14.5 Migration 17, and why it is a function replacement

A partial unique index would have expressed 14.1's rule more tersely and was rejected deliberately:
**an index is validated against rows that already exist.** Migration 16 was being deployed to staging
as this was written, and if anyone had queued two tests for one destination first, the index would
have failed to build and stopped the deployment on data nobody created wrongly. A trigger rule
constrains only what is written from now on — it cannot fail on existing data and rewrites nothing.
(That argument is superseded by §15, which explains why the trigger was never the guarantee. The
index that replaced it **does** take a lock, and §15.4 says so.) Any existing duplicate pending tests settle normally; no new pair can be made.

Additive: one `CREATE OR REPLACE FUNCTION`, no table touched, migrations 15 and 16 not amended. The
guard's body was sliced out of migration 16 by script rather than retyped — a diff shows 26 added
lines and zero removed.

### 14.6 What was not tested

No staging, no real merchant endpoint, no provider account, no device, no POS or wallet, and no
external network path. No outbound request left this machine. Freebuff supplies staging evidence
separately.

---

## 15. Correction — the trigger was never the concurrency guarantee

Raised in review of `bf00b89`, and correct.

### 15.1 What was wrong

Migration 17 enforced F1 with a `BEFORE INSERT` trigger running `SELECT ... EXISTS`, and §14.1
called that concurrency-safe. **It is not.**

That check reads only **committed** rows. Under READ COMMITTED — what this product runs — two
overlapping transactions each run the `SELECT`, each find nothing because the other's row is
uncommitted, each pass, and each commit. Two waiting tests, which is the thing the rule exists to
prevent. A trigger that reads is a check, not a mutual exclusion.

### 15.2 Why the test did not catch it

The evidence offered was `Promise.all` of two Prisma `create` calls. Prisma issues those as two
autocommit statements over **one** connection pool, so they serialize: the second genuinely sees the
first's committed row and is refused. It demonstrated **sequential** refusal and was read as
concurrency safety.

That is the mistake worth naming, because it is not a typo. **A test that cannot fail for the reason
you care about is not evidence about that reason** — and it passed, which made it persuasive.

### 15.3 What the rule is enforced by now

```sql
CREATE UNIQUE INDEX "WebhookDelivery_one_pending_test_key"
  ON "WebhookDelivery"("destinationId")
  WHERE "isTest" AND "status" = 'PENDING';
```

PostgreSQL serializes a unique index. The second inserter **blocks** on the first transaction's
uncommitted index entry; when the first commits it is refused with a unique violation, and if the
first rolls back it proceeds.

The trigger is **kept**, with its claim removed. Its job is to give the ordinary sequential case a
sentence that says what is wrong instead of a bare duplicate-key error. `queueTestDelivery` keeps its
`count` as an advisory fast path and now **catches P2002**, so a caller that loses a genuine race is
told the same thing as one that simply pressed the button twice.

### 15.4 Why the original argument against an index was wrong

It was: an index is validated against existing rows, so a duplicate somewhere would fail the build
and stop a deployment. That is true about indexes and the wrong conclusion — it traded a real
guarantee for a convenient deployment.

Migration 17 now keeps the guarantee and makes the failure **legible**: a `DO` block counts duplicate
waiting tests first and, if it finds any, stops with the exact read-only query an operator needs and
a statement that nothing was changed. It does not delete, settle, re-point or rewrite any delivery.
A delivery records that something was asked for; destroying history so an index can build is not a
repair.

Preflight, safe to run anywhere:

```sql
SELECT "destinationId", count(*) AS pending_tests
  FROM "WebhookDelivery"
 WHERE "isTest" AND "status" = 'PENDING'
 GROUP BY "destinationId"
HAVING count(*) > 1;
```

Staging: Freebuff reports no destinations created, so there can be no deliveries — the query is the
confirmation to run before applying 17, not a conclusion to carry.

### 15.5 The real proof, and the two near-misses on the way to it

`tests/integration/webhook-pending-test-concurrency.test.ts` took three attempts, and the first two
are worth recording because both **passed** while proving nothing.

*Attempt one* replaced the `Promise.all` with two `PrismaClient` instances and inferred "B blocked"
from a fixed 750 ms sleep. A fresh client's first query includes connecting and starting a query
engine, and that alone outlasted the sleep: B was still connecting, A committed, and the **trigger**
then refused B with `check_violation`. The blocking assertion was satisfied with B never having
reached the index.

*Attempt two* replaced the sleep with `SELECT count(*) FROM pg_locks WHERE NOT granted`. That proves
**some** backend somewhere is waiting — not that B is, and not that B is waiting on A. Any unrelated
wait in the database would have satisfied it.

*What is committed* binds the claim to B's own backend process and infers nothing from elapsed time:

1. A opens an interactive transaction and inserts a waiting test — uncommitted;
2. **B opens its own interactive transaction**, which pins one backend, and reads
   `pg_backend_pid()` **inside** it before submitting anything;
3. B submits its INSERT;
4. the **migrator** connection — a third backend, not in the race — polls `pg_locks` for **that
   exact PID** with `granted = false` and requires a **`transactionid`** wait, which is what an
   inserter blocked on another transaction's uncommitted index entry waits on. It polls until B is
   demonstrably waiting or fails saying which backend never waited. No sleeps, no global counts;
5. with B confirmed waiting, its INSERT must still be unsettled;
6. A commits — B is refused with **23505**, `Key ("destinationId")=…`, and explicitly **not** the
   trigger's sentence. One column in the key identifies which index fired: the other partial unique
   index on this table names two;
7. and the mirror: if A **rolls back**, B **succeeds** and commits.

Plus: two different destinations do not serialize against each other, and a destination stops being
constrained once its waiting test settles.

**Red proof.** Dropping *only* the partial unique index — the trigger verified still present —
fails it with `backend 276 never waited on a lock: nothing is serializing these inserts`, and the
duplicate goes through. That is the original defect reproduced by name. Restored: 4/4.

### 15.6 Status

**Verified.** Preflight: 0 duplicates in the development database (0 destinations) and a freshly
recreated test database. The blocker itself was exercised against two planted duplicates - it
raised with the exact query and left 4 rows as 4 rows with no index created. Migration 17 applies
cleanly from scratch, lock and all.

Concurrency proof 4/4 bound to B's backend PID; red proof fails by name when only the index is
dropped. Release-gate suite 11/11. Gate 16/16. Playwright 122 passed, twice. `migrate status` 17/17,
`migrate diff` unchanged, migrations 15 and 16 byte-for-byte untouched, audit and scans clean.

`docs/PHASE-3B-RELEASE-GATE.md` §7 carries the full table.
