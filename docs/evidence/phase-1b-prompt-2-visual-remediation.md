# Evidence — Phase 1b Prompt 2: Zademi visual consistency remediation

**Date:** 2026-09-13
**Performed by:** development agent (Claude Opus 5)
**Branch:** `rebuild/phase-0-foundation`
**Baseline:** `b7642fc335411e5061a0465a043e23c873518ebf` (the rejected release)
**Commits:** `0235715` (code and tests), `d487213` (two phone fixes), plus this documentation commit
**Scope:** the owner's failed visual acceptance gate. Development only — nothing deployed, nothing
pushed beyond `rebuild/phase-0-foundation`.

---

## 1. Result

**Complete.** The five complaints are addressed, and each has either a test or a screenshot behind it.

| Check | Result |
|---|---|
| `npm run gate` | **PASS — 15/15 steps in 335.0 s** |
| `npm run test:e2e` (run 1) | **25 passed (1.1 min)** |
| `npm run test:e2e` (run 2) | **25 passed (1.1 min)** |
| Unit | **326 passed, 25 files** |
| Integration | **471 passed, 39 files** |
| `npm audit`, full tree | **0 vulnerabilities** |
| `npm audit --omit=dev --audit-level=high` | **0 vulnerabilities** |
| `npm run db:migrate:status` | **6 applied, none pending — no schema change in this task** |
| Secret scan over every changed file | **clean** (§6) |
| `git diff --check` | **clean** |
| Official masters in `public/brand/` | **byte-identical, untouched** (§6) |

**Not claimed:** nothing was deployed, no OCI contact, no Caddy/DNS/secret/Compose/env change, and
**no device testing was performed**. Staging still runs the baseline commit.

---

## 2. The five complaints, and what was done

### 2.1 "Page designs … do not feel like one system"

`src/components/ui/index.tsx` is now the product's vocabulary: `Card`, `Section`, `PageHeader`,
`Toolbar`, `Button`/`buttonClass`, `Field`/`TextInput`/`SelectInput`, `Badge`, `StatGroup`/`StatTile`,
`Table`/`Th`/`Td`, `Notice`, `EmptyState`, `DetailRow`, `ProgressBar`, `Spinner`, `Skeleton`. Every
merchant screen, the landing page, pricing, sign-in, registration and the public withdrawal page are
built from them. One control height (`h-11`), one radius scale, one border colour, one table density,
one icon scale, one button hierarchy where the variant carries meaning rather than decoration. The
rules are written down in `docs/BRAND.md` §4B.

The dashboard's eight identical tiles are now three groups — **who came**, **at the counter**,
**what it paid out** — and a group declares how many columns it holds, so a group of two no longer
leaves half a row of nothing.

### 2.2 "The logo renders as disconnected fragments"

The previous shell put the colour lockup in the rail **and** a standalone symbol in the top bar. A
merchant met two marks and read the small one as a piece of the large one.

- The rail is navy and carries the **complete official wordmark in the approved white treatment**.
- The top bar carries **no mark at all** — `header img` is asserted to be count 0.
- The phone drawer carries the same white lockup, whole; the rail's own logo block is suppressed
  inside the drawer so it cannot appear twice.
- Public surfaces (landing, pricing, sign-in, the withdrawn join page) carry the **colour SVG master**
  on light ground; the registration splash, being navy, carries the white treatment.
- No screen references an asset path itself: `tests/unit/platform-identity.test.ts` fails if anything
  outside `Wordmark.tsx` reaches for `/brand/…`.

### 2.3 "`TrueBiznes` appears repeatedly in product headers and subtitles"

- `PageHeader` has **no prop that can carry a business name**. Every merchant page's `description` is
  a sentence about that page, from the message files.
- `BusinessContext` is the single place a business appears as identity: a labelled value, or a
  `<select>` that switches business when the user has more than one. Label: `Navigation.businessLabel`
  ("Business" / "النشاط التجاري").
- The scanner shows the business the same way — labelled, in the corner — because a cashier working
  two shops needs to know which till they are on. Its heading is "Scanner".
- **No database record was renamed and no business data changed.** The staging tenant is still called
  TrueBiznes, correctly, because that is its name.
- The e2e fixture deliberately names its business `TrueBiznes`, so a leak back into the chrome fails
  the test on the screen it leaked into.

### 2.4 "The UI/UX lacks the Zademi soul"

Navy is the structural colour — the rail, the hero, the scanner, the primary button. Turquoise and
mint are punctuation: the accent button, the one figure in a group that carries the loyalty meaning,
the active-navigation bar. The indigo/fuchsia personality is gone and nothing gradient-heavy replaced
it: one turquoise wash on the hero, and that is the extent of it. `turquoise-500` and `mint-500` are
never small text on light ground (`turquoise-700` 4.9:1 and `mint-700` 4.8:1 are); on navy, body text
is white at 75%. Every string comes from `messages/*.json` — the landing page and sign-in, which were
written as inline `locale === 'ar' ? … : …` ternaries, were rewritten.

