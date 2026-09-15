# Phase 3B release gate — capability and security matrix

**Prompt 3 release-gate audit** of the complete Phase 3B webhook release.
Baseline audited: `338023e8d8698e2f56e178d9e01420f41d014ec5`.

Every row below was checked against the **code, the tests, the database rules, the Compose topology
and the docs** — not against the previous prompt's claims about them. Where a row says *verified by
probe*, I ran something and read the answer rather than reasoning about it. Where a finding is
recorded, it is because something was actually wrong.

**Freebuff deployed `338023e` to staging during this audit and migration 16 is now applied there
(16 applied / 0 pending / 0 failed) and immutable.** Migrations 15 and 16 are therefore untouched.
The one database correction this audit required is **migration 17**, additive and not applied
anywhere yet.

> **Correction, after review.** The first version of migration 17 enforced F1 with a trigger alone
> and called that concurrency-safe. It is not: a `BEFORE INSERT` trigger reading `SELECT ... EXISTS`
> sees only committed rows, so two overlapping transactions each pass it and each commit. §4 now
> carries a partial unique index as the guarantee, the trigger is kept only for its readable
> sentence, and §4.3 records how the original test passed without proving anything.

---

## 1. Verdict

| | |
|---|---|
| Findings | **1 High**, **2 Low** |
| New migration | **17** — additive: a preflight check, a partial unique index, one INSERT-time rule. No table rewritten |
| Residual risks | 6, all documented, none newly introduced by this audit |
| Engineering gate | **Not asserted in this document.** The verdict belongs to the run that verifies it, and the F1 correction has not been through the quality bar yet — see §7 |

---

## 2. Findings

### F1 — HIGH — one tenant could set every other tenant's delivery latency

`queueTestDelivery` had **no bound**. A probe called it fifty times in a row: fifty accepted, fifty
left `PENDING`.

On its own that is a row count. What made it a defect is the other half of the design, which the
audit had to put together from two files:

- `claimDue` takes `BATCH_SIZE` (10) rows per minute **across every business**, ordered by
  `nextAttemptAt`;
- a test delivery is created **due immediately**.

So one owner's loop put an unbounded number of their own rows at the front of a queue every tenant
shares.

**Stated precisely, because the honest version is narrower than the alarming one.** Nothing was
exposed. No other tenant's delivery was marked failed — a delivery that is never claimed consumes no
attempt, so the retry cap is not reached by waiting. What the caller gained was control over **how
long every other business's webhooks wait**, without limit, with no access beyond their own owner
session, and with the delivery table growing the whole time. One tenant setting another tenant's
delivery latency is a tenant-isolation failure in the availability dimension.

**Fixed in three layers, and only one of them is the guarantee:**

| Layer | What it actually does |
|---|---|
| **Partial unique index** `WebhookDelivery_one_pending_test_key` (migration 17) | **The guarantee.** `UNIQUE ("destinationId") WHERE "isTest" AND "status" = 'PENDING'`. PostgreSQL serializes it: a second inserter blocks on the first transaction's uncommitted index entry and is refused when it commits |
| `walaaplus_webhook_delivery_guard` trigger (migration 17) | **A readable sentence, not a guarantee.** It reads committed rows only, so it refuses the ordinary sequential case with words instead of a duplicate-key error — and cannot serialize anything |
| `queueTestDelivery` | An advisory `count` so the common case costs one cheap query, plus a `catch` that turns the index's refusal into the same `409 WEBHOOK_TEST_PENDING` the sequential case gets |

Outstanding test deliveries are now bounded by the number of destinations, which is itself bounded
at `MAX_DESTINATIONS_PER_BUSINESS` (5).

### F2 — LOW — the batch-size rationale computed from a constant that no longer exists

`BATCH_SIZE`'s comment said *"ten requests at the transport's five-second timeout is under a
minute"*. Since Prompt 3 there is no transport module, and the worker's per-delivery ceiling is
`GATEWAY_TIMEOUT_MS` = **15 s**, so ten sequential deliveries is up to about **150 s** — not "under a
minute".

