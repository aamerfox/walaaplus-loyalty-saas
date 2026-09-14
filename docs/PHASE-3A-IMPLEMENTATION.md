# Phase 3A — implementation notes

Phase 2 ended with campaigns that cannot be sent and consent that is honestly recorded. Phase 3A is
about the other direction: the customer's own card, in a wallet, with one link on it.

**Prompt 1 ships exactly two things**: a tappable web link on a wallet pass, and the public
invitation page it opens. It grants nothing, sends nothing, enrols nobody, and adds no provider.

The capability audit that gates it is `docs/WALLET-CAPABILITY-MATRIX.md`. It was written first and
then used to check the implementation; only two rows from it are turned on.

---

## 1. The capability, and why it is a fifth secret

A card already carries four opaque values: the scanner `qrToken`, the card-page `shareToken`, the
serial number, and its enrolment source token. The invitation link is a **fifth**, drawn
independently of all of them.

That separation is the whole design. Somebody who is forwarded an invitation link cannot open the
card it came from, cannot see a balance, cannot scan anything at a counter, and cannot find out whose
card it was. The alternative — reusing `shareToken`, which was right there — would have meant that
forwarding an invitation to a group chat forwarded somebody's loyalty card with it.

### Only a digest is stored

`sha256(raw)`, lower-case hex, unique. The raw value exists in the response that mints it and in the
wallet pass built from it, and nothing reads it back.

No salt and no keyed HMAC, deliberately:

- the input is 32 bytes of `crypto.randomBytes`, so there is no dictionary to precompute and a salt
  would protect against nothing;
- a keyed digest would need a secret, and this phase may not add one.

A copy of the database therefore yields nobody a working link, which is also what makes it safe to
keep revoked rows forever.

### The fragment is the point

The link is `https://<host>/share#<capability>`.

A URL fragment is **not sent with a request**. Not to this server, not through a proxy, not in a
`Referer` header to whatever the visitor opens next, and not into an error report. A path or query
token would be in all four.

The cost is that the page cannot be server-rendered: the server does not know which link was opened.
That is why `ShareInvite` is a client component and why the page starts in a loading state. Worth it.

The browser posts the token to `/api/share/resolve` **in a body**, which is the only point on the
server that ever sees one. `tests/e2e/share-invite-ui.spec.ts` records every request the browser
makes while opening the page and asserts the token is in none of their URLs — the one claim this
whole design exists to make, checked rather than reasoned about.

### Resolving records nothing

No audit row, no visit counter, no last-seen timestamp, no IP, no user agent, no rate-limit state.
Asserted, not trusted: the integration suite counts five tables before and after three resolutions
and compares the row itself.

**Not rate limited, deliberately.** A per-address limit would mean storing the address of everybody
who opens an invitation, which is exactly the tracking this page exists without. The token is 256
bits behind one indexed digest lookup; guessing is arithmetic, not a threat model.

### One shape for every failure

Unknown, revoked, malformed, absent, a card since deleted, a business gone inactive: `{ ok: false }`,
and the page renders the same generic notice. Telling "never existed" from "existed and was revoked"
is the only difference worth probing for, and a visitor has no use for it either way.

### Issue-once, revoke-once

`CardShareLink` is the first table in this codebase that is **not** strictly append-only, and it
needed a third privilege category to say so.

Revoking a capability *is* a state change, so the table cannot refuse UPDATE the way the ledger and
the consent history do. But an issued capability is a fact about what was handed out, and a
revocation that erased the row would leave nothing to audit. So:

| | permitted | refused |
|---|---|---|
| runtime role (`NO_DELETE_TABLES`) | SELECT, INSERT, UPDATE | DELETE, TRUNCATE |
| trigger, for anyone with more rights | `revokedAt`, NULL → a value, once | every other column, and un-revoking |

Two layers, same as everywhere else: the grant stops the app, the trigger stops anyone above it.
The narrow rule — that an UPDATE may touch only `revokedAt` — is a trigger's job because a grant
cannot express it.

Minting retires a card's live link and issues a new one in the same transaction. There is no
"regenerate in place": the raw value of the old link is unrecoverable by construction, so anything
handing out a new one must retire the old or a customer ends up with two live links.

