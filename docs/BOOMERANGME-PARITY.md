# Boomerangme parity — what Zademi has built, and what is still scheduled

`BOOMERANGME-REFERENCE.md` describes the reference product. This file answers the question a reader
actually has: **which of those capabilities exist in this codebase today, and where is the rest?**

Updated at Phase 2 Prompt 2. One row per capability, and the "Where" column points at the code so a
claim can be checked rather than believed.

---

## Built

| Boomerangme capability | Zademi today | Where |
|---|---|---|
| Stamp card mechanics | **Built** — manual / per-visit / spend-block earning, threshold conversion, daily limit, welcome bonus | `src/server/program/mechanics.ts`, `src/server/stamp/engine.ts` |
| Points card with reward tiers | **Built** — the same three earn modes, integer-only, tiers as rows with a price and a per-card usage limit | `src/server/program/points-mechanics.ts`, `src/server/points/engine.ts` |
| Immutable issued-card ledger | **Built and stricter** — append-only by trigger, compensating reversals, idempotency, balances as projections | `src/server/ledger/` |
| Several programs per business | **Built** — with card type and version pinned per card | `src/server/program/programs.ts` |
| Scanner: QR and phone lookup | **Built** — both first-class, plus serial | `src/app/[locale]/scanner/`, `src/server/customers/lookup.ts` |
| Scanner: award, redeem, reverse | **Built** for both card kinds, with a reversal that corrects the original location | `src/app/api/scanner/*` |
| Multi-location operations | **Built** — locations declared by the program version, enforced against the member's assignment inside the write transaction | `src/server/program/available-locations.ts` |
| Creating, renaming and closing locations | **Built (Prompt 3)** — a counter is closed, never deleted, so its ledger history stays attributed to it; three refusals protect a business from closing its way into an outage | `src/server/tenant/locations.ts`, `/business/locations` |
| Editing a live program | **Built as versioning (Prompt 3)** — draft from the live version, review the exact differences, publish atomically; issued cards keep the version they were sold under | `src/server/program/versions.ts`, `/business/programs/[id]/draft` |
| Program version history | **Built (Prompt 3)** — every version with when it went live, when it retired, and how many cards still run on it | `src/server/program/versions.ts`, `/business/programs/[id]` |
| Pausing a program | **Built (Prompt 3)** — stops new sign-ups only; every issued card keeps earning, redeeming and being reversible | `src/server/program/versions.ts` |
| Staff roles and permissions | **Built** — owner/manager/cashier, configurable permission sets, location assignment, activate/deactivate, with a self-edit rule and a grant ceiling | `src/server/tenant/memberships.ts`, `/business/team` |
| Named UTM source attribution | **Built, internal only** — created, renamed, activated and deactivated from the owner UI; every card carries its source, and no token, link or QR exists for any of them | `src/server/program/source-links.ts`, `/business/programs/[id]` |
| Merchant dashboard metrics | **Built** — ledger-derived, with per-program and per-branch breakdowns, date presets and a bounded custom range in the business's own timezone. Every count is a PostgreSQL aggregate: no metric loads a range into Node to count it | `src/server/analytics/metrics.ts`, `src/server/analytics/ranges.ts`, `/business` |
| Customer 360 / CRM record | **Built (Phase 2)** — one record per person, every card they hold read through its own card type's contract, balances and activity straight from the ledger, reversals shown as their own rows. No token, card URL or source token appears on it | `src/server/customers/customer-360.ts`, `/business/customers/[profileId]` |
| Saved customer segments | **Foundation (Phase 2)** — a validated, versioned, tenant-scoped DEFINITION with an allowlist of nine fields; membership and counts are derived server-side on every read and never stored. Nothing sends to a segment yet | `src/server/segments/`, `/business/segments` |
| Customer marketing preference | **Built (Prompt 2)** — an append-only history: every state, when it was recorded, how it was captured, by whom, and what it was before. The enrolment answer is the first entry and is never rewritten. A record that cannot say WHEN or TO WHAT WORDING somebody agreed reads as `UNKNOWN`, which is never a permission | `src/server/consent/consent.ts`, `/business/customers/[profileId]` |
| Campaign composer and content revisions | **Foundation (Prompt 2)** — a draft with a name, an intended channel, a language, and content kept as numbered revisions that cannot be edited or deleted. Drafts archive; they never hard-delete. There is no sent, scheduled or queued state to reach | `src/server/campaigns/campaigns.ts`, `/business/campaigns` |
| Campaign audience from a segment | **Foundation (Prompt 2)** — one saved segment per draft, re-evaluated live and returned as three integers: matched, may be contacted, may not. No recipient list is built, stored, returned or logged | `src/server/campaigns/campaigns.ts` `previewAudience` |
| Localized message preview | **Built (Prompt 2)** — Arabic RTL and English LTR both first-class, drawn from fixed sample values so no customer is ever read to render one. Two placeholders exist, `{{firstName}}` and `{{businessName}}`; anything else is refused by name | `src/server/campaigns/placeholders.ts` |
| PWA customer card | **Built** — per-card manifest and scope, service worker that caches nothing | `src/app/[locale]/card/` |
| Arabic-first bilingual UI | **Built** — every string in both locales, RTL structure, an Arabic-capable font stack | `messages/`, `docs/BRAND.md` §3 |

