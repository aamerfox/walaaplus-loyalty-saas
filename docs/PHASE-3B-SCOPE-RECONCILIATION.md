# Phase 3B — scope reconciliation

**What Phase 3B promised, against what is actually built.** Documentation and source inspection only;
no code, migration, Compose or provider change was made by this task.

Baseline inspected: `9ff24e6cf5533f14df9bf9ca52ef9c2e1b8f633e`, deployed to staging.

The Phase 3B **webhook** release gate stands and is not re-opened here. What this document does is
separate that result from the rest of the phase's original promise, so neither is mistaken for the
other.

---

## 0. The distinction this document exists to protect

> **Webhook encryption and the egress gateway do not mean generic provider credentials, public API
> keys, GoHighLevel OAuth, or POS are built. None of those exists.**

Two secrets were introduced in Phase 3B, and both are narrow:

| Secret | What it protects | What it is **not** |
|---|---|---|
| `INTEGRATION_ENCRYPTION_KEY` | The destination **URL** and **signing secret** of a webhook the *owner* typed in | Not a provider credential store. Nothing else is encrypted with it, and no other subsystem imports the crypto module |
| `WEBHOOK_GATEWAY_SECRET` | Authenticates the worker to the egress gateway on one internal hop | Not an API key, not an OAuth token, not anything a third party ever sees |

**D27 — "where a provider credential would live, and who may read it" — is answered for exactly one
case and remains open for every other.** §8a of the capability matrix says so explicitly: it
"answers question 1 and 2 above for this one purpose and for no other." A webhook destination is a
URL the merchant owns and a secret **this product generated**. A provider credential is a token
**somebody else issued**, with an expiry, a refresh cycle, a revocation story and an account behind
it. The first is solved; the second is not started.

Concretely, verified against the source at this SHA:

- no model, table or column anywhere stores an API key, an OAuth access or refresh token, a client
  secret, or any provider credential — `grep` over `prisma/schema.prisma` finds no such model;
- no route anywhere authenticates with `X-API-Key`, a bearer token or an OAuth flow — every route
  under `src/app/api/` is session-authenticated staff/scanner, plus B7's constant `410`;
- there is no `/api/v1`, no versioned surface, and no public API of any kind.

---

## 1. The original promise

`docs/PHASE-PLAN.md` §2, row **3b. Developer platform**:

> Public API, API keys, signed outbound webhooks, private GoHighLevel OAuth app, one validated POS
> connector

`docs/BOOMERANGME-REFERENCE.md` §10 expands the same row into seven line items. Of everything listed
across both, **one** line item is built.

---

## 2. The matrix

Status key: **Built** · **Partial** · **Absent** · **Blocked** (cannot start until something outside
the code changes) · **Deferred** (a decision was taken not to build it now)

### 2.1 Internal integration events — **BUILT**

| | |
|---|---|
| **Status** | **Built.** Phase 3B Prompt 1 |
| **Code** | `src/server/integrations/events.ts`; `IntegrationEvent` model; migration `20260920120000_integration_events` |
| **Evidence** | `docs/evidence/phase-3b-prompt-1.md`; `docs/PHASE-3B-IMPLEMENTATION.md` |
| **Still missing** | **Two event types out of the reference product's ~40.** Both describe an already-finished promotion workflow. No backfill exists and the database refuses one |
| **Owner decisions** | **D28** — which workflows may ever emit an event. Each addition is a disclosure decision, not a convenience |
| **External dependency** | None |
| **Risks** | Low, and deliberately so: typed columns only, no JSON bag, no contact detail, no capability or digest. Append-only, tenant-checked by trigger. **D30** (retention) applies to the deliveries that carry these events |
| **Ordering** | Complete. Grows only when D28 is answered per workflow |

### 2.2 Signed outbound webhooks — **BUILT, and release-gated**

| | |
|---|---|
| **Status** | **Built.** Phase 3B Prompts 2–3, audited by the release gate |
| **Code** | `src/server/integrations/webhooks/`, `src/egress/`, `/business/integrations`; migrations 15, 16, 17 |
| **Evidence** | `docs/evidence/phase-3b-prompt-2.md`, `docs/evidence/phase-3b-prompt-3.md`, `docs/PHASE-3B-RELEASE-GATE.md`, `docs/WEBHOOK-EGRESS-TOPOLOGY.md` |
| **Still missing** | The re-encryption tool for key rotation (**D29**); a retention rule (**D30**); event types beyond two (**D28**). Throughput is a global ~600/hour ceiling, first-come rather than per-tenant fair (release gate R8); nothing prunes deliveries or attempts (R9) |
| **Owner decisions** | D28, D29, D30 |
| **External dependency** | None. A merchant supplies their own HTTPS endpoint; no account is opened by anyone |
| **Risks** | R1–R9 in `docs/WEBHOOK-EGRESS-TOPOLOGY.md` §6.2 and the release gate §5. The two that matter: the worker→gateway hop is authenticated but not encrypted (R1), and replay inside ±300 s can cause one duplicate delivery the at-least-once contract already permits (R2) |
| **Ordering** | Complete for this slice. **This is the one Phase 3B line item that is done** |

