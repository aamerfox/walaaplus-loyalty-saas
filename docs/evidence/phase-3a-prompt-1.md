# Phase 3A, Prompt 1 — wallet web links and safe referral sharing

Baseline `08f38c29abaa45e2e8f8fffc52aa6047550f955a`. Branch `rebuild/phase-0-foundation`.
**Amended after a read-only review** — see §12. The verification figures below are from the
re-run after the correction, not from the original pass.
Local work only: nothing contacted OCI, staging, Freebuff, Caddy, DNS, Docker infrastructure, a real
customer, or any external service. No Caddy, DNS, TLS, Compose, Docker, secret or environment
template was touched, and the official Zademi assets in `public/brand/` are byte-identical.

---

## 0. The capability audit came first, and then checked the work

`docs/WALLET-CAPABILITY-MATRIX.md` is the mandated audit: every Apple Wallet and Google Wallet
capability that could plausibly suit Zademi, sorted into **Supported now**, **Needs provider setup**,
**Needs business decision**, and **Not appropriate / deferred**, with a roadmap and a manual device
gate.

An honest note on ordering: the implementation was already under way when the audit was required, so
the matrix was written and then used to **re-check what had been built**. It changed nothing about
the two capabilities that ship, because they were already the two the matrix classifies as
*Supported now*; it did surface the reasoning that is now written down rather than assumed — most
usefully that **Apple renders no button on the front of a pass**, which is the single most likely
thing for a roadmap to promise by analogy with Google's link module.

Exactly two rows are turned on:

| platform | capability | where |
|---|---|---|
| Apple Wallet | a tappable URL in a **back field**, with link detection | `buildApplePassJson` |
| Google Wallet | `linksModuleData.uris[]` | `buildGoogleLoyaltyObject` |

Everything else — signing, updates, notifications, location relevance, Smart Tap, Apple VAS, beacons,
callbacks, app links — is documented, bucketed and scheduled. None of it is implemented, prepared or
claimed.

---

## 1. The capability

**A fifth secret, drawn apart from the other four.** A card already carries a scanner `qrToken`, a
card-page `shareToken`, a serial and an enrolment source token. The invitation capability is drawn
independently of all of them, so that being forwarded an invitation yields none of the rest: no card
page, no balance, no counter scan, and no way to learn whose card it came from. Reusing `shareToken`
would have meant forwarding an invitation to a group chat forwarded somebody's loyalty card with it.

**Only a digest is stored.** `sha256(raw)` over 32 bytes of `crypto.randomBytes`. No salt and no
keyed HMAC: the input has no dictionary to precompute, and a keyed digest would need a secret this
phase may not add. A database copy yields nobody a working link.

**The token travels in a URL fragment.** `https://<host>/share#<capability>`. A fragment is not sent
with a request — not to this server, not through a proxy, not in a `Referer` header to the next site
the visitor opens, and not into an error report. The browser posts it to `/api/share/resolve` in a
**body**, which is the only point on the server that ever sees one.

The cost is that the page cannot be server-rendered, because the server does not know which link was
opened. That is why the page is a client component with a loading state.

**Resolving records nothing.** No audit row, no counter, no last-seen timestamp, no IP, no user
agent, no rate-limit state. Not rate limited, deliberately: a per-address limit would mean storing
the address of everyone who opens an invitation, which is precisely the tracking this page exists
without, and 256 bits behind one indexed lookup does not need one.

**One shape for every failure.** Unknown, revoked, malformed, absent, a deleted card, an inactive
business: `{ ok: false }`, and the same generic notice on screen.

**Issue-once, revoke-once.** Minting retires a card's live link in the same transaction. Revoking is
final. No "regenerate in place" exists, because the old raw value is unrecoverable by construction.

---

## 2. The database, and a third privilege category

One additive migration, `20260917120000_card_share_links`: one table, three indexes (including a
partial unique index giving one live link per card), three foreign keys, two trigger functions.
Nothing existing is altered, dropped or backfilled.

`CardShareLink` is the first table here that is **not strictly append-only**, and that needed an
argued decision rather than a default.