### 2.5 "Landing and authenticated surfaces don't feel like the same brand system"

The landing page was still the old design: a navy-to-crimson gradient headline, black pill buttons,
blue/fuchsia/green icon tiles, a grey skeleton pretending to be a dashboard, and claims for Apple
Wallet, Google Pay, push automations and white-label agencies — **none of which exists**. It is now a
navy hero, the shared card and button primitives, and three cards describing what Zademi actually
does: stamp and points cards, a counter that works on a phone, more than one branch. Pricing uses the
same navigation, the same header treatment and the same card; its plan names, prices and feature lists
were left alone as the owner's commercial content (§7).

---

## 3. Defects found by looking at the screenshots

Every item here passed the DOM tests. The instruction to open the images is what caught them.

| Defect | Where |
|---|---|
| The old product's lettered placeholder — a navy tile with a white "W" — above the sign-in form, with a dead `href="#"` "forgot password" link and an "SSL connection" badge | `/auth/login` |
| The Arabic registration page still named the old product, transliterated **and vocalised**, which the Latin-only brand scan could not see | `messages/ar.json`, `Register.localBusinessOnly` and `Register.terms` |
| The Arabic rail read "السياج الجغرافي (فروعك)" — *geofencing (your branches)* — for the screen that lists counters, and "إدارة فريق العمل" for the team | `Navigation.locations`, `Navigation.team` |
| The landing page was the previous product's design and advertised four unbuilt features | `/` |
| An Arabic word (`مخصص`) shown as the custom plan's price to English readers | `/pricing` |
| The active navigation marker was a `border-s-4` on a `rounded-xl` pill, so it drew a crescent beside the row rather than a bar on it | `Sidebar.tsx` |
| Arabic hero headlines collided line-to-line at a Latin display leading (`1.15`); the third line of the phone headline overlapped the second | `globals.css` |
| Stat tiles applied their padding twice | `StatTile` |
| A table's last row drew a rule that stopped short of the card edge (`last:border-0` matches the last **cell**, not the last row) | `Table`/`Td` |
| The public nav's sign-in control did not hide on a phone — `hidden` and the button's own `inline-flex` are both display utilities, and stylesheet order decided it | `/`, `/pricing` |
| The scanner's purchase field was a fixed 128px and clipped its placeholder to "Purchase amo" | `ScannerClient` |
| Registration showed no mark at all below `lg`, because the mark lives in the splash panel | `/auth/register` |
| The registration splash promised sharing a program's QR code, which **B7 removed** | `Register.splashBody` |

---

## 4. Routes inspected, and how

`tests/e2e/zademi-visual.spec.ts` writes **40 screenshots** into `playwright-results/visual/`: every
merchant surface plus the public chrome, at **1440×900** and **390×844**, in **Arabic** and
**English**.

Routes: `/business`, `/business/programs`, `/business/customers`, `/business/locations`,
`/business/team`, `/scanner`, `/`, `/pricing`, `/auth/login`, `/auth/register`. The counter is
photographed with a card actually loaded — an empty scanner shows none of what had to be fixed.

**Of those 40, these were opened and read by the agent** (the rest exist for the owner's review and
were not individually inspected, which is stated here rather than implied):

`desktop-en-landing`, `desktop-ar-landing` (nav strip), `desktop-en-pricing`, `desktop-ar-pricing`,
`desktop-en-auth-login`, `desktop-ar-auth-register`, `desktop-en-business`, `desktop-ar-business`,
`desktop-en-business-programs`, `desktop-ar-business-programs`, `desktop-en-business-customers`,
`desktop-ar-business-customers`, `desktop-en-business-locations`, `desktop-en-business-team`,
`desktop-en-scanner`, `phone-en-business`, `phone-ar-business`, `phone-ar-landing`,
`phone-en-auth-register`, `phone-en-scanner`, `phone-ar-scanner` — plus pixel-level crops of the
active-navigation marker, the Arabic hero headline, the scanner's action row and the registration
header.

Several of the fixes in §3 were made after a first inspection and re-verified in a later render; the
suite was re-run after every change.

---

## 5. Tests added

**`tests/unit/platform-identity.test.ts`** (9 tests) — the rule in source:

- no tenant name may be written into `src/` or `messages/` (comments are stripped first, so the prose
  explaining the bug does not trip the rule);