### Permissions, decided rather than inherited

`src/server/tenant/permissions.ts` carries a note beside the cashier's `EDIT_CUSTOMERS` grant asking
every later guard on that bit to decide whether a cashier should have it. So:

| action | bar | why |
|---|---|---|
| mint | `EDIT_CUSTOMERS` — **a cashier may** | handing over a card and adding it to a wallet are the same moment at the counter |
| revoke | `EDIT_CUSTOMERS`, **not a cashier** | destroying something the customer already holds is not serving whoever is in front of you |
| read link status | `VIEW_CUSTOMERS`, **not a cashier** | reading a card's link history is reading the customer's record — the same bar as the consent history |

---

## 2. The invitation page

`/share`, one path for every business, with the capability in the fragment. Nothing about which card,
business or customer is in the path, so the address in a browser history, a screenshot or a chat
preview says only "somebody opened Zademi's invitation page".

**What it shows**: the Zademi mark, the business name, a QR of **the canonical invitation URL**, a
native share button where the device has one, a copy button, the link as selectable text, eight
platform links, and one line telling a newcomer that cards come from the counter.

**What it never shows**: a customer name, phone, card number, serial, balance, programme, card link,
or the scanner QR. The browser test reads the real values out of the database and asserts each is
absent from the rendered HTML.

### The share targets

Eight, all plain links a browser follows: WhatsApp, Telegram, Facebook, X, Reddit, Bluesky, Threads,
email. **None loads third-party JavaScript**, which is the difference between a share button and a
tracking surface, and the browser suite asserts every `<script src>` on the page is same-origin.

**Messenger is absent**, and that is the honest answer rather than an oversight: its web share dialog
requires a registered Facebook app id — an external account this phase may not add — and a bare
`fb-messenger://` deep link does nothing at all on a device without the app. The native share button
reaches Messenger on any phone where it is installed, which is the same outcome without the broken
button. Recorded in the capability map.

### Failure is not a failure state

`navigator.share` is detected rather than assumed, so the button is absent where it would do nothing
instead of being a dead control. A refused clipboard leaves the link on screen and selectable. A
platform link that a device cannot open still leaves the QR, the copy button and the other seven.

### It promises nothing

There is no referral reward policy (**D15**), so no string on this page or on a wallet pass may imply
that sharing earns anybody anything. `tests/unit/share-capability.test.ts` walks every message in
both locales against a list of reward words, and the browser suite checks the rendered page in both
languages. A wallet pass is the one surface a customer cannot re-read a correction on.

### What is shared is locale-neutral — a correction

The page is locale-routed: a visitor reaches it at `/en/share#…` or `/ar/share#…`. The first
implementation built everything it hands out — the visible link, the QR, the clipboard, the native
share sheet and all eight platform targets — from `window.location.href`.

That was wrong, and a read-only review caught it. It meant a link sent by an Arabic-speaking customer
opened in Arabic for an English-speaking recipient, and the other way round. A link forwarded from a
chat outlives the moment it was sent and has no business choosing a language for whoever opens it —
which is exactly why `publicShareUrl` on the server emits no prefix, and the browser simply was not
agreeing with it.

The page now derives what it shares from the token it resolved:

