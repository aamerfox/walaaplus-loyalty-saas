# Phase 3B Prompt 3 — isolated secure webhook egress

| | |
|---|---|
| Branch | `rebuild/phase-0-foundation` |
| Baseline | `79a9f7c` — Prompt 2 plus the compose secret-wiring correction (60499) |
| Capability matrix written first | `docs/WEBHOOK-EGRESS-TOPOLOGY.md` |
| Migration | **16**, `20260922120000_webhook_egress_gateway_classes` — two enum values, additive. Migration 15 untouched and still applied on staging |
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

Two new bounded classes, additive:

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
- **R6 — a destination saved on a port other than 443 is refused at dispatch, not at save time.**
  The gateway refuses it permanently as `GATEWAY_REJECTED`, which is correct, but the owner sees it
  in the attempt history rather than in an error when they press Save. Creation-time validation
  means a new message in both locales and was left out of this scope deliberately. **Recommended
  follow-up.**
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