- `PageHeader` may not mention a business, and has no `subtitle` prop;
- the shell components may not render a business name themselves; `BusinessContext` must label it;
- brand artwork is referenced only by `Wordmark.tsx`;
- **no lettered placeholder tile** (`>W</span>`-shaped markup) anywhere in `src/app` or
  `src/components`;
- every navigation key exists in both locales, carries no retired vocabulary (`geofencing`, `السياج`,
  `team management`, `إدارة فريق العمل`), and the rail is built from message keys with no inline
  Arabic.

**`tests/unit/brand-scan.test.ts`** — extended to strip Arabic diacritics and match the old product
name in **both scripts**. Verified by injecting the leak back into `messages/ar.json` and watching the
test fail, then restoring it.

**`tests/e2e/zademi-visual.spec.ts`** (7 tests) — the rail carries exactly one image and it is the
white master; the top bar carries none; the tenant name appears once, under a label, and never as a
heading; exactly one `h1` per screen; every navigation destination is present under the label its own
message file gives it, in English and in Arabic; the Arabic drawer opens from the start edge; the
public surfaces use the colour master and the sign-in page has no `W`; and **B7's withdrawn join route
still answers the same to everyone**.

---

## 6. Boundaries, secrets and data hygiene

| Boundary | State |
|---|---|
| Prisma schema / migrations | **unchanged** — `git status` shows nothing under `prisma/`; 6 applied, none pending |
| Ledger rules, balances, points/stamps isolation, idempotency, reversal logic | **unchanged** — no file under `src/server/ledger`, `src/server/scanner` or `src/server/analytics` was touched |
| Permissions and tenant checks | **unchanged** — no change under `src/server/tenant` or `src/server/auth` |
| B7 public-enrollment boundary | **unchanged**, and still asserted by `zademi-visual.spec.ts` and the existing B7 suite |
| `GET`/`POST /api/enroll` constant 410 | **unchanged** — no route file touched |
| Card capability-link protections | **unchanged** — the reveal is still the authenticated staff action |
| Scanner write contracts | **unchanged** — only class names and one field width changed in `ScannerClient.tsx` |
| Real business/customer data | **untouched** — the only business named in code is the e2e fixture's, created and destroyed by the test |
| Docker, Compose, Caddy, DNS, firewall, secrets, deployment config | **untouched** — `git status` shows no such file |
| `public/brand/*` masters | **untouched** — not in `git status`; no byte of the supplied artwork was altered, traced, recoloured or split |
| `public/icons/*`, `src/app/favicon.ico` | **untouched** — the completed manifest/PWA icon work is preserved |

**Secret scan.** All 32 changed files were scanned for private-key blocks, AWS keys, JWTs, GitHub and
Slack tokens, password/secret/token assignments, PostgreSQL URLs carrying a password, and real Syrian
phone numbers. **No findings.** The phone numbers visible in the screenshots are generated by
`uniqueSyrianPhone()` in the test fixtures and belong to no one.

**No Prisma access outside server-owned code**, no external analytics, trackers or runtime font
requests were added. Fonts remain build-time self-hosted through `next/font/google`.

---

## 7. Known limitations, stated plainly

1. **No device or staging verification.** Nothing here has been opened on a real phone. The browser
   evidence is Chromium at two emulated viewports. Android and iOS checks — including the PWA
   re-install needed to pick up the new icon and tint, which an already-installed card will **not**
   take by itself — remain a manual gate after the next deployment.
2. **The pricing plans' commercial content was deliberately not touched.** Prices, plan names and
   feature lists are the owner's marketing copy. They still describe SMS automations, RFM analytics,
   feedback collection, CNAME mapping and a white-label agency tier, none of which the product has,
   and they still use the word "Geofencing" for what the navigation now calls Locations. That is an
   owner decision about what to sell, not a UI defect, and it is flagged rather than edited.
3. **Two programs on a 1440px desktop leave a third of the programs grid empty**, because the grid is
   three columns from `xl`. It is right for a merchant with four programs and airy for one with two.
4. **Dark mode is defined but not systematically reviewed.** The tokens carry dark values and the
   screens use them, but no screenshot in this pass was taken in a dark colour scheme.
5. **The visual record is a record, not a regression test.** Nothing compares these screenshots to a
   baseline; they exist so a human can look. Pixel-diff baselines would need a stable font and
   rendering environment, which this project does not yet pin.
6. **`Register.splashBody` was rewritten** to stop promising a shareable QR code. That is a copy
   change on a public page, made because B7 removed the thing it described, and is noted here in case
   the owner wants different wording.

---

## 8. Delivery

- Two code commits (`0235715`, `d487213`) and this documentation commit, on
  `rebuild/phase-0-foundation`.
- Pushed to the private `deploy` remote only. **`master` was not touched, not checked out and not
  pushed.**
- **Nothing deployed.**
