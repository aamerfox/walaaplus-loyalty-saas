# Evidence — Phase 1b Prompt 2: Zademi brand system and merchant operations UI

**Date:** 2026-09-12
**Performed by:** development agent (Claude Opus 5)
**Branch:** `rebuild/phase-0-foundation`
**Baseline:** Phase 1b Prompt 1 deployed to staging at `b15b5407e1f10510fbb40e5875602b3f72ef532c`,
migration 6 applied, none pending.
**Scope:** the merchant-facing interface on top of the Prompt 1 core, and the rebrand from WalaaPlus
to Zademi. Development only — nothing deployed.

---

## 1. Result

**Complete.** Every screen listed in the prompt is built on a real authenticated server contract, and
the product is Zademi everywhere a user can see it.

| Check | Result |
|---|---|
| `npm run gate` | **PASS — 15/15 steps in 394.1 s** |
| `npm run test:e2e` (run 1) | **18 passed (55.0 s)** |
| `npm run test:e2e` (run 2) | **18 passed (57.9 s)** |
| unit / integration | **298 passed, 23 files** / **471 passed, 39 files** |
| `npm audit`, full tree | **0 vulnerabilities** |
| `npm audit --omit=dev --audit-level=high` | **0 vulnerabilities** |
| Migration status | **6 applied, none pending — no schema change in this prompt** |
| Secret scan | **clean** (§7) |
| `git diff --check` | **clean** |
| Prisma outside the server layer | **none new** (§7) |

The browser suite was run **twice** because the scanner journey changed; both runs are above, and
both are green.

**Not claimed:** nothing was deployed, no OCI contact, no Caddy/DNS/secret/Compose change, and **no
device testing was performed**. Staging still runs the Prompt 1 commit.

---

## 2. B7, re-checked line by line

The prompt calls this non-negotiable, and a rebrand-and-redesign prompt is exactly where it could be
undone by accident. Each line was verified against the code in this branch, not assumed:

| B7 requirement | State |
|---|---|
| Public self-enrolment disabled | Unchanged. `POST`/`GET /api/enroll` still return one constant `410`, from handlers declared with **no parameters** |
| `/{locale}/join/{anything}` is a static notice and inspects no token | Unchanged. `JoinWithdrawnPage()` takes no `params` and performs no lookup |
| No public program QR, enrolment link or phone oracle added | None added. The owner's program screens carry no link and no QR; `tests/e2e/merchant-ui.spec.ts` asserts `/join/` appears nowhere in the rendered HTML, and that `enrollment-url` does not exist |
| Named sources stay internal | `listSourceLinks` never returns a `publicToken`, and the new program screen renders names and card counts only |
| Card links revealed only by explicit staff action | Unchanged. The scanner shows no link until **reveal** is pressed; the e2e test asserts the token is absent from the DOM before that press |
| No logging, analytics, clipboard persistence or URL storage of a card link | The reveal writes an audit row with `metadata: {}`; the e2e test asserts the audit rows contain neither the token nor the substring `http` |
| Consent, audit, tenant isolation, rate limits, location checks, scanner protections not weakened | No change to any of them. The new routes add checks; none removes one |

---

## 3. The brand system

`docs/BRAND.md` is the authority. What matters for review:

- **One token file.** `globals.css` carries the palette, the semantic colours and the type stack.
  `tests/unit/brand-scan.test.ts` fails the build if a brand hex value appears in a component.
- **Contrast is decided once.** `turquoise-500` and `mint-500` are marked "never text" and have
  darker siblings (`turquoise-700` at 4.9:1, `mint-700` at 4.8:1) that every link and status label
  uses instead.
- **Arabic is set in Cairo**, not left to a Latin-only stack. Inter and Nunito carry no Arabic
  glyphs; the fallback on a Windows till is a stiff Naskh face at the wrong optical size.
- **No font request leaves the browser.** All three faces are downloaded at build time by
  `next/font/google` and served from this origin.

### 3.1 The missing asset, stated plainly

**There is no approved Zademi logo file in this repository** — no SVG, no PNG, no source. The product
ships a text wordmark beside a neutral geometric mark. **Nothing was traced or extracted from the
PDF.** `BRAND.md` §1 lists exactly which files are needed.

`public/icons/card-*.png` still carry the previous artwork and were deliberately not regenerated,
because regenerating them means inventing a logo. **An already-installed PWA card keeps its cached
icon**; a re-install is what picks up new artwork, and that is re-install testing to be done on real
devices when the assets arrive. Nothing here claims it has happened.

---

## 4. What was built, and the contract behind each control

| Screen | Server contract |
|---|---|
| `/business` dashboard | `getBusinessMetrics` — every figure ledger-derived, definitions in PHASE-1B-IMPLEMENTATION §7, and the page says so on screen |
| `/business/programs` | `listBusinessPrograms` |
| `/business/programs/[id]` | `getProgramDetail`, `getBusinessMetrics`, `listSourceLinks` |
| `/business/programs/new` | `POST /api/staff/programs` → `createPointsProgram` / `createStampProgram` |
| `/business/locations` | `listBusinessLocations` (read-only; see §5) |
| `/business/team` | `listBusinessStaff`, `listBusinessLocations`, `POST /api/staff/membership` |
| `/scanner` | `getScannerScope`, `/api/scanner/{lookup,award,redeem,points,reverse,enroll,card-link}` |

**Three properties the screens hold:**

1. **The browser never decides access.** Every page resolves the membership from the database on the
   request; every route re-checks it; every service checks it again. A hidden control is a courtesy.
