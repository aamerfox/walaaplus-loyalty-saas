# Evidence — Phase 1a, Prompt 2

**Prompt:** Public Enrollment, PWA Card, Scanner, and Minimal Business Screens
**Date:** 2026-09-11
**Performed by:** development agent (Claude Opus 5)
**Branch:** `rebuild/phase-0-foundation`
**Predecessor:** Phase 1a Prompt 1 — PASS at `8d290ff`, with the one-location correction recorded after it (`docs/evidence/phase-1a-prompt-1.md` §9)

---

## 1. Result

**COMPLETE.** Every code deliverable, every automated check, and — as of 2026-09-12 — every
real-device manual check has passed. The manual rows were performed by the owner on physical
phones against staging running commit `c759d78`; see §8.

This file originally reported `BLOCKED on owner decision B3`, because there was no HTTPS staging to
verify installability or camera scanning against. That was true when written. Staging now exists,
the checks have been run, and §8.1 records what changed rather than overwriting it.

| Check | Result |
|---|---|
| `npm run gate` on `60d392e`, the final commit | **PASS 13/13 in 246.1 s** |
| Unit tests | **119/119** (11 files) |
| Integration tests, real PostgreSQL | **363/363** (30 files) — 54 new |
| Playwright browser journey | **3/3 scenarios** |
| `npm audit` full tree | **0 vulnerabilities** |
| `npm audit --omit=dev --audit-level=high` | **0 vulnerabilities** |
| `git diff --check`; working tree | clean; clean |
| Typecheck, lint (`--max-warnings=0`), production build | pass, pass, pass |

**What was blocked, and no longer is:** items 1–5 of the manual checklist in §8. All now passed.

Nothing was pushed, deployed or provisioned. No migration was required.

**A note on the prompt's document names.** It asked for `docs/WALAAPLUS-MVP-SPEC.md` and
`docs/DECISIONS.md`. Neither exists; the repository's approved equivalents are
`docs/PRODUCT-SPEC.md` and `docs/DECISIONS-REQUIRED.md`, and those are what was read. No document
was created to match the names in the prompt.

---

## 2. Baseline

The gate was run **before any edit**, as instructed: **PASS 13/13 in 209.2 s**, unit 119/119,
integration 309/309, on `f4b447d` with a clean working tree. The baseline was sound, so work
proceeded.

---

## 3. Commits

On top of `f4b447d`. `master` untouched at `b9ee686`; tag `prototype-baseline` → `0aee6ee`. No
amend, no force-push, no history rewritten.

| # | SHA | Subject |
|---|---|---|
| 1 | `c52864e` | feat(server): public card view, scanner context, QR rendering and enrollment limits |
| 2 | `90b24e9` | feat(api): public enrollment and authenticated scanner endpoints |
| 3 | `bf4dfef` | feat(pwa): public enrollment page, customer stamp card and the installable foundation |
| 4 | `bd729bf` | feat(web): scanner, customer list, card history and the minimal cashier screen |
| 5 | `5a7186f` | test(web): route, card, scanner and browser coverage for the café loop |
| 6 | `60d392e` | docs: the Phase 1a screens, the PWA boundary and what is not claimed |
| 7 | `3028bf0` | docs: the Prompt 2 evidence, and the one thing it cannot claim |
| 8 | (this commit) | docs: fill in the evidence commit SHA, which row 7 could not know while it was being written |

---

## 4. Scope completed

### 4.1 Public enrollment

`/{locale}/join/{token}` and `POST /api/enroll`. Public in the proxy (the route was already
reserved in Phase 0). The opaque link token is the only input; business, template and version are
derived from it server-side, so a body naming a `businessId` changes nothing — proven by a test
that passes a rival's ids and gets a card in the correct business.

- **Rate limit**: database-backed, per client address **and per link**, reusing the Prompt 0.3
  limiter. The per-link window is what holds where no trusted proxy supplies an address.
- **Honeypot**: `companyWebsite`, hidden with the clip-based `sr-only` pattern. A filled honeypot
  is answered like an ordinary failure **and still counts against the rate limit**.
- **No enumeration**: a first enrollment and a repeat return the same status and the same body.
  The response is the card's page token alone — no ids, no phone number, no `created` flag.
- Syrian phone normalisation through the existing canonical service; idempotent enrollment and a
  once-only welcome bonus carried over unchanged from Prompt 1.

### 4.2 Customer stamp card

`/{locale}/card/{shareToken}`. Addressed by the **page** token, never the scanner token. Shows the
business, program, drawn stamp progress, reward state, serial, and the QR the holder presents. The
QR is **inline SVG rendered on the server** — the only URL in the document is the SVG namespace, so
nothing is fetched and no third party ever sees a scanner token. Marked `noindex`. The page offers
no award, redeem, reversal or staff function at all.