```
`${window.location.origin}/share#${token}`
```

Three properties of that, each deliberate:

- **the origin comes from the browser**, not from configuration, because a visitor may legitimately
  be on a different host or port than the server's configured one and the link has to work where
  they actually are;
- **the token stays in the fragment.** Nothing moved to a path or a query, and the capability is
  still never sent with a request;
- **the address bar is left alone.** The token is not stripped from the URL the visitor arrived on.
  The fix builds a *different* URL; it does not rewrite the one they are looking at.

The page itself still renders in the locale it was opened in. A visitor reads their own language;
what they pass on picks nobody's.

`tests/e2e/share-invite-ui.spec.ts` covers both locales and checks all five surfaces, including the
QR — decoded by regenerating the symbol from the canonical URL with `qrcode-generator` and comparing
the module paths, because the QR is the one artefact a recipient cannot read before acting on it, and
because that needs no decoder and no new dependency. The test was confirmed to fail against the old
`window.location.href` behaviour before the fix was kept.

---

## 3. Wallet passes

Payload builders only. Apple needs a Pass Type ID certificate and Google a service-account key;
neither can be added here, so nothing is signed and nothing is delivered.

Writing them now is still worth it, because **the shape of the link is the security-relevant part**,
and it is far cheaper to get wrong in a fixture than in something a customer has already saved.

| | Apple | Google |
|---|---|---|
| the link | a back field with `dataDetectorTypes: ["PKDataDetectorTypeLink"]` | `linksModuleData.uris[]` |
| the barcode | the card's scanner `qrToken`, unchanged | the same, unchanged |
| the front | **never** — front fields print on a lock screen | **never** — text modules render in the body |

Apple renders **no button on the front of a pass**. That is written down in the matrix and in the
code because it is the most likely thing for a roadmap to promise by analogy with Google's link
module.

### Two functions, and the difference is the point

`issueWalletPassPayloads` **mints**: a fresh capability, the previous one retired, and payloads
carrying the live URL. It is what a future signing step calls, and it is **not exposed on any route**
— there is no signing, so there is nothing legitimate to do with an unsigned payload carrying a live
token, and a route returning one would be a token-disclosure surface built for no consumer.

`previewWalletPass` **does not mint**. A preview that minted would retire the link already sitting in
the customer's wallet every time a member of staff opened their card. It reports whether a live link
exists and shows both payloads with the token replaced by a placeholder.

Redaction runs over the **whole serialised payload** rather than a known field, so a field added
later that happens to carry the URL is redacted too rather than being the one somebody forgot.

### The honest caveat

**A pass already saved in a customer's wallet does not gain the link on its own.** There is no update
channel: Apple's needs `webServiceURL` and APNs, Google's needs the API. The link appears when the
pass is issued again and saved again, and the owner UI says exactly that. Claiming otherwise would be
a promise a customer discovers is false.

---

## 4. What the screenshots found

**The public page had no Zademi identity.** It rendered a heading, a QR and eight buttons on a black
background — correct, and anonymous. It is the one page in the product a stranger reaches without
ever having heard of Zademi, and a visitor deciding whether to trust a forwarded link deserves to
know whose product it is. The approved white-on-dark wordmark now sits above the content, served from
`public/brand/` exactly as supplied.

**A screenshot named for the desktop was taken on a phone.** The unavailable-link test never set the
viewport, so `desktop-en-share-unavailable.png` was 1082 px wide. Fixed, because evidence named for
something it is not is worse than no evidence.

---

## 5. Two guards this prompt had to widen, with reasons

Both are existing tests that fired correctly and needed an argued exception rather than a shrug:

- **`brand-scan`** forbids a brand hex outside the token file. The share page sets
  `viewport.themeColor`, which is a value handed to browser chrome and cannot read a CSS variable —
  the same legitimate exception the card page and its manifest already have. The comment now names
  all three.
- **`message-parity`** flags a string identical in both locales as a probable untranslated copy.
  `Wallet.applePass` and `Wallet.googlePass` name a file format and an API object rather than saying
  anything, so they are listed alongside the product name and the phone placeholders.

---

# Prompt 2 — recording that somebody arrived with an invitation

Prompt 1 built a link a customer can share and made sure nothing could be learned from it. Prompt 2
adds the only thing that can honestly be done with one next: **record that a customer presented it**.

It records. It does not reward, promise, calculate, send or schedule, and the schema cannot be read
as though it did.

---

## 6. An attribution is not a reward, and the schema says so

`ReferralAttribution` holds one fact: this newly issued card was enrolled at a counter where a member
of staff saw a valid invitation from that link.

What it deliberately has no column for: an amount, a currency, points, stamps, a reward reference, an
eligibility flag, an expiry, a campaign, or a conversion. Each would be a policy nobody decided,
written into a schema — and **D15** owns that policy. `tests/integration/share-links.test.ts` walks
the table's columns and fails on any name that looks like money.

Nothing in the module touches a balance, a ledger row or a campaign. The integration suite records an
attribution and then asserts every one of the referrer's five balances is exactly where it was.

### Internal ids only

The referring side is a `CardShareLink` id and the card behind it. No name, phone, serial, balance,
URL or capability is copied. The card id is denormalised from the link on purpose: a later revocation
must not change what the row says happened.

### Append-only, with voiding as a second row

The same shape `CampaignApproval` uses. An `ATTRIBUTED` row is never modified; voiding writes a
`VOIDED` row pointing at it, and the effective status is derived from the pair.

That differs from `CardShareLink`, which permits one narrow UPDATE — and the difference is the point.
Revoking a capability has to change the thing that is looked up. Voiding an attribution changes only
what a reader concludes, so nothing needs to be mutable.

---

## 7. The capability is seen once and discarded

It reaches the server in exactly one place: the body of `POST /api/scanner/enroll`, behind a
verified staff session. The scanner strips everything before the `#` **on the device**, so a
capability never enters a path, a query string, an access log, a proxy log or a `Referer` header —
the same property the public page relies on, held on the one authenticated route allowed to see one.