Revoking *is* a state change, so the table cannot refuse UPDATE the way the ledger and the consent
history do. But an issued capability is a fact about what was handed out, and a revocation that
erased the row would leave nothing to audit. So:

| | permitted | refused |
|---|---|---|
| runtime role — new `NO_DELETE_TABLES` in `scripts/db-roles.mjs` | SELECT, INSERT, UPDATE | DELETE, TRUNCATE |
| `card_share_link_revoke_only` trigger | `revokedAt`, NULL → a value, once | every other column, and un-revoking |
| `card_share_link_no_delete` / `_no_truncate` | — | removal, by anyone including the owner |

Two layers, as everywhere else: the grant stops the app, the trigger stops anyone above it. The
narrow rule is a trigger's job because a grant cannot express it. `db-roles.mjs` verifies the new
category explicitly and prints it.

**Drift:** `prisma migrate diff` between the schema and the database it produces reports only the two
pre-existing cosmetic `ConsentRecord` name differences carried since Phase 2 Prompt 2. This migration
contributes none.

**No raw token anywhere.** A repository-wide scan for `/share#<long-token>` returns nothing outside
runtime test output; no migration, fixture, snapshot, doc or committed test output contains one.

---

## 3. Authorization, decided rather than inherited

`src/server/tenant/permissions.ts` carries a standing note beside the cashier's `EDIT_CUSTOMERS`
grant: anything later guarded on that bit must decide whether a cashier should have it, rather than
assume it still means what it meant. So it was decided, and the decision is asserted:

| action | bar | reasoning |
|---|---|---|
| mint a capability | `EDIT_CUSTOMERS` — **a cashier may** | handing over a card and adding it to a wallet are the same moment at the counter |
| revoke | `EDIT_CUSTOMERS`, **not a cashier** | it destroys something the customer already holds |
| read link status / wallet preview | `VIEW_CUSTOMERS`, **not a cashier** | reading a card's link history is reading the customer's record — the same bar as the consent history |

Every read and write resolves the card through the caller's own `businessId` in the `WHERE`, so a
cross-tenant id resolves to no row at all and answers 404 rather than 403. Tested for minting,
revoking and the wallet route.

---

## 4. Wallet payloads

Builders only. Apple needs a Pass Type ID certificate and Google a service-account key; neither can
be added here, so **nothing is signed and nothing is delivered**. Issuer identifiers are parameters
filled with visible placeholders in a preview, because a configuration decision written as a constant
is a configuration decision nobody made.

| | Apple | Google |
|---|---|---|
| the link | a back field, `dataDetectorTypes: ["PKDataDetectorTypeLink"]` | `linksModuleData.uris[]` |
| the barcode | the card's scanner `qrToken`, unchanged | the same, unchanged |
| the front of the card | **never** — front fields print on a lock screen | **never** — text modules render in the body |

Both prohibitions are unit-tested against a real payload, and again in the integration suite against
a real card.

**Two functions, and the difference is the point.** `issueWalletPassPayloads` mints and returns the
live URL — it is what a future signing step calls, and it is **not exposed on any route**, because
there is no signing and a route returning an unsigned payload with a live capability would be a
token-disclosure surface built for no consumer. `previewWalletPass` does **not** mint: a preview that
minted would retire the link already in the customer's wallet every time staff opened their card.

**Redaction runs over the whole serialised payload**, not a known field, so a field added later that
happens to carry the URL is redacted too rather than being the one somebody forgot.

**The honest caveat, stated in the product and not only here:** a pass already saved in a customer's
wallet does **not** gain the link on its own. There is no update channel — Apple's needs
`webServiceURL` and APNs, Google's needs the API. The link appears when the pass is issued again and
saved again, and the owner UI says exactly that.

---

## 5. The public page

`/share`, one path for every business, capability in the fragment. Shows the Zademi mark, the
business name, a QR of **the canonical invitation URL**, native share where the device has it, copy,
the link as selectable text, eight platform links, and one line telling a newcomer that cards come
from the counter.

**What it hands out is locale-neutral** — corrected after review, see §12.

Shows **no** customer name, phone, card number, serial, balance, programme, card link or scanner QR.
The browser test reads the real values out of the database and asserts each is absent from the DOM.