The conclusion (inside the 300 s lease) still held, so nothing misbehaved. But anyone tuning
`BATCH_SIZE` or `LEASE_SECONDS` would have computed from a wrong number, and this codebase has been
corrected three times already for writing down something that was not quite true. Corrected, with
the overlap consequence stated: a full slow batch outlasts the one-minute schedule, which is safe by
construction — `singletonKey`, `SKIP LOCKED`, and the claim token on every write.

### F3 — LOW — the stored job result was under-declared

`WebhookDeliveryResult` omitted `skipped`, which the summary does carry into the result pg-boss
stores in a table. A count, so nothing leaked; but the type is the description of what is kept, and
it was incomplete. Declared.

---

## 3. The matrix

Legend: **✅ verified** · **📋 documented residual** · **🔧 fixed by this audit**

### 3.1 Authorization and tenant isolation

| Claim | Status | How it was checked |
|---|---|---|
| Every webhook service function guards before it acts | ✅ | All seven ctx-taking exports call `requireWebhookOwner` on their first line; `webhooksConfigured()` takes no ctx and returns a deployment boolean |
| Owner-only, not owner-or-manager | ✅ | `requireWebhookOwner` = `EDIT_INTEGRATIONS` **and** `role === OWNER`; a manager holds `VIEW_INTEGRATIONS` and reaches the event history only |
| Every lookup is scoped by tenant | ✅ | 13 `businessId: ctx.businessId` clauses; every `destinationId` lookup is `findFirst({ id, businessId })`, so another tenant's row does not exist for this caller |
| The database enforces it independently | ✅ | `walaaplus_webhook_delivery_guard` refuses a delivery whose destination belongs to another business, and an attempt whose delivery does |
| One tenant cannot degrade another | 🔧 | **F1.** The partial unique index in migration 17 is the guarantee; the service check and the trigger are conveniences on top of it |
| The worker path carries no tenant context and needs none | ✅ | `runDueDeliveries` is a system job; every row it touches is re-read by id and claim token |

### 3.2 What must never leak

| Claim | Status | How it was checked |
|---|---|---|
| No logging in any webhook or egress module that sees a URL, body or header | ✅ | Source scan across `src/server/integrations/webhooks/**` and `src/egress/{server,dispatch,contract,auth,outcome}.ts` |
| The gateway's one log line carries no identifier | ✅ | `src/egress/index.ts` logs outcome, errorClass, httpStatus, duration — scanned for url/body/headers/ids |
| Audit rows carry the name and host only | ✅ | `recordAudit` metadata is `{name, endpointHost}` and `{deliveryId}`; scanned for URL/secret/ciphertext |
| No schema column can hold a body, header, address or error text | ✅ | `webhook-boundary.test.ts` scans the three models for `Json` and for forbidden column names |
| The response body never leaves the gateway | ✅ | Only `res.statusCode` is read; asserted in the boundary test and end-to-end against a receiver returning a marker string hundreds of times |
| **A database refusal does not echo the ciphertext or the plaintext URL** | ✅ 🔧 | **Verified by probe, then pinned.** Prisma's message carries the call-site source and our own trigger sentence — not the row. It is a property of Prisma's error formatting, so an upgrade could change it; now asserted |
| No customer data, token, code or digest in the webhook modules | ✅ | Raw-capability scan for `shareToken\|cardToken\|couponCode\|codeDigest\|passSerial\|walletToken\|phone\|email` across the webhook and egress trees: one hit, the word "capability" in a comment |
| `docker compose config` prints resolved values | 📋 | Inherent to Compose. The runbook says to pipe it through `grep -c` and never run it unpiped where it can be read |

### 3.3 Encryption fails closed

| Claim | Status |
|---|---|
| Absent or malformed key → configuration and delivery refuse, nothing else is affected | ✅ `webhook-crypto.test.ts`; `webhook-delivery.test.ts` asserts B7 and the till are untouched with the key removed |
| No plaintext fallback in any mode | ✅ there is no code path that stores or sends an unencrypted endpoint |
| Blank is treated exactly as unset | ✅ asserted, and load-bearing: compose passes `${VAR:-}` |
| The key never reaches the gateway | ✅ compose assertions plus a source scan of `src/egress/**` |