## Deliberately different

| Boomerangme | Zademi | Why |
|---|---|---|
| Public self-service enrolment by phone number | **Withdrawn** — staff issue cards at the counter | Owner decision **B7 option 3**: a public form that issues a card to a new number and nothing to an existing one reports whether a number is already a customer. See `docs/evidence/phase-1a-b7-option-3.md` |
| Public enrolment QR and campaign links | **Not published** — named sources exist as server-side attribution records only | Same decision. They become usable when proof of phone ownership exists and has been independently audited |
| Editing a live card template | **A live program's rules are frozen; a new VERSION is published instead** | A card keeps the rules it was sold under. Prompt 3 built the lifecycle that makes a change possible without touching a single issued card: draft, review, publish, with the old version retired and its cards left on it |
| Deleting a location, a program, a version or a card | **No destructive verb exists** | Every one of them is referenced by ledger rows that are append-only by trigger. Locations close, programs pause, versions retire, and nothing is ever removed |

## Foundation only — built, and deliberately not finished

These exist, are real, and are **not** the capability their name suggests in the reference product.
Saying so is the point of this table: a foundation counted as a feature is how a roadmap starts
lying to the person reading it.

| Capability | What exists today | What is still missing |
|---|---|---|
| Customer segments | Saved definitions, server-derived counts, archive/restore | A campaign draft can now NAME a segment as its intended audience. Nothing still acts on one: no message, no automation, no export |
| Campaign drafts | Name, channel label, language, revisioned content, an intended audience, validated placeholders, a preview, archive/restore | **Everything that delivers.** No provider, no credentials, no queue, no worker, no scheduler, no send verb, and no state a draft can enter that means any of those. Also missing: per-channel length and formatting rules, unsubscribe handling, delivery receipts, and any record of what was sent to whom |
| Marketing preference | Append-only history, capture context, actor, reason, the enrolment answer as the first entry, and a strict reading of what counts as permission | No customer-facing preference page and no unsubscribe route — both need a way to prove who is asking, which is the same unsolved problem as B7. No retention or erasure policy is implemented. No per-channel preference: the record says "marketing", not "SMS but not email" |
| Analytics | Ledger-derived counts, breakdowns, date ranges, a per-branch filter | No cohort or retention view, no rollup table (recomputed per load, bounded — see `docs/evidence/phase-2-prompt-1.md` §5), no revenue or lifetime-value figures because the data to compute them honestly does not exist |
| Customer record | Identity, every card, balances, pinned versions, branch context, source name, ledger activity | No notes, no tags, no manual adjustment, and no export — export needs its own privacy, retention, authorization and audit contract |

## Not built, and which phase owns it

| Capability | Phase |
|---|---|
| Archiving a program (what happens to cards pinned to its versions is not designed) | 2 |
| Customer export (CSV or otherwise) — needs a privacy, retention, authorization and audit contract | 2 |
| **Message delivery of any kind** — provider setup and credentials, a send verb, a delivery queue, a worker, retries, delivery reports | 2 / 1.5 |
| **Scheduled and triggered sends** — a future send time, birthday and inactivity triggers, recurring campaigns | 2 / 1.5 |
| **Unsubscribe links, tracking pixels and click tracking** | not scheduled — see B7; each one is a public endpoint that identifies a customer |
| **Provider-side message templates** (WhatsApp/SMS template approval and their own placeholder grammars) | blocked on D2/D4 |
| **Customer-facing preference centre** — a person changing their own marketing preference | blocked on the same unsolved problem as B7: proving who is asking |
| **Per-channel consent** — agreeing to SMS but not email | 2+, once a channel exists to consent to |
| **Referrals, promotions and games** | 3a |
| **POS, public API, webhooks and integrations** | 3b |
| **Advanced loyalty card mechanics** — cashback, discount, gift, membership, coupon, multipass | 2+ |
| **Agency, white-label, custom domain, billing, affiliate and franchise** | 4 / 5 |
| **Workflow automation, AI assistance and prospecting** | 4+ |
| Wallet passes (Apple, Google) | 1.5 |
| Per-period reward limits, and showing a customer what they have already used | 2 |
| CSV import | 2 |
| SMS and WhatsApp delivery | blocked on decisions D2/D4 |

`docs/PHASE-PLAN.md` remains the authority on ordering; this table is the map from the reference
product's vocabulary onto it.