**Eight share targets, no SDK.** WhatsApp, Telegram, Facebook, X, Reddit, Bluesky, Threads, email —
every one a plain link a browser follows. The suite asserts every `<script src>` on the page is
same-origin, because the difference between a share button and a tracking surface is whether it
brings third-party JavaScript with it.

**Messenger is absent**, and that is the answer rather than an omission: its web share dialog requires
a registered Facebook app id — an external account this phase may not add — and a bare
`fb-messenger://` deep link does nothing on a device without the app. The native share button reaches
Messenger on any phone where it is installed: the same outcome, without the broken button.

**Graceful degradation.** `navigator.share` is detected, so the button is absent where it would do
nothing rather than present and dead. A refused clipboard leaves the link on screen and selectable. A
platform that will not open still leaves the QR, the copy button and the other seven.

**No promise of a reward.** No referral policy exists (**D15**), so no string on this page or on a
wallet pass may imply that sharing earns anything. Enforced twice: a unit test walks every message in
both locales against a reward-word list, and the browser suite checks the rendered page in Arabic and
English.

---

## 6. B7, unchanged

- `GET`/`POST /api/enroll` still answer a constant `410`.
- `/join/<anything>` is still the static withdrawal notice with no form.
- The invitation page has **no form, no input, no textarea** and creates no card, customer, profile
  or ledger row however often it is opened — asserted by counting rows before and after.
- No public enrolment, customer lookup, card-reveal, preference or unsubscribe route was added.
- A GET on the resolver — the shape that would put a token in a URL — is refused with a 405 by a
  handler named explicitly rather than by a router default.

---

## 7. Referral boundary

Nothing in this prompt credits anybody for anything. No referral table, column, reward, ledger row or
attribution exists; an integration test queries `information_schema` for any table matching
`%referral%` and requires none, so the phase that adds one has to come and say so.

A link click is not proof of a referral, a QR scan is not proof of a person, and the public link
enrols nobody — so there is no moment that honestly says "this person joined because of that
person". That is why **D15 — Referral attribution and reward policy** is an owner decision and its
own phase in the capability map, not a feature flag here.

---

## 8. Verification

| check | result |
|---|---|
| `node scripts/gate.mjs` | **PASS 15/15**, 469.1 s |
| `npx playwright test` (run 1) | **70 passed**, 2.4 m |
| `npx playwright test` (run 2) | **70 passed**, 2.1 m |
| `npx vitest run` | **81 files, 1046 tests, all passed**, 364 s |
| `npm audit` | 0 vulnerabilities |
| `npm audit --omit=dev` | 0 vulnerabilities |
| `node scripts/db-migrate.mjs status` | 11 migrations, schema up to date |
| `prisma migrate diff` (schema ↔ database) | only the two pre-existing `ConsentRecord` name differences |
| `git diff --check` | clean |
| secret scan | only the `sk_live_...` / `pk_live_...` literal placeholders in the committed `.env.production.example` |
| raw-capability scan | no `/share#<token>` in any tracked file |

Tests added: 25 unit (16 wallet payload, 9 capability and wording), 31 integration, **16** browser,
plus 3 bypass attempts and 1 privilege assertion in the runtime-role suite. The two extra browser
tests are the locale-neutrality coverage from §12.

### Failures on the way, reported rather than hidden

1. **The gate failed once on lint** — an unused `type Page` import in the new browser spec, left over
   from a helper that moved. Fixed; the passing run is the one quoted.
2. **Three of my own test expectations were wrong**, each for a different reason worth recording:
   `createStampCafe({ name })` names the *programme*, not the business, so the resolver assertion
   compared against the wrong string; Facebook's sharer takes a URL and no text, so a uniform
   "every href names the business" expectation was false; and the third-party-script check compared
   against `localhost` while the suite runs on `127.0.0.1`.
3. **A test asserted the wrong thing about cashiers.** It expected minting to be refused. Reading
   `permissions.ts` showed a cashier holds `EDIT_CUSTOMERS` *because enrolling a customer is their
   job*, with an explicit note asking later guards to decide rather than inherit. So the bar was
   decided deliberately — cashiers mint, cashiers do not revoke or read — and the test now asserts
   that instead.
