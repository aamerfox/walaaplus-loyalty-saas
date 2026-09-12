# Zademi — the brand system

The product is **Zademi**. This file is the one place its identity is decided; everything visible in
the application takes its colour, type and naming from the tokens described here.

---

## 1. The assets

**The official artwork is in the repository.** It was supplied and approved on 2026-09-12 and lives
in `public/brand/`, byte-identical to what was delivered — nothing here was traced, redrawn,
recoloured or rasterised, and no component draws a substitute.

| File | What it is | Used for |
|---|---|---|
| `Zademi-Logo.svg` | canonical full logo, vector | headers, sign-in, anywhere with room |
| `Zademi-Symbol.svg` | canonical symbol, vector | compact navigation, tight spaces |
| `Zademi-Icon-1024.png` | approved square app-icon source | the only source for every raster derivative |
| `Zademi-Logo-Dark.png` | dark treatment | tinted light surfaces wanting one flat colour |
| `Zademi-Logo-White.png` | white treatment | navy and dark surfaces |

`tests/unit/brand-scan.test.ts` asserts all five are present and non-empty, that the SVGs are real
vectors (no embedded bitmap, no base64), and that the logo component references them.

### 1.1 Which asset goes where

| Surface | Component | Asset |
|---|---|---|
| Merchant sidebar, landing, pricing | `<Wordmark />` | `Zademi-Logo.svg` |
| Registration splash (navy panel) | `<Wordmark tone="white" />` | `Zademi-Logo-White.png` |
| Flat-colour light surfaces | `<Wordmark tone="dark" />` | `Zademi-Logo-Dark.png` |
| Phone header, avatars, tight spaces | `<BrandMark />` | `Zademi-Symbol.svg` |

The rule behind the table: **the dark treatment on light ground, the white treatment on navy.** The
colour logo is the default on white because it is the canonical artwork; the flat treatments exist
for grounds where the three-colour mark loses contrast.

### 1.2 Derivatives

`scripts/make-icons.mjs` renders every raster icon from `Zademi-Icon-1024.png` and **never touches
the masters**. It runs by hand when the artwork changes, not in the gate, and its output is
committed:

| Output | Size | For |
|---|---|---|
| `public/icons/card-192.png` | 192 | PWA icon, Android home screen |
| `public/icons/card-512.png` | 512 | PWA icon, splash, social preview |
| `public/icons/card-maskable-512.png` | 512 | Android adaptive icon — the mark at 78% on its own white ground, because a launcher crops the corners and transparency there shows the launcher's colour |
| `public/icons/apple-touch-icon.png` | 180 | iOS home screen, which composites no transparency |
| `public/icons/favicon-32.png`, `favicon-16.png` | 32, 16 | browser tab |
| `src/app/favicon.ico` | 32 | `/favicon.ico`, which browsers request by path whether or not a `<link>` exists |

It renders through Playwright's Chromium — already installed for the browser tests — rather than a
new image dependency or a hand-written resampler. The resampling is the one a phone would do.

## 2. Palette

| Token | Hex | Use | Contrast on white |
|---|---|---|---|
| `navy-900` | `#0B2D5B` | primary surface, primary button, headings | 12.6:1 |
| `turquoise-500` | `#00B3A4` | fills, borders, progress, accents | 2.6:1 — **never small text** |
| `turquoise-700` | `#00796F` | interactive text and links on light ground | 4.9:1 |
| `mint-500` | `#2ED47A` | progress and success fills | 1.9:1 — **never text** |
| `mint-700` | `#18794E` | success text | 4.8:1 |
| `cloud` | `#F4F6F8` | application background | — |
| `charcoal` | `#1F2937` | body text | 13.6:1 |
| white | `#FFFFFF` | cards and surfaces | — |

The two "never text" rows are why the accents have darker siblings. A turquoise headline on white
looks like the brand and fails WCAG AA at body size; `turquoise-700` is the same hue, passes, and is
what every link and interactive label uses.

### Semantic tokens