Then it is hashed, looked up, and the **row id** is kept. The raw value is not stored, not returned,
not logged, and not written to an audit row. Neither is its digest: a digest in an audit log is still
a way to confirm a guess.

A source-level test asserts that exactly two route files in the whole application mention a share
token at all — the public resolver, which writes nothing, and the counter enrolment. A third would be
a new way for a capability to reach the server, and the phase that adds one has to come and say so.

### One generic refusal

Invalid, revoked, malformed, another business's, the customer's own, and a card that already carries
an attribution all answer `NOT_ACCEPTED`. A member of staff who could tell "revoked" from "never
existed" would be holding a probe, and the referring customer is never named, shown or implied.

An unusable invitation never turns a successful enrolment into an error. The customer is standing at
the till and has their card; the invitation is a second sentence in the feedback, not a failure. That
is also why the route's schema bounds the field but does not shape-check it — a malformed value must
not produce a 400 for the enrolment.

---

## 8. Integrity rules, and the ones deliberately not invented

**One attribution per card, ever**, by a partial unique index on `ATTRIBUTED` rows. Voiding does
**not** free the slot: the withdrawn row is still there, and re-attributing afterwards would be
retrospective attribution.

**Only a card this call issued.** A customer who already had a card was not referred by anybody
today, so a repeat lookup records nothing.

**Self-referral is refused where identity already held makes it safe to determine** — the same
profile in this business, or the same underlying customer. Nothing beyond that is guessed. Household
matching would wrongly refuse two flatmates sharing an address, name similarity would refuse two
brothers, and shared-device detection would refuse a phone handed across a counter. **D19** asks
whether a card is a person or a household, and it is not answered by an implementation here.

**Not invented at all**: reward eligibility, expiry, monetary value, campaign attribution, and
retrospective attribution. None has a column, a code path or a placeholder.

---

## 9. Who may do what

| action | bar | why |
|---|---|---|
| record an attribution | `EDIT_CUSTOMERS` — **a cashier may** | it happens at a till, in the same request that issues the card, and enrolling a customer is already a cashier's job |
| read a card's attribution | `VIEW_CUSTOMERS`, **not a cashier** | reading a customer's record is not serving them — the same bar as the consent history |
| void one | `EDIT_CUSTOMERS` **and owner or manager** | deciding that a record of what happened was wrong is a correction to the business's own history, not counter work |

Every read and write resolves through the caller's own `businessId` in the `WHERE`, so a cross-tenant
id answers 404 rather than 403.

---

## 10. What an owner may see

A card's own record says the customer arrived with an invitation, when, how, and which member of
staff recorded it. It says **nothing about the referring side** — not a name, a card, a link id or a
count — because that is somebody else's record and this screen is not an introduction service.

The business-wide figure is a **count**. There is deliberately no function anywhere that lists
attributions, ranks referrers or counts them per customer; a test asserts that nothing exported from
the module is named like a listing. That report is a list of customers ordered by how many friends
they brought, which belongs to a reward programme that does not exist.

Both screens state, every time, that nothing is awarded for it. A merchant looking at a record like
this would otherwise reasonably assume it must be worth something.

---

## 10a. The database checks what each row means, not only that it cannot be edited