4. **A browser test raced the page.** The invitation page resolves its link in the browser, so it
   starts as a one-line loading state; a test that queried focusables immediately counted zero once
   the logo was added. It now waits for the resolved view, which is what it should always have done.

### What was NOT tested, and is not claimed

No staging deployment, no real iPhone, iPad, Apple Watch or Android device, no Apple Wallet, no
Google Wallet, no signed pass, no provider, no infrastructure, and no network beyond localhost. No
message was sent and no reward was granted, because no code exists here that could do either.

---

## 9. Screenshots inspected

Generated into `playwright-results/visual/`. Each was opened and read; this is exactly the list.

| file | what reading it confirmed |
|---|---|
| `desktop-en-share-invite.png` | "Invite your friends", the business name, a large QR of the page's own URL, Copy link, the URL as readable text, eight platform buttons, and "To get a card of your own, ask a member of staff". No native-share button, correctly, because desktop Chromium has none |
| `phone-ar-share-invite.png` | the same page in Arabic RTL on a phone: heading, subtitle and buttons right-aligned, the target grid starting from the right, and the URL left-to-right isolated inside it. The heading `ادعُ أصدقاءك` was cropped and enlarged to confirm the hamza renders correctly |
| `desktop-en-share-unavailable.png` | the generic notice — "This link is not available… Ask the business for a fresh link" — with no business name, no serial and nothing that confirms a card or a customer exists |
| `desktop-en-wallet-preview.png` | the owner's view: "Not signed…", a live-link badge, "The link itself is never shown here. It belongs to the customer, in their wallet", and both payloads with `<not-configured>` issuer ids and the scanner token in the barcode |

### What the screenshots found

- **The public page had no Zademi identity.** It is the one page a stranger reaches without having
  heard of the product, and a visitor deciding whether to trust a forwarded link deserves to know
  whose product it is. The approved white-on-dark wordmark now sits above the content, served from
  `public/brand/` exactly as supplied.
- **A screenshot named for the desktop was taken at phone width**, because that test never set the
  viewport. Fixed: evidence named for something it is not is worse than no evidence.

---

## 10. Manual device gate — required before any production claim

`docs/WALLET-CAPABILITY-MATRIX.md` §6 holds the full checklist. **None of it has been done.** Until a
person holding the devices ticks every line, this product must not claim that wallet passes work.

The three that matter most:

- [ ] a signed `.pkpass` installs, the back field is tappable, and Safari opens the invitation page;
- [ ] a Google object saves, its link opens a browser, and **the URL fragment survives the platform's
      handoff** — the claim the whole design rests on, and the one a platform could break silently;
- [ ] after the full walkthrough, no server log anywhere contains a capability.

---

## 11. Risks and open decisions

| # | what |
|---|---|
| **D15** (new) | Referral attribution and reward policy — who is credited, on what evidence, when, within what limits |
| **D16** (new) | Wallet device-token retention, needed before pass updates |
| **D17** (new) | Location relevance on a pass, and whether a lock-screen appearance is marketing |
| **D18** (new) | Wallet notifications, and the rule that an accepted API call is not a delivered notification |
| **D19** (new) | Whether a loyalty card is one person or one household (`multipleDevicesAndHoldersAllowedStatus`) |

**Risk: the business name is a real disclosure.** Small and intended — the share text needs it — but
it means a forwarded link tells its recipient which business the sender is a customer of. That is
inherent to inviting somebody, and it is the only thing the page reveals.

**Risk: a capability in a chat thread outlives the conversation.** A forwarded link keeps working
until it is revoked or replaced, and the product cannot see where it has been. That is why revocation
is a first-class owner action and why re-issuing a pass retires the previous link.

**Limitation: the feature is not reachable by a customer yet.** A capability is minted only by wallet
pass issuance, and nothing can sign a pass. The invitation page is complete and tested; the path that
puts a link into a customer's hands opens when the certificates do.

---

## 12. Correction after review — the shared URL carried a locale

A read-only review of `3aeb17a` found one correctness defect, and it was real.

### What was wrong