### 4.3 PWA foundation

| Piece | Detail |
|---|---|
| Manifest | Per card: `id`, `start_url` and `scope` are that card's path, so three cards install as three apps. Carries only business and program name |
| Service worker | `public/sw.js`, registered with the card's path as scope. **Caches nothing; has no `fetch` handler at all** |
| Icons | Real PNGs generated by `scripts/make-icons.mjs` using zlib, committed. Placeholder artwork by design |

The worker caches nothing deliberately: a card carries a balance, a name and a scanner token, and a
cache-first worker would leave that in cache storage and serve a stale balance that disagrees with
the counter. **Offline card state, web push, VAPID, `lastOpenedAt` and restore are not implemented
and are not claimed.**

### 4.4 Scanner

`/{locale}/scanner`, with `/{locale}/scanner/login` public so a cashier reaches a login rather than
a redirect loop. QR and phone lookup are equal first-class paths. Award, redeem and reverse go
through the approved engine services. Every mutating call carries a **client-generated idempotency
key**. Conflicts are translated from a **code** (`NO_REWARD_AVAILABLE`, `DAILY_LIMIT_REACHED`,
`CARD_NOT_TRANSACTABLE`, `ALREADY_REVERSED`, `IDEMPOTENCY_CONFLICT`), never from a server message,
so an Arabic screen never prints an English sentence from an API.

The camera uses the browser's own `BarcodeDetector` where present and degrades to the paste/type
field elsewhere, including iOS Safari. **No automated test claims a physical camera scan.**

### 4.5 Owner screens

Customer list with phone-normalised search and cursor paging; card detail with the immutable
operation history (a reversal appears as its own row beside the original — there is no edit and no
delete); and the owner-only cashier form with a read-only staff list. The sidebar now lists the
routes that exist; the remaining prototype pages stay hidden.

---

## 5. Scope deliberately deferred

Points, cashback, discount, template/versioning UI, multiple locations, campaigns, automations,
referrals, wallet passes, push notifications, GHL, billing, agency features, public API credentials
and webhooks — none added. Offline card state, web push and install telemetry remain Phase 1.5.
Staff management beyond the single cashier verb remains Phase 1b.

---

## 6. Commands and results

| # | Command | Result |
|---|---|---|
| 1 | `npm run gate` (baseline, before editing) | **PASS 13/13 in 209.2 s**; unit 119, integration 309 |
| 2 | `npm install qrcode-generator` | zero dependencies, MIT; `npm audit` still 0 |
| 3 | `node scripts/make-icons.mjs` | three valid PNGs (192, 512, 512 maskable), signature and IHDR verified |
| 4 | `npx tsc --noEmit`, iteratively | fixed as found: a `const` assertion, two translator namespaces, a wider enum union than the message keys |
| 5 | `npx eslint . --max-warnings=0` | one real error: `Date.now()` inside JSX (`react-hooks/purity`). Expiry moved into the view, where it belongs — a view that hands a component a timestamp to compare with "now" makes rendering depend on the clock |
| 6 | `npx next build` | all routes present: `/join/[token]`, `/card/[shareToken]`, its manifest, `/scanner`, `/scanner/login`, five API routes |
| 7 | `npx vitest run --project integration tests/integration/public-enrollment-route.test.ts` | **17 passed** |
| 8 | `… scanner-routes.test.ts` | **24 passed** |
| 9 | `… customer-card-page.test.ts` | 1 failure, mine: the assertion "no URL in the QR SVG" also matched the SVG **namespace** URI. Replaced with an exact check that the only URL present is that namespace |
| 10 | same, re-run | **13 passed** |
| 11 | `npm run gate` | **PASS 13/13 in 245.7 s**; integration 363 |
| 12 | `npm run test:e2e` (first attempt) | **failed twice, both real**: (a) `test-env.ts` refused the run because `DATABASE_URL` equalled `TEST_DATABASE_URL` — the guard working as designed; the config now sets the harness's own deliberate-use marker; (b) `next start` does not support `output: standalone` |
| 13 | `npm run test:e2e` (second attempt) | **failed: `<html> intercepts pointer events`.** A genuine UI bug — the honeypot's `left:-9999px` pushed the document's edge and, in RTL, moved every control out from under the pointer. Replaced with the clip-based `sr-only` pattern |
| 14 | `npm run test:e2e` | **3 passed (33.2 s)** |
| 15 | `npm run gate` on `60d392e` | **PASS 13/13 in 246.1 s** — §7 |
| 16 | `npm run test:e2e` on `60d392e` | **3 passed (33.2 s)** |
| 17 | `npm audit`; `npm audit --omit=dev --audit-level=high` | **0 vulnerabilities** each |
| 18 | `git diff --check`; `git status --porcelain` | clean; clean |
| 19 | `grep -rn "locationId" src/app` | one hit, and it is a comment. **No route or page reads or accepts a location** |
| 20 | `grep -rE "prisma\.\w+\.(create\|update\|upsert\|delete…)" src/ --exclude src/server` | **none**. Every Prisma write is in `src/server` |
| 21 | `git rev-parse master`; remote refs; branch upstream | `b9ee686`; only `origin/master`; **no upstream** |

