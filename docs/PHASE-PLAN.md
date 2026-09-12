# WalaaPlus — Phase Plan and Gates

Status: **Approved.** Companion to [PRODUCT-SPEC.md](PRODUCT-SPEC.md).

Phases are organised around **complete business loops**, not menu pages. Each phase leaves the product usable on its own.

---

## 1. The two-gate model

Every phase has two gates. They are closed by different people, using different evidence.

### Engineering gate — closed by Prompt 3 of each phase

Verifiable by tests and inspection: build, lint, typecheck, migrations, unit and integration tests, end-to-end journeys, security review, tenant-isolation review, index review, CI evidence, evidence file written.

Result is stated exactly as `ENGINEERING GATE PASSED — READY FOR THE NEXT PROMPT` or `ENGINEERING GATE NOT PASSED — BLOCKED BY: <criterion>`.

### Pilot gate — closed by the product owner

Real-world outcomes measured over days or weeks with real merchants. **No prompt can close a pilot gate.** The owner records dates, volumes, incidents and reconciliation results in the phase evidence file.

### Sequencing rules

```
Prompt 2 starts only after Prompt 1 engineering gate passes.
Prompt 3 starts only after Prompt 2 engineering gate passes.

The next phase Prompt 1 may begin once the previous phase
ENGINEERING gate passes.

A phase may not be RELEASED to pilot or production users while a
required predecessor PILOT gate remains open.
```

This is deliberate: development of phase N+1 proceeds while the phase N pilot runs in the field, so the team is not idle for thirty days. What is gated is **release**, not engineering.

### Severity rule

Critical and high findings block the engineering gate and are fixed inside the phase. Medium and low findings are recorded in the evidence file as known limitations with a follow-up item. Prompt 3 ends when no critical or high remains, not when the list is empty.

### Prompt shape, repeated per phase

| Prompt | Purpose |
|---|---|
| **1 — Core** | Schema, domain and server logic, migrations, authorization, unit and integration tests |
| **2 — Product loop** | Routes, UI, customer and staff flows, end-to-end tests, visual evidence |
| **3 — Release gate** | Security, regression, index and isolation review, defect fixes within scope, evidence file |

A prompt is a **gate, not a session**. It may span several sessions and commits. What matters is that no stage-2 work begins before stage 1 passes.

---

## 2. Phase table

| Phase | Deliverable | Engineering gate | Pilot gate (owner) |
|---|---|---|---|
| **0. Foundation** | Spec in repo, schema, global users and memberships, registration, tenant guards, audit log, ledger engine, idempotency, pg-boss worker, CI, gate script, backups and secrets plan | Ledger, idempotency and isolation tests pass in CI; clean-checkout gate command passes; worker runs independently | None |
| **1a. Café pilot** | Stamp card only, one location, owner and cashier, **staff-assisted enrolment and card-link restore at the counter** (owner decision B7 option 3 withdrew public self-service enrolment), PWA card with service worker, scanner, phone lookup, award, redeem, reversal, customer and operation lists | Full café loop passes end-to-end; reconciliation clean; cashier restrictions enforced | One pilot café, real daily transactions, owner-defined minimum scan count, no unreconciled discrepancy |
| **1b. Merchant MVP** | Points cards and reward tiers, richer template UI, named UTM links, full staff and location management, real dashboard metrics. **Prompt 1 ships the server and domain core** ([PHASE-1B-IMPLEMENTATION.md](PHASE-1B-IMPLEMENTATION.md)); Prompt 2 ships the merchant UI | Points and stamp regression suite passes; dashboard derives from ledger | Two merchants using both card types for two continuous weeks |
| **1.5. Hardening** | Offline card cache, PWA telemetry, native VAPID push, card and inactivity expiry, nightly reconciliation job, monitoring, backup drill | Security review, concurrency stress, backup restore evidence, staging deployment evidence, no critical or high open | 3–5 merchants, 30 consecutive days, minimum daily scan volume, zero unreconciled discrepancies, zero isolation failures, zero unresolved duplicate-award incidents |
| **2. Retention** | Birthday jobs, scheduled and targeted push, feedback collection, basic segments and filters, CSV import and export, UTM analytics | Job idempotency, import safety, segment correctness, analytics derived from ledger | Merchants use retention tools repeatedly, at least one measurable campaign outcome |
| **3a. Local growth** | Referral links and rewards, promotions, QR and print distribution assets | Referral fraud defences, promotion concurrency and limits | Measurable acquisition or repeat-visit lift with pilot merchants |
| **3b. Developer platform** | Public API, API keys, signed outbound webhooks, private GoHighLevel OAuth app, one validated POS connector | OAuth, token encryption, webhook signature and dedup, no duplicate loyalty writes from retries | Private GHL app tested in a real agency or location pilot |
| **4. Advanced programs** | Cashback and discount first, then multipass, gift, coupon, free membership | Every card type verified for balance, expiry, limits, reversal, pinning, regression | Each launched type has a validated merchant use case |
| **5. Platform scale** | Agency subaccounts, white-label domains and branding, plans and billing, franchise chains, public GHL Marketplace listing | Agency and franchise isolation, billing idempotency, currency correctness | Agency or franchise pilot runs safely; revenue and support model proven |
| **6. Ecosystem** | Workflow builder, two-way inbox, Employee Sales, AI onboarding, MCP server, partner directory | Workflow retries and idempotency, AI approval enforcement, MCP scopes, throughput | Core platform stable under real advanced-module workload |