The canonical invitation URL is deliberately locale-neutral, and `publicShareUrl` on the server
emits it that way. But the public page is locale-routed: a visitor reaches it at `/en/share#…` or
`/ar/share#…`, and `ShareInvite.tsx` built everything it hands out — the visible link, the QR, the
clipboard, the native share sheet and all eight platform targets — from `window.location.href`.

So a link forwarded by an Arabic-speaking customer opened in Arabic for an English-speaking
recipient, and the other way round. A link sent into a chat outlives the moment it was sent and has
no business choosing a language for whoever opens it. The server was already right about this; the
browser was not agreeing with it.

### What changed

One function in one client component. The page now derives what it shares from the token it
resolved, rather than reading it back out of the address bar:

```
`${window.location.origin}/share#${token}`
```

Three properties, each deliberate:

- **the origin comes from the browser**, not from configuration — a visitor may legitimately be on a
  different host or port than the server's configured one, and the link has to work where they are;
- **the token stays in the fragment.** Nothing moved to a path or a query, and the capability is
  still never sent with a request;
- **the address bar is untouched.** The token is not stripped from the URL the visitor arrived on;
  the fix builds a *different* URL rather than rewriting the one they are looking at.

The page still renders in the locale it was opened in. A visitor reads their own language; what they
pass on picks nobody's.

### What did not change

No database schema, no migration, no public response contract, no permission, no wallet payload
placement, no B7 behaviour, no routing policy, no asset, no translation, and no dependency. Nothing
was added: no tracking, analytics, logging, rate limiting, provider, issuance route, signing or
deployment configuration. `public/` has zero changed files.

### Coverage, and proof that it catches the defect

`tests/e2e/share-invite-ui.spec.ts` gained a describe block that runs for **both locales** and
checks, for each:

- the page renders in that locale — `lang`, `dir`, and the translated heading;
- the browser's own address still carries the prefix *and* the capability, so the fix is not
  achieved by mutating the URL the visitor arrived on;
- and that all five surfaces carry the canonical URL with no prefix: the **visible copy**, the
  **QR**, the **clipboard**, the **native share** URL, and **every one of the eight social targets**;
- plus that the locale-prefixed address appears nowhere in the rendered page.

The QR is checked by regenerating the symbol from the canonical URL with `qrcode-generator` — the
dependency the component already uses — and comparing the module paths. Identical modules mean an
identical encoded payload, and a locale-prefixed URL is four characters longer and produces a
visibly different symbol. No decoder, and no new dependency.

Three pre-existing assertions were also tightened, because each was satisfiable by the defective
behaviour: the visible URL, the clipboard result and the native-share URL were checked with
`toContain("/share#…")`, which a locale-prefixed URL passes. They are exact comparisons now.

**The new tests were confirmed to fail before they were kept.** `canonicalShareUrl` was temporarily
reverted to `window.location.href`, both locale tests failed, and the fix was restored. A regression
test that has never been red is a test nobody has checked.

### Verification after the correction

| check | result |
|---|---|
| `node scripts/gate.mjs` | **PASS 15/15**, 469.1 s |
| `npx playwright test` (run 1) | **70 passed**, 2.4 m |
| `npx playwright test` (run 2) | **70 passed**, 2.1 m |
| `npx vitest run` | **81 files, 1046 tests, all passed**, 364 s |
| `npm audit` / `--omit=dev` | 0 vulnerabilities |
| `node scripts/db-migrate.mjs status` | 11 migrations, schema up to date (unchanged) |
| `prisma migrate diff` | only the two pre-existing `ConsentRecord` name differences |
| `git diff --check` | clean |
| secret scan | only the committed `.env.production.example` placeholders |
| raw-capability scan | no `/share#<token>` in any tracked file |
| `public/` | 0 changed files |

### Which SHA to deploy

**Replace `3aeb17a`.** It is not broken in a way that loses data or leaks anything — the capability,
the fragment design, the permissions and B7 are all unaffected — but every link shared from it
carries the sender's locale, and those links are forwarded into chats where they outlive any later
fix. Deploying `3aeb17a` first would mean links already in circulation that a correction cannot
reach.