### 3.4 SSRF and the egress boundary

| Claim | Status |
|---|---|
| https only, public DNS name only, no IP literals | ✅ unit + integration |
| Loopback, private, CGNAT, link-local, multicast, reserved, documentation, metadata refused | ✅ both as URL shape and at connection time |
| Resolution immediately before connect; the address checked is the address connected to | ✅ `makeGuardedLookup`; every answer checked, not just the first |
| Redirects are an outcome, never a hop | ✅ 302 → `HTTP_REDIRECT`, permanent |
| CONNECT and Upgrade destroy the socket | ✅ raw-socket tests assert no `200 Connection Established` and no `101` |
| Absolute-form request target refused | ✅ 404 `BAD_PATH` before anything else is read |
| Only the fixed contract is accepted | ✅ 33 pure-function + 29 socket-level tests |
| Gateway authentication cannot be bypassed | ✅ red-proved: disabling it turns 7 tests red |

### 3.5 Port 443, at both ends

| Claim | Status |
|---|---|
| The owner's save refuses any other port before secret, ciphertext, row, audit entry or delivery exists | ✅ asserted by counting all four afterwards |
| The gateway keeps an independent check | ✅ red-proved: removing the save-time check leaves the gateway's 33 tests green |
| One constant, so the two cannot drift | ✅ `WEBHOOK_PORT` in `address.ts`, re-exported as `REQUIRED_PORT` |

### 3.6 Docker topology

| Claim | Status |
|---|---|
| `worker` is on internal networks only, in all three variants | ✅ compose assertions + resolved `docker compose config` |
| `webhook-egress` is the only service on the routable egress network | ✅ |
| The gateway publishes no host port and holds no database URL | ✅ its entire environment is `NODE_ENV`, `WEBHOOK_EGRESS_PORT`, `WEBHOOK_GATEWAY_SECRET` |
| Secrets reach only their intended containers | ✅ per-variant name assertions; `web` gets no gateway secret |
| No `env_file` anywhere | ✅ |
| Adding the gateway changed no published port | ✅ the complete binding set is restated literally |

### 3.7 Lease, retries and history

| Claim | Status |
|---|---|
| Atomic claim with `FOR UPDATE SKIP LOCKED` and a lease | ✅ |
| Per-delivery fresh read before each dispatch | ✅ |
| Every write carries the claim token | ✅ a lost lease writes nothing |
| Backoff 1 m / 5 m / 25 m / ~2 h, cap 5, database carries the same ceiling | ✅ |
| Duplicate attempts impossible | ✅ unique `(deliveryId, attemptNumber)` + the trigger requiring the number to follow the counter |
| Attempts are append-only | ✅ UPDATE, DELETE and TRUNCATE all refused, for the runtime role and the owner alike |
| The lease covers the worst case | ✅ 🔧 **F2** — it does (150 s < 300 s), but the stated arithmetic was wrong and is corrected |
| Disable / revoke / rotation races | ✅ governed by the per-delivery read's own snapshot; the limits are written down rather than promised away |

### 3.8 Database enforcement of every error class

| Claim | Status |
|---|---|
| Every declared class has a database opinion or a stated reason for not having one | ✅ the `CLASSIFICATION` table covers all 13 values and fails if one is added undeclared |
| `GATEWAY_REJECTED` permanent, never exhausted to `FAILED` | ✅ live inserts |
| `GATEWAY_UNAVAILABLE` retryable, never a refusal, `FAILED` only at the cap | ✅ live inserts |
| The rules are in the **live** functions, not just the migration file | ✅ read back with `pg_get_functiondef` |

### 3.9 Indexes and high-volume behaviour