Components address `--color-surface`, `--color-ink`, `--color-border`, `--color-brand`,
`--color-accent-ink` and friends rather than the raw palette. Dark mode is a redefinition of those
seven or eight variables in `globals.css`, not a `dark:` class on every element.

**A component must not carry a brand hex value.** `tests/unit/brand-scan.test.ts` fails the build if
one appears outside the token file. The single exception is the installed card's manifest and its
matching `themeColor`: a manifest is JSON served to a phone's launcher and cannot read a CSS
variable.

---

## 3. Type

| Role | Face | Why |
|---|---|---|
| Latin headings | **Nunito** | the rounded, friendly half of the brand |
| Latin body | **Inter** | a UI face that holds up at 13 px on a till |
| **Arabic, everything** | **Cairo** | Inter and Nunito carry no Arabic glyphs |

The Arabic rule is not decoration. An Arabic string in a Latin-only stack falls through to whatever
the device has — on Windows a stiff Naskh face at the wrong optical size, on some Androids a tofu
box. `:lang(ar)` and `[dir="rtl"]` both switch the whole stack to Cairo.

All three are loaded through `next/font/google`, which downloads them **at build time** and serves
them from this origin. A `<link>` to `fonts.googleapis.com` would make every page load of a shop's
till send a request to a third party with its IP address attached.

Arabic numerals stay Western (0–9) so a balance reads identically to staff in both locales.

---

## 4. Layout and interaction rules

- **Logical properties only** — `ms-*`, `me-*`, `ps-*`, `pe-*`, `start-*`, `end-*`. A screen built
  with `ml-4` is a screen that breaks in Arabic.
- **One focus ring for the whole product**, on `:focus-visible` only, in turquoise. A till used with
  a thumb and a dashboard driven from a keyboard are the same app, and the second is unusable
  without it.
- **Colour is never the only cue.** Every badge and notice carries a word and a glyph.
- **Rounded cards, generous spacing**: `rounded-2xl` surfaces on a `#F4F6F8` ground.
- `prefers-reduced-motion` collapses every transition.

---

## 5. What the rebrand did NOT rename, and why

Renaming these would be a migration, an outage or a lie, so each keeps the old name:

| Name | Where | Why it stays |
|---|---|---|
| `walaaplus_app`, `walaaplus` | database roles | Renaming a role is a migration against a live database with no user-visible benefit |
| `walaaplus_protect_*` | trigger functions | Same, and they are named in migrations already applied |
| `walaaplus:auth-rate-limit:v1` | rate-limit HMAC label | It is the key derivation input. Changing it silently resets every live rate-limit window |
| `walaaplus-platform`, `rebuild/phase-0-foundation` | deploy remote, branch | Infrastructure, explicitly out of scope |
| Staging domain | deployment | Owner's, and unchanged |
| `docs/evidence/*` | historical records | Evidence describes what happened at the time. Editing it would falsify the record |

`tests/unit/brand-scan.test.ts` scans `src/app`, `src/components` and `messages` — the user-facing
tree — and fails on the old name there.

---

## 6. PWA and installed cards

The customer card's manifest takes its name from the **business and the program**, not from the
product, so a customer's home screen says "مقهى الاختبار" rather than "Zademi". That was true before
the official assets arrived and is unchanged.

What did change with them: the manifest's icons are now the approved artwork, and its `theme_color`
and the card page's `themeColor` are Zademi navy (`#0B2D5B`) rather than the previous indigo. Those
two values must stay equal — a launcher reads one and the browser reads the other, and a phone shows
the disagreement.

**An already-installed card will not update its icon or its tint by itself.** Android and iOS cache
the manifest and the icon at install time; a re-install — remove from the home screen, open the link,
add it again — is what picks up new artwork. A refresh of the open page is enough for the tab icon,
but not for the installed one.

**This has not been verified on a device.** Nothing in this repository has been opened on a real
phone since the assets landed, and nothing here claims otherwise. Re-install testing on Android and
iOS is a manual check to run after the next staging deployment.