2. **No location is ever guessed.** Where a program runs at several counters the actions stay
   disabled until a cashier chooses. The picker is built from a scope the server resolved from that
   member's own assignment, so it cannot offer an option the write would refuse.
3. **No setting exists that the domain does not have.** The program form offers the Phase 1b earn
   modes and nothing else — no expiry picker, no birthday bonus, no cashback toggle.

### 4.1 Two defects found and fixed in this prompt

| Defect | Why it mattered | Fix |
|---|---|---|
| **The scanner lookup read every card through the STAMP mechanics contract** (shipped in Prompt 1) | One points card in a business made a phone lookup throw, and it took that customer's stamp cards down with it — the lookup maps over every card the number matched. The engines were isolated; the read feeding the counter was not | `CardSearchResult` is a union on `cardType`, read through whichever contract owns the version. Covered by `merchant-routes.test.ts` |
| **The sidebar's sign-out button had no `onClick`** (shipped in Phase 0) | It sat on every merchant screen and did nothing. On a shared till the only way to end a session was to clear cookies, and whoever pressed it walked away believing they were signed out | A real `signOut` with a locale-aware callback, asserted by an e2e test |

---

## 5. Contracts Prompt 1 does not have — reported, not worked around

The prompt requires stopping and reporting rather than making an unreviewed schema or security
change. Three UI capabilities are blocked, and none was forced:

| Missing contract | Blocks | What the UI does instead |
|---|---|---|
| **Publish a new program version** | Editing a live program's mechanics; editing or reordering its reward tiers. `reward_tier_protect` and `program_version_freeze` refuse every write once a version is ACTIVE — deliberately, so a card keeps the rules it was sold under | The detail screen is read-only after creation and **says why** on screen. Tiers are named, priced and ordered at creation |
| **Create / rename / deactivate a location** | Everything a locations screen would do beyond listing | `/business/locations` is read-only and says so |
| **Create / deactivate a named source** | A source-link management screen | The program screen lists sources read-only |

Each is recorded in PHASE-1B-IMPLEMENTATION §12 with the same wording, so a later prompt picks them
up from the roadmap rather than from this file.

---

## 6. Tests

| File | Covers |
|---|---|
| `tests/integration/merchant-routes.test.ts` (17) | Program creation for the caller's own business; unknown, privileged and tenant fields refused; fractional and zero values refused; cashier and anonymous refused; duplicate-name conflict; role/permission/location/active changes; **self-edit refused**; **grant ceiling refused**; cross-tenant "not found"; points award, redeem and idempotent retry; a location the program does not offer; a required choice between several; a cashier refused at a location they are not assigned to; the stamp routes still refusing a location on a Main-only program and a nested one anywhere; reversal dispatched by card type on the server; **the points-card lookup regression** |
| `tests/e2e/merchant-ui.spec.ts` (6) | An owner creating a points program with two tiers and reading it back from real rows; invalid input that **sends no request**; Arabic RTL with Arabic navigation and a working locale switch; a points card served at a chosen counter with the award attributed to that branch; an unaffordable tier disabled; the card link hidden until revealed and absent from the DOM before it; the rebrand and a working sign-out |
| `tests/unit/brand-scan.test.ts` (3) | No old brand name in `src/app`, `src/components` or `messages`; one product name in both locales; no brand hex outside the token file |

Two existing tests were updated because this prompt deliberately changed what they pinned, each with
the reason written beside it: `scanner-client-camera.test.ts` asserted the scanner contained no
`locationId` at all (now: it sends one only when a person chose it, and never invents one), and
`message-parity.test.ts` learned that the product name is the same word in both locales.

All existing Phase 1a and Prompt 1 tests pass unchanged.

---

## 7. Secret scan, boundaries and data hygiene

- Tracked files matching `.env`, `secret`, `credential`, `*.pem`, `*.key`, `id_rsa`: exactly
  `.env.example` and `.env.staging.example`, both variable names with empty values.
- A pattern search for assigned secret-shaped literals across `src`, `scripts`, `prisma` and the
  workflows returns nothing.
- **No Prisma outside the server layer.** The one pre-existing exception is `/api/health`'s
  `SELECT 1` liveness probe, which is unchanged. The business layout's need for a user's initials was
  given a service (`getStaffInitials`) rather than a Prisma call in a layout, and that service
  returns initials only — never the email.
- **No capability value in any screenshot, fixture, log or audit payload.** The e2e suite asserts the
  card token is absent from the DOM before reveal and from the audit rows after it.
- The staff list shows name, email and role — the minimum needed to tell two people apart — and no
  phone, no password state, no last-seen.

---

## 8. Known risks

| Risk | Why it is acceptable now |
|---|---|
| **No device testing.** Nothing in this prompt was opened on a real phone | It is development work; staging still runs Prompt 1. The scanner's camera path is unchanged, and the merchant screens are tested at Pixel 7 width in the browser suite |
| **Installed PWA cards keep their old icon** | Documented in BRAND.md §6. It needs the real assets first, then re-install testing on both platforms |
| **A live program cannot be edited** | The database enforces it and the screen explains it, but a merchant who mistypes a threshold must create a new program today. The versioning contract is the fix (§5) |
| **Locations cannot be created from the UI** | A business with one counter is unaffected; a business that needs a second needs the missing contract (§5) |
| **The dashboard recomputes on every load** | Correct and fast at pilot volume; recorded as M-12 in the Prompt 1 evidence, with a rollup table as the Phase 2 fix |

---

## 9. Delivery

- Code and tests committed separately from documentation.
- `master` untouched at `b9ee686`.
- Only `rebuild/phase-0-foundation` pushed to the private deploy remote, with `git ls-remote`
  confirmed against the final HEAD.