### Gate output

```
=============================================================
GATE SUMMARY
=============================================================
PASS  dependency audit (prod, high+)             1223 ms
PASS  prisma generate                            2099 ms
PASS  lint                                       6545 ms
PASS  typecheck                                  5852 ms
PASS  prisma validate                            1648 ms
PASS  unit tests                                 2003 ms
PASS  test db up                                  992 ms
PASS  migrate deploy (test db, migrator role)    6156 ms
PASS  migrate status (test db)                   5903 ms
PASS  runtime role grants (test db)               158 ms
PASS  integration tests                        198265 ms
PASS  worker build                                114 ms
PASS  production build                          15096 ms
-------------------------------------------------------------
GATE PASSED in 246.1s (13/13 steps)
```

**CI run URL: none.** Pushing is still forbidden until owner decision A1. The `e2e` workflow is
committed and will run on `rebuild/**` once pushing is authorised.

---

## 7. Test totals

| Suite | Files | Tests | Environment |
|---|---|---|---|
| unit | 11 | **119** | none |
| integration | 30 | **363** | real PostgreSQL 15, as the restricted runtime role |
| browser (Playwright) | 1 | **3 scenarios** | standalone build on a Pixel 7 viewport |

New in this prompt — 54 integration tests and the browser journey:

| File | Tests | Proves |
|---|---|---|
| `public-enrollment-route.test.ts` | 17 | one card per valid link; welcome bonus once; a repeat answered identically to a first; unknown/empty/altered/truncated/case-changed/deactivated/archived links all refused alike; a body naming another business ignored; a body naming a location refused with nothing written; honeypot refused, counted, and identical for a known customer and a stranger; a generic 429 naming neither link nor business |
| `scanner-routes.test.ts` | 24 | 401 everywhere with no session; 403 for a non-member; QR/phone/serial lookup; a rival's real token finding nothing; award, threshold crossing, redeem, reverse; conflict codes surfaced; idempotent retry, concurrent duplicate once, reused key refused; **location refused on every mutating endpoint and when nested or differently spelled, with no ledger write**; cashier able to serve but not create staff; owner-only cashier creation with no password in the response |
| `customer-card-page.test.ts` | 13 | the card's own data only; no internal identifier anywhere; paused and expired reported; **the scanner token refused as a page token**; altered/truncated/deleted tokens refused alike; QR inline with nothing fetched; per-card manifest scoped per card with installable icons and no customer data |
| `tests/e2e/cafe-journey.spec.ts` | 3 | the full non-camera journey; the QR path from a **decoded** token with a rival's token finding nothing; a card page unreachable by guessing or with the scanner token |

---

## 8. Manual verification checklist — PASSED, by the owner, on real devices

**Every row below was performed by the owner on physical phones and confirmed on 2026-09-12**,
against the staging deployment running commit `c759d78`. None of these is automated, and none is
claimed to be: they are a person holding a phone, which is the only way any of them can be
answered.

No personal data is recorded here. No names, phone numbers, QR values, enrolment links,
credentials or screenshots — a card's QR is a capability, and an evidence file is read by more
people and kept longer than the screen that legitimately shows it.

| # | Check | Device | Result |
|---|---|---|---|
| 1 | Android Chrome offers "Install app" on a card page, and the installed icon opens standalone | Android | ✅ passed |
| 2 | iOS Safari "Add to Home Screen" produces a standalone card | iPhone, Safari | ✅ passed |
| 3 | Three cards from three businesses install as **three separate** home-screen icons, and none shows another's balance | Android | ✅ passed — separate, no cross-exposure |
| 4a | A real camera scan of a printed card QR resolves the customer | Android (Huawei) | ✅ passed |
| 4b | A real camera scan of a printed card QR resolves the customer | iPhone, Safari | ✅ passed |
| 5 | Camera permission refusal degrades to mobile-number lookup without a dead end | phone | ✅ passed — the cashier has a usable fallback |
| 6 | The service worker registers, and Cache Storage shows **no cached card responses** | phone, DevTools | ✅ passed — Cache Storage empty |
| 7 | Arabic RTL and English LTR reviewed on a real phone in both locales | phone | ✅ passed at phone width |

**The full café loop was exercised end to end on the deployed build**, beyond the seven rows
above:

