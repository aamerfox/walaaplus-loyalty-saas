# Boomerangme parity — what Zademi has built, and what is still scheduled

`BOOMERANGME-REFERENCE.md` describes the reference product. This file answers the question a reader
actually has: **which of those capabilities exist in this codebase today, and where is the rest?**

Updated at Phase 2 Prompt 1. One row per capability, and the "Where" column points at the code so a
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
| Customer segments | Saved definitions, server-derived counts, archive/restore | Nothing acts on a segment: no campaign, no message, no automation, no export |
| Analytics | Ledger-derived counts, breakdowns, date ranges, a per-branch filter | No cohort or retention view, no rollup table (recomputed per load, bounded — see `docs/evidence/phase-2-prompt-1.md` §5), no revenue or lifetime-value figures because the data to compute them honestly does not exist |
| Customer record | Identity, every card, balances, pinned versions, branch context, source name, ledger activity | No notes, no tags, no manual adjustment, and no export — export needs its own privacy, retention, authorization and audit contract |

## Not built, and which phase owns it

| Capability | Phase |
|---|---|
| Archiving a program (what happens to cards pinned to its versions is not designed) | 2 |
| Customer export (CSV or otherwise) — needs a privacy, retention, authorization and audit contract | 2 |
| **Engagement and campaigns** — sending anything to a segment: web push, scheduled sends, birthday and inactivity triggers | 2 / 1.5 |
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