### 2.3 Public API — **ABSENT**

| | |
|---|---|
| **Status** | **Absent.** Not started, not scaffolded, not stubbed |
| **Code** | None. There is no `/api/v1` and no versioning scheme. `src/app/api/` contains `auth`, `enroll` (B7's 410), `health`, `scanner/*`, `share/resolve`, `staff/*` — every one session-authenticated |
| **Evidence** | `docs/INTEGRATIONS-CAPABILITY-MATRIX.md` §7 marks `X-API-Key` "Out of scope for this prompt" |
| **Still missing** | Everything: a versioned surface, key authentication, a documented contract, and the five cross-cutting concerns in §2.5 |
| **Owner decisions** | **New, and not yet written down** — see §4.1. What may an API key *read*, and may it *write*? This is the same question B7 answered for the public web: an endpoint that says whether a phone number is a customer is an oracle regardless of how it is authenticated |
| **External dependency** | **None.** This is the only major 3B line item with no third party in it |
| **Risks** | A public API is a new externally-reachable surface on a product whose current attack surface is one proxy and one session cookie. Tenant binding today comes from a session; a key needs its own. Audit attribution assumes a human actor |
| **Ordering** | **First.** Everything else in 3B either depends on it or is blocked on somebody else |

### 2.4 API-key lifecycle — **ABSENT**

Create, name, show-once, scope, rotate, revoke, expiry/retention.

| | |
|---|---|
| **Status** | **Absent.** No model, no table, no service, no screen |
| **Code** | None |
| **Evidence** | — |
| **Still missing** | All seven verbs |
| **Owner decisions** | **New** — scopes (§4.1), expiry policy, and retention of a revoked key's record |
| **External dependency** | None |
| **Risks** | Keys are bearer credentials: whoever holds one is the business. The mitigations this codebase already uses for share tokens and coupon codes — 256-bit random, **salted digest stored, never the value**, shown once, revocable — transfer directly and are the right pattern |
| **Ordering** | With the public API; they are one piece of work, not two |
| **Precedent that exists** | `src/server/share/share-links.ts` (256-bit capability, digest-only, revocable) and `src/server/promotions/codes.ts` (salted digest, never in the clear) are working implementations of show-once-never-readable in this codebase. **A webhook signing secret is the third.** None of them is an API key, but the pattern is proven here |

### 2.5 Response envelope, pagination, idempotency, rate limits, audit, tenant isolation — **PARTIAL**

The important nuance: **three of these exist as internal mechanisms and none exists as an API
contract.** Reusable, not reusable-as-is.

| Concern | Status | Where | What is missing for an API |
|---|---|---|---|
| **Response envelope** | **Absent** | `src/server/http.ts` has `errorResponse` only — `{error:{code,message}}` for failures. Success responses are ad-hoc per route | A declared success shape, a version marker, and a rule that every endpoint uses it |
| **Pagination** | **Absent** | `listDeliveries` takes a fixed `take: 20`; no cursor, no page metadata anywhere | A cursor contract, a stable sort, and a bound no caller can raise |
| **Idempotency** | **Partial — internal only** | `src/server/ledger/idempotency.ts` is real and enforces exactly-once counter writes | No HTTP `Idempotency-Key` header contract, no request/response replay store. The ledger primitive is the right foundation |
| **Rate limits** | **Partial — wrong axis** | `src/server/security/rate-limit.ts` (register, sign-in) and `staff-limit.ts` (per-actor counter limits, **D6**) | Nothing limits per API key. The reference product's figure is 10 req/s per key |
| **Audit** | **Partial** | `src/server/audit/audit.ts`, used throughout | Every entry names a **user**. An API key is not a user; attribution needs a new actor kind |
| **Tenant isolation** | **Built, but session-derived** | `TenantContext` + `requirePermission`, and database triggers that refuse cross-tenant rows independently | The isolation itself is strong and proven. What is missing is a **non-session** way to establish which business a request belongs to. This is the single largest correctness risk in building a public API here |

### 2.6 Private GoHighLevel application / OAuth — **BLOCKED**

| | |
|---|---|
| **Status** | **Blocked.** Not started |
| **Code** | None. No OAuth client, no callback route, no token storage |
| **Evidence** | `docs/INTEGRATIONS-CAPABILITY-MATRIX.md` §6: "Needs marketplace approval and an account" |
| **Still missing** | Everything: developer account, app registration, OAuth 2.0 install flow, token storage with refresh, contact sync, custom fields, SSO menu, workflow actions and triggers |
| **Owner decisions** | **D27 proper** — an OAuth access/refresh token is exactly the provider credential D27 is about, with an expiry and a refresh cycle the webhook key never had. **D7** (customer export) — contact sync *is* customer export to a third party, and D7 has been open since Phase 2. **E7** only for a public listing; a private app does not need it |
| **External dependency** | **Yes, and it is the blocker.** A GoHighLevel marketplace developer account the owner creates, app registration, and a public callback URL. None exists |
| **Risks** | Contact sync moves customer records out of this system — the highest-consequence data flow anyone has proposed for this product, and it lands on D7/D9 (retention and erasure), both open. OAuth tokens are long-lived credentials for someone else's system |
| **Ordering** | **After** the API foundation. An OAuth app is a consumer of the same authorization surface, and building it first means building that surface twice |

### 2.7 One validated POS connector — **BLOCKED**

| | |
|---|---|
| **Status** | **Blocked.** Not started, and deliberately gated on demand |
| **Code** | None |
| **Evidence** | `docs/INTEGRATIONS-CAPABILITY-MATRIX.md` §6 and §11 step 7: "on demonstrated demand from a real merchant" |
| **Still missing** | Everything, plus the prior design question |
| **Owner decisions** | **A demand decision first** — no real merchant has asked, and the matrix commits to "at most one validated connector, on demonstrated demand". Then **D27** for the vendor credential. Then a genuine design decision the matrix names and does not answer: **what a POS is allowed to do to an append-only ledger** |
| **External dependency** | **Yes.** Each of Toast, Square, Shopify, Lightspeed, GloriaFood, Altegio, WooCommerce is a separate marketplace, review process, account and data model |
| **Risks** | The accrue/reverse endpoints the reference product exposes would let an external system write to the ledger. This product's ledger is append-only by trigger with compensating reversals; a POS that can award and reverse is a second writer to the most sensitive table in the schema |
| **Ordering** | **Last of the three**, and only on validated demand |

### 2.8 Other Phase 3B promises found in the repository

| Promise | Where it is recorded | Status |
|---|---|---|
| ~40 webhook event types | `BOOMERANGME-REFERENCE.md` §10 | **Partial — 2 built.** Each addition is **D28** |
| Telegram report bot to the merchant | `INTEGRATIONS-CAPABILITY-MATRIX.md` §11 step 2, "next, and cheapest" | **Absent, blocked on D27.** Note: the roadmap ordered this *before* webhooks; webhooks were built first. Worth re-confirming the order still reflects intent |
| Weekly report by email or Telegram | `BOOMERANGME-REFERENCE.md` line 158 | **Deferred** in the reference mapping itself |
| Zapier, Make, Pabbly, Integrately, Albato, KonnectzIT | `INTEGRATIONS-CAPABILITY-MATRIX.md` §6 | **Deferred by design** — all reachable through the webhooks that now exist. This is the one place Phase 3B's completed work *does* discharge a promise beyond itself |
| Webhook key-rotation tool | **D29** | **Absent.** Rotating today makes existing destinations undecryptable — fails closed, but is not a rotation anyone would perform |
| Public GHL Marketplace listing | **E7**, `PHASE-PLAN.md` §2 row 5 | **Phase 5**, not 3B. Correctly out of scope |
| MCP server with OAuth 2.1 | `BOOMERANGME-REFERENCE.md` §10 | **Phase 6**, not 3B. Correctly out of scope |

---

## 3. Summary

| Phase 3B line item | Status |
|---|---|
| Internal integration events | **Built** (2 of ~40 event types) |
| Signed outbound webhooks | **Built and release-gated** |
| Public API | **Absent** |
| API-key lifecycle | **Absent** |
| Envelope / pagination / idempotency / rate limits / audit / tenancy | **Partial** — internal mechanisms exist, no API contract does |
| Private GoHighLevel OAuth | **Blocked** — external account, D27, D7 |
| One validated POS connector | **Blocked** — demand, external account, D27, ledger-authority design |

**One of five headline deliverables is complete.** The phase is not.

---

## 4. Next phase — three options compared

### 4.1 Option A — Public API + API keys foundation

| | |
|---|---|
| **External dependency** | **None** |
| **Blocked by D27?** | **No.** An API key is a credential *this product issues*, stored as a salted digest and never readable — the pattern already shipped three times here (share links, coupon codes, webhook signing secrets). D27 is about credentials *other people issue*, which this is not |
| **Blocked by anything outside the owner's control?** | **No** |
| **New owner decisions required** | Three, all answerable today with no third party: **(a)** may a key **write**, or is v1 read-only? **(b)** what scopes exist, and is a key per-business or per-integration? **(c)** expiry and what happens to a revoked key's record (retention — related to D9/D30) |
| **Why first** | Both other options consume this surface. GHL OAuth and a POS connector each need a non-session way to identify a business, a rate limit, an envelope and an audit actor — building either first means building all of that twice, informally, inside a connector |
| **Largest risk** | Tenant identity without a session (§2.5). Secondarily: an API that can answer "is this phone a customer?" re-opens exactly what **B7** withdrew, and must be designed against that from the first prompt rather than patched later |

### 4.2 Option B — Private GoHighLevel OAuth foundation

| | |
|---|---|
| **External dependency** | **Yes — blocking.** GoHighLevel marketplace developer account, app registration, callback URL. None exists and the agent cannot create one |
| **Blocked by D27?** | **Yes, properly.** OAuth access and refresh tokens are the credential class D27 exists for |
| **Also blocked by** | **D7** — contact sync is customer export to a third party, open since Phase 2 |
| **Verdict** | **Cannot start.** Three independent blockers, two of them outside the code |

### 4.3 Option C — One demand-validated POS connector

| | |
|---|---|
| **External dependency** | **Yes — blocking.** A vendor account and marketplace review, per vendor |
| **Blocked by D27?** | **Yes** |
| **Also blocked by** | **No validated demand** — the matrix commits to building one only for a real merchant who asked, and none has. Plus an unanswered design question: what a POS may do to an append-only ledger |
| **Verdict** | **Cannot start**, and should not be started ahead of demand even if the account existed |

### 4.4 Recommendation

**Option A**, and it is the only one of the three that is unblocked.

B and C cannot begin regardless of any decision the owner makes today, because each needs an account
with a third party that does not exist yet. A needs no third party at all — but it does need the
three decisions in §4.1(a)–(c), which no one has been asked yet.

Proposed shape, following `PHASE-PLAN.md` §1's three-prompt pattern. **Not started, and not to be
started until the owner chooses:**

| Prompt | Scope |
|---|---|
| **1 — Core** | The key model (digest-only, show-once, scoped, revocable, expiring), tenant resolution from a key rather than a session, the audit actor kind, per-key rate limiting, and the idempotency contract. Database rules and restricted-runtime-role tests, as every phase here has done |
| **2 — Product loop** | The owner's key-management screen — create, name, copy once, rotate, revoke — in both locales, plus the first read-only endpoints under a versioned path and their envelope and pagination contract |
| **3 — Release gate** | Security review of a newly public surface, B7 oracle review, tenant-isolation regression, index review for key lookup, rate-limit verification, and the evidence file |

Three decisions, then three prompts. If the owner would rather answer §4.1(a) as "read-only for
v1", Prompt 1 gets materially smaller and the ledger-authority question stays closed.

---

## 5. Documents corrected alongside this one

Three said or implied more than is true, and were corrected without touching the webhook release-gate
result:

| Document | What was wrong |
|---|---|
| `docs/BOOMERANGME-PARITY.md` | The "Not built" table still read *"POS, public API, webhooks and integrations — Prompt 1 built the internal event record … and no webhook, no endpoint, no key and no provider."* Webhooks are built; the rest is not. Split into what shipped and what did not |
| `docs/PHASE-PLAN.md` | The 3b row listed five deliverables with no indication that one is done and four are not |
| `docs/PHASE-3B-IMPLEMENTATION.md` | Titled as the phase's implementation notes while documenting Prompt 1 only, with no statement of what the phase still owes |

`docs/PHASE-3B-RELEASE-GATE.md` is **unchanged**. Its own scope line already says it audits "the
complete Phase 3B **webhook** release", which is accurate.