| Step | Result |
|---|---|
| Owner registration through the UI | ✅ |
| Loyalty-program creation through the UI | ✅ |
| Customer enrolment from the public link | ✅ |
| Welcome stamp granted on enrolment | ✅ |
| Stamp awarding at the counter | ✅ |
| Automatic reward conversion on reaching the threshold | ✅ |
| Reward redemption | ✅ |
| Reversal of that redemption | ✅ — **the reversed reward reappeared correctly on the customer card** |

That last row is the one worth naming. The ledger is append-only and a reversal is a new row
rather than an edit, so "the reward came back" is the observable proof that the compensating entry
was written and the balance recomputed from it — on a real device, through the real screens.

What was **already** automated and passing, and remains so: the manifest is served with the right
`id`, `scope` and `display` and the right locale direction, every icon it names returns 200,
`sw.js` is served and contains no cache and no `fetch` handler, and the card renders its QR as
inline SVG. Those were always necessary conditions for installability, never proof of it. Row 1
and row 2 above are the proof.

**Has the owner supplied HTTPS staging?** Yes. It is live, and these checks ran against it.

### 8.1 What this supersedes

This file previously ended with a `BLOCKED` line naming the absence of HTTPS staging, and §8 read
"NOT performed". Both were true when written: there was no host, no hostname and no certificate,
and owner decisions B1, B2 and B3 were open. All three have since been answered, staging was
deployed, and two camera defects found by the first real-device attempt were fixed
(`docs/evidence/phase-1a-prompt-2-cohost-config.md` §14). The blocking condition is gone, so the
standing result is the one at the foot of this file; the earlier line is recorded here rather than
quietly overwritten.

---

## 9. Known limitations

No critical or high issue remains. Everything below is Low unless marked.

| # | Sev | Item | Why acceptable now | Follow-up |
|---|---|---|---|---|
| **B-1** | **Blocked** | Installability and camera scanning unverified | No HTTPS origin exists; both need a secure context on a real device | Owner: B1–B3, then §8 |
| L-13 | Low | The card does not work offline | The service worker caches nothing on purpose; a stale balance at a counter is worse than a blank page | Phase 1.5 |
| L-14 | Low | Icons are a placeholder mark | Valid PNGs at the required sizes; the manifest names files, so replacing artwork needs no code change | Phase 1b design |
| L-15 | Low | `BarcodeDetector` is absent on iOS Safari, so the camera button degrades there | Phone lookup is a first-class path, not a fallback; a bundled decoder is weight for one browser | Revisit in Phase 1b |
| L-16 | Low | The scanner reverses only the group it just created | Reversing an arbitrary historical operation needs a picker and a confirmation flow; the engine already supports it by group id | Phase 1b |
| L-17 | Low | The card history page shows the first 50 operations with no "load more" | The service already pages; the control is UI work | Phase 1b |
| L-18 | Low | A user with several memberships sees a business chooser on staff screens | The pilot has one business per owner; the chooser is tenant-safe (every choice is re-verified) | Phase 1b |
| L-19 | Low | One `locale === "ar"` ternary remains, in the manifest route | It selects the manifest's `dir` **value** (`rtl`/`ltr`), not translated text. All UI strings go through next-intl message files | none |
| L-20 | Low | `next start` cannot serve this app (`output: standalone`) | Documented; e2e and Docker both run the standalone server, which is the shipped artifact | none |
| — | — | Prompt 1's M-6 (enrollment rate limiting and honeypot) | **CLOSED by this prompt** | — |

---

## 10. Required confirmations

- **No critical or high issue remains.** Full `npm audit` and the production view are both 0.
- **No direct Prisma write was added outside approved server infrastructure.** Verified by grep
  (§6 #20): every `create`/`update`/`upsert`/`delete` lives under `src/server/**`, and no page or
  route handler writes through Prisma. Pages read through tenant-scoped services only; the one
  page that briefly read memberships directly was moved behind `listBusinessStaff`.
- **No public route accepts `locationId`.** Verified by grep (§6 #19) and by tests that send one at
  every mutating endpoint, nested and differently spelled, and assert a 400 with no ledger write.
  `assertNoLocationInRequest` enforces it at the HTTP boundary; the engine refuses it again beneath.
- **The approved ledger engine is preserved.** Routes call services; no route or page constructs a
  ledger row, writes a balance, or touches cards or reward tiers through Prisma.
- **Idempotency holds** for enrollment and for every scanner action, proven under concurrent
  duplicates.
- **`master` was untouched** (`b9ee686`), nothing was pushed (the branch has no upstream;
  `origin/master` is the only remote ref), nothing was deployed, and no account, domain or
  credential was created.

---

**PASS — PHASE 1A PROMPT 2 MANUAL GATE COMPLETE — READY FOR PHASE 1A PROMPT 3**