A read-only review found the gap, and it was a real one. `ReferralAttribution` was append-only from
the start, and append-only protects history from being **rewritten**. It does nothing about a row
that was wrong the moment it was written.

Foreign keys check that each id **exists**. Nothing in a foreign key checks that they **agree** — so
a row naming this business, a share link from another one, a card belonging to a third and a profile
belonging to nobody in particular satisfied every constraint on the table. So did a void pointing at
another void, and an attribution carrying a withdrawal reason for a withdrawal that never happened.

The service declines to build any of those, and that is exactly why it was not enough: **a guarantee
that lives in one service ends the first time somebody writes a second one**, a backfill script, or a
console session.

`referral_attribution_validate` now runs `BEFORE INSERT` and refuses a row whose parts contradict
each other:

| rule | what it stops |
|---|---|
| the share link belongs to this business **and** to the stated referring card | an attribution pointing at a customer the invitation did not come from |
| the referring card belongs to this business | a cross-tenant referrer |
| the enrolled card belongs to this business **and** to the stated profile | an attribution recorded against the wrong person |
| the enrolled profile belongs to this business | a cross-tenant enrolment |
| the referring card is not the enrolled card | a card referring itself |
| the referring card's profile is not the enrolled profile | **a customer referring themselves with a second card** |
| an `ATTRIBUTED` row voids nothing and carries no reason | a record of an arrival dressed as a withdrawal |
| a `VOIDED` row names one existing `ATTRIBUTED` row, in the same business | withdrawing another business's record, or a void of a void |
| a `VOIDED` row repeats the link, card, profile and method **exactly** | a decision history that says two different things about one event |

The last of those is the one worth its own paragraph. The same card on both sides is the obvious
case; a **different** card belonging to the same profile is one person holding two of the business's
programmes, and it satisfies every other rule in the trigger — both cards are this business's, the
link belongs to the card it names, the enrolled card belongs to the profile it names. Only the profile
comparison catches it, and scanning your own second card is a good deal easier than editing a row.

It is checked against the **profile** rather than the underlying customer deliberately.
`CustomerBusinessProfile` is unique on `(businessId, customerId)`, and the rules above already
establish that both cards belong to this business — so within one business "same profile" and "same
customer" are the same statement, and the profile is the one the row already carries. The service's
own check reads both, and the two agree for that reason rather than by coincidence.

Nothing further is inferred. A shared household, a shared surname or a shared device is not
self-referral in this schema, and **D19** is not a trigger's to answer.

`BEFORE INSERT` only, and that is sufficient rather than a shortcut: `UPDATE` and `DELETE` are
already refused outright, so an inserted row is the only row there will ever be, and validating it
once validates it forever.

Each failure raises `check_violation` with a message naming the rule. A constraint that fires with
"new row violates constraint" tells whoever hits it nothing about what they got wrong.

### Proven against the database, not the service

`tests/integration/referral-integrity.test.ts` inserts every invalid shape through `prisma` — the
**restricted runtime client**, with no service in the way — exactly as a second service would. It
also inserts the two valid shapes, so the rules are known to refuse the wrong rows without refusing
the right ones.

The suite was confirmed to depend on the trigger, twice over. Dropping
`referral_attribution_validate` entirely and re-running turns **13 of its 23 tests red**; the ten that
stay green are the positive controls, the case a foreign key already covered, the
one-void-per-attribution index, the append-only privilege checks and the service-level refusal — none
of which the trigger is responsible for. Reinstating the function with **only the two self-referral
rules removed** turns exactly the two self-referral tests red and leaves their control green. A test
that has never been red is a test nobody has checked.

Nothing else moved. The migration was amended rather than followed by a second one — twice, for the
consistency rules and then for self-referral — because it had not reached staging; the count stays at
**12**. No column, permission, route, screen, string or asset
changed, and the runtime role still holds `SELECT` and `INSERT` and nothing else.

---

## 11. What the screenshot found

The aggregate notice rendered its heading and its sentence as one run-on line — *"Referral records 1
customer has been recorded as arriving with an invitation."* The heading is now its own block. Small,
and the kind of thing only reading the rendered page catches.