---

## 3. Ordering notes

**Phase 1 is split** into 1a and 1b so a real café sees a working product early. The schema and engine support both program types from Phase 0, so 1b is largely UI and tests rather than architecture.

**The service worker belongs to 1a, not 1.5.** Android will not offer the install prompt without a registered service worker, and installability is the entire point of the PWA card. Only offline caching, push and restore wait for 1.5.

**Phase 3 is split by customer type.** Referrals and promotions serve Syrian merchants. The API, webhooks, POS connectors and GoHighLevel serve agencies abroad. They need different pilots and different skills.

**Phase 4 is ordered by cost.** Cashback and discount are nearly free once the ledger is unit-agnostic, being point balances with spend tiers, and may be pulled forward into Phase 2 if a pharmacy or retail pilot demands them. If built in Phase 2, Phase 4 Prompt 1 becomes an audit only. Multipass and gift are medium. Coupon needs linked-card conversion. Membership is last because paid collection has no local payment provider.

**Expiry and birthday features are scheduled with their jobs.** Card and inactivity expiry land in 1.5; birthday bonuses in Phase 2. Template settings for them must stay hidden until the job that honours them exists, so no merchant configures a setting that does nothing.

**Reconciliation is split.** The reconciliation query and test utility land in Phase 0 because Phase 1a's gate depends on it. The scheduled nightly job lands in 1.5.

---

## 4. Cross-cutting requirements for every Prompt 3

- Index review for changed and high-volume tables
- Tenant-isolation regression suite
- Authorization and permission review
- Security review, including secret scanning of anything newly tracked
- Full regression suite, CI run URL on the exact commit
- Migration status
- Known limitations with follow-up items
- Evidence file updated at `docs/evidence/phase-<phase>.md`

**Camera scanning is manual device evidence.** Playwright may drive a decoded-QR-token route, but no automated test may claim a physical camera scan was exercised.

**Deployment is shared.** The agent writes Docker files, CI workflows, worker configuration, scripts and runbooks. The owner runs them against servers using real credentials. Evidence files state who performed each step.

---

## 5. Market decision on GoHighLevel

**WalaaPlus will target GHL-connected agencies as a strategic post-MVP market.**

This does not weaken the Syria-first MVP. It means that agency expansion in Phases 3b and 5 will later require multi-currency support, a billing provider, and broader payment and wallet decisions that the Syrian market does not need. Those requirements are scheduled with the agency layer, not before it. `Business.currency` already exists so no schema change is required to keep the option open.