| Claim | Status |
|---|---|
| The claim query has a matching partial index | ✅ `(status, nextAttemptAt, leaseExpiresAt) WHERE status = 'PENDING'` — predicate and `ORDER BY` both covered |
| The owner's delivery list is indexed and bounded | ✅ `(destinationId, createdAt DESC)`, `take: 20` |
| Attempts are reachable by delivery without a scan | ✅ the unique `(deliveryId, attemptNumber)` serves it; nothing in the app reads attempts at all today |
| One delivery per destination per event, forever | ✅ partial unique index |
| **Throughput is a global ceiling, not per tenant** | 📋 🔧 ~600/hour across the deployment, first-come rather than fair between tenants. Undocumented before this audit; now written down beside the constant, with the honest remedy if it is ever outgrown |
| No retention policy for deliveries or attempts | 📋 bounded in practice by business activity and by 5 attempts per delivery; nothing prunes them |

### 3.10 Regression

| Claim | Status |
|---|---|
| B7, referrals, promotions, cards, scanner, share links, health | ✅ full gate 16/16 and the browser suite twice; B7 has its own assertions in both suites |
| Nothing outside the webhook surface changed | ✅ the diff touches webhook/egress modules, their messages, their tests and their docs |

---

## 4. Migration 17

### 4.1 Why a unique index, and what the first version got wrong

The first version of migration 17 used **only** the trigger, and argued for it like this: a unique
index is validated against rows that already exist, so if an environment already held two waiting
tests for one destination the index would fail to build and stop the deployment.

That reasoning is factually right about indexes and **wrong about what to do with it**. It traded a
real guarantee for a convenient deployment, and then described the result as concurrency-safe, which
it was not:

> A `BEFORE INSERT` trigger running `SELECT ... EXISTS` sees only **committed** rows. Under READ
> COMMITTED — what this product runs — two overlapping transactions each run that `SELECT`, each
> find nothing because the other's row is uncommitted, each pass, and each commit. **A trigger that
> reads is a check, not a mutual exclusion.**

The guarantee is now the index:

```sql
CREATE UNIQUE INDEX "WebhookDelivery_one_pending_test_key"
  ON "WebhookDelivery"("destinationId")
  WHERE "isTest" AND "status" = 'PENDING';
```

PostgreSQL serializes that. The second inserter **blocks** on the first transaction's uncommitted
index entry; when the first commits it is refused with a unique violation, and if the first rolls
back it proceeds. That is mutual exclusion, not an observation about timing.

The build-failure risk is handled by making the failure **legible** instead of avoiding it. Migration
17 opens with a `DO` block that counts duplicate waiting tests and, if it finds any, stops with the
exact read-only query an operator needs and a statement that nothing was changed. It does **not**
delete, settle, re-point or rewrite a delivery row: a delivery records that something was asked for,
and destroying history so an index can build is not a repair.

### 4.2 Preflight, and what was actually inspected

Read-only, safe to run anywhere:

```sql
SELECT "destinationId", count(*) AS pending_tests
  FROM "WebhookDelivery"
 WHERE "isTest" AND "status" = 'PENDING'
 GROUP BY "destinationId"
HAVING count(*) > 1;
```

| Environment | Result |
|---|---|
| Local development and test databases | **Not yet inspected.** Docker Desktop is down on this machine and both databases live in it — see §7 |
| Staging | **Not run by me, and not assumed.** Freebuff reports no destinations created, so there can be no deliveries; the query above is the confirmation to run before applying 17, not a conclusion to carry |

Zero rows means migration 17 applies cleanly. Anything else is a human decision about those
deliveries — let them settle through the ordinary retry path, or settle them deliberately — followed
by a re-run of the migration.

### 4.3 How the original test passed without proving anything

The evidence offered for the trigger was `Promise.all` of two Prisma `create` calls. Prisma issued
those as two autocommit statements over **one** connection pool, so they serialized and the second
genuinely saw the first's committed row. The test demonstrated **sequential** refusal and was read as
concurrency safety. A test that cannot fail for the reason you care about is not evidence about that
reason.

`tests/integration/webhook-pending-test-concurrency.test.ts` replaces it with two `PrismaClient`
instances — two pools — and holds the first transaction open on purpose: it asserts the second insert
is **still unsettled** while the first is uncommitted, then refused with a unique violation naming
the index once the first commits, then allowed through if the first rolls back instead. Removing the
index must make it fail; that red proof is part of §7's outstanding work.

