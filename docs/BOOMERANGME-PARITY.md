# Boomerangme parity — what Zademi has built, and what is still scheduled

`BOOMERANGME-REFERENCE.md` describes the reference product. This file answers the question a reader
actually has: **which of those capabilities exist in this codebase today, and where is the rest?**

Updated at Phase 1b Prompt 3. One row per capability, and the "Where" column points at the code so a
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
| Merchant dashboard metrics | **Built** — ledger-derived, with per-program and per-location breakdowns | `src/server/analytics/metrics.ts`, `/business` |
| PWA customer card | **Built** — per-card manifest and scope, service worker that caches nothing | `src/app/[locale]/card/` |
| Arabic-first bilingual UI | **Built** — every string in both locales, RTL structure, an Arabic-capable font stack | `messages/`, `docs/BRAND.md` §3 |

## Deliberately different

| Boomerangme | Zademi | Why |
|---|---|---|
| Public self-service enrolment by phone number | **Withdrawn** — staff issue cards at the counter | Owner decision **B7 option 3**: a public form that issues a card to a new number and nothing to an existing one reports whether a number is already a customer. See `docs/evidence/phase-1a-b7-option-3.md` |
| Public enrolment QR and campaign links | **Not published** — named sources exist as server-side attribution records only | Same decision. They become usable when proof of phone ownership exists and has been independently audited |
| Editing a live card template | **A live program's rules are frozen; a new VERSION is published instead** | A card keeps the rules it was sold under. Prompt 3 built the lifecycle that makes a change possible without touching a single issued card: draft, review, publish, with the old version retired and its cards left on it |
| Deleting a location, a program, a version or a card | **No destructive verb exists** | Every one of them is referenced by ledger rows that are append-only by trigger. Locations close, programs pause, versions retire, and nothing is ever removed |

## Not built, and which phase owns it

| Capability | Phase |
|---|---|
| Archiving a program (what happens to cards pinned to its versions is not designed) | 2 |
| Per-period reward usage limits, and showing a customer what they have already used | 2 |
| Cashback, discount, gift, membership and coupon card types | 2+ |
| Wallet passes (Apple, Google) | 1.5 |
| Web push, birthday and inactivity automations | 1.5 / 2 |
| RFM segments, feedback collection, referrals | 2 / 3a |
| CSV import and export | 2 |
| Public API, webhooks, GoHighLevel, POS connectors | 3b |
| Agency, white-label, franchise, billing | 4 / 5 |
| SMS and WhatsApp delivery | blocked on decisions D2/D4 |

`docs/PHASE-PLAN.md` remains the authority on ordering; this table is the map from the reference
product's vocabulary onto it.