### 4.4 What it does and does not touch

Additive: a read-only preflight, one `CREATE UNIQUE INDEX`, one `CREATE OR REPLACE FUNCTION`. No
table created, altered or rewritten; no row changed; no enum value added, renamed or removed;
nothing dropped. Migrations 15 and 16 are not amended. Replacing a function body leaves the trigger
that references it pointing at the same function.

Building the index locks `WebhookDelivery` for the duration of the build. It is not `CONCURRENTLY`
because Prisma runs each migration in a transaction and `CREATE INDEX CONCURRENTLY` cannot run in
one; the table is small — deliveries settle — and the preflight has already established that the
build will succeed.

The guard's body was **sliced out of migration 16 by script rather than retyped** — a diff of the two
shows 25 added lines and zero removed.

---

## 5. Residual risks

Carried forward from `docs/WEBHOOK-EGRESS-TOPOLOGY.md` §6.2, re-checked and still accurate. None is
newly introduced by this audit.

| | |
|---|---|
| **R1** | The worker→gateway hop is plaintext HTTP on an internal Docker network. Authenticated and integrity-protected; not confidential against root on the host, a position that can already read the worker's memory where the same URL is decrypted |
| **R2** | Replay inside the ±300 s window can cause one duplicate delivery. Delivery is already at-least-once and every envelope carries a stable event id to de-duplicate on |
| **R3** | The gateway can reach the public Internet at the IP layer. The contract is the allow-list, not the route |
| **R4** | A merchant endpoint on shared hosting is indistinguishable from any other customer's |
| **R5** | The worker's copy of the URL check is advisory; the gateway's connect-time guard is the enforcing one |
| **R7** | No healthcheck on the gateway, deliberately: a health route would be a second contract |
| **NEW** | Global delivery throughput is ~600/hour and first-come rather than per-tenant fair (§3.9) |

R6 — save-time port enforcement — was closed before this audit and is not a residual risk.

---

## 6. What was tested, and what was not

**Verified for the original audit** (`61e7b65`/`bf00b89`, before the F1 correction): the full gate
(16 steps), the Playwright browser suite twice, the whole Vitest suite, `npm audit`,
`prisma migrate status` and `migrate diff`, `git diff --check`, a secret and control-byte scan over
every changed file, a raw-capability scan over the webhook and egress trees, resolved
`docker compose config` topology assertions for all three variants with secrets present and absent,
and the probes described above.

**Verified for the F1 correction:** TypeScript, ESLint, `prisma validate`, and the 616 unit tests —
everything that does not need a database.

**Not yet verified for the F1 correction, and not claimed:** the duplicate preflight against the
local databases, migration 17 applying, the overlapping-transaction test, its red proof, the rest of
the integration suite, the full gate and Playwright. See §7.

**Not tested, and not claimed at all:** anything on staging, any real merchant endpoint, any provider
account, any device, any POS or wallet, and any external network path. No outbound request left this
machine — the receiver every test talks to is started and stopped by the test on loopback. Freebuff
supplies staging evidence separately.

---

## 7. Outstanding — why this document does not assert a verdict

The F1 correction is written and reviewed but **not verified**. Docker Desktop is not running on this
machine, its backing Windows service is stopped, and the session has no rights to start it; both the
development and test databases live inside Docker, so nothing database-backed can run.

Blocked until Docker is available:

| | |
|---|---|
| Duplicate preflight against the local development and test databases | §4.2 |
| Migration 17 applying cleanly, including the preflight `DO` block | |
| `webhook-pending-test-concurrency.test.ts` — the real overlapping-transaction proof | §4.3 |
| Its red proof: drop the index, watch that test fail, restore | |
| `webhook-release-gate.test.ts` and the rest of the integration suite | |
| The full gate, and Playwright twice | |

Until those are green, **no replacement SHA is offered and nothing is pushed.** The corrected work
sits in the working tree. An engineering-gate verdict asserted from a run that did not happen would
be the same category of mistake as the one this section exists to correct.
