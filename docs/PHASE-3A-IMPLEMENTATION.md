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

---

# Prompt 3 — an offer a cashier records, and a person hands over

Prompts 1 and 2 built a link and the record that somebody arrived with one. Prompt 3 builds the
other counter action a merchant actually asks for: **a coupon**.

A merchant writes an offer and a code. A customer says the code. A cashier types it in. The screen
says the offer was recorded for manual fulfilment, and a person hands it over.

The capability audit that gates it is `docs/PROMOTIONS-CAPABILITY-MATRIX.md`. It was written before
any of this existed and then used to constrain it: §3 is the reason no discount is calculated, §5 is
the reason a cashier cannot create a promotion, and §7 is the list of things nobody has to ask about.

---

## 12. The defining exclusion: a redemption is a record, not an effect

A `PromotionRedemption` row carries a business, a promotion, a card, a profile, an actor, a moment
and an entry kind. It carries **no amount, percentage, currency, tax, invoice, total, points, stamps
or balance**, and the column-name check in `tests/integration/promotion-integrity.test.ts` fails if
one ever appears.

`src/server/promotions/redemption.ts` imports the tenant context, the digest helpers, the audit
writer and Prisma. It imports no ledger verb, no points engine, no stamp engine, no campaign module,
no consent module, no wallet module and no referral module, and it cannot reach any of them. That is
not a convention; it is the whole safety argument, and it is checked by reading the imports.

The reason to be this strict is that a discount is where a loyalty tool quietly becomes half a
point-of-sale system. Percentages, rounding, tax, currency, refunds, partial redemptions and the
merchant's actual till are all one "just apply 10%" away, and none of them would have been reviewed.
So the product stops at the honest sentence: **this customer is owed the thing the offer describes**.

The cashier's success message is deliberately unambiguous about that:

> Recorded for manual fulfilment: A free espresso. Hand it over now. Nothing was discounted or
> charged. Give the customer what the offer says.

---

## 13. A code is a secret with almost no entropy, and the storage reflects it

`CardShareLink` stores a plain SHA-256 of 32 random bytes, and that is correct there: a 256-bit
random value has no dictionary to be found in.

A coupon code is the opposite. It is four to sixty-four characters, chosen by a human, meant to be
printed on a poster and spoken across a counter. `AUTUMN`, `FREE10`, `EID2026`. An unsalted digest
column of values like those is a rainbow table away from being a plaintext column.

So a promotion carries its own 32-byte salt, and stores

```
sha256(codeSalt ‖ businessId ‖ normalizeCode(code))
```

with NUL separators so ("AB", "C") and ("A", "BC") cannot collide, and `businessId` bound in so the
same code in two tenants is two different digests.

**The salt costs something, and the cost is paid rather than hidden.** With a per-promotion salt the
`@@unique([businessId, codeDigest])` index can no longer see that two promotions share a code — two
salts, two digests. So `createPromotion` compares the candidate against every existing promotion's
salt, including expired ones, before inserting. That is a loop bounded by
`MAX_PROMOTIONS_PER_BUSINESS = 200`, and the bound exists for this reason as much as any other.

Redemption pays the same cost in the same way: it walks the business's ACTIVE promotions, computing
one digest per salt, and compares with `timingSafeEqual`. Two hundred SHA-256 operations is nothing;
a keyed HMAC with a single application secret would avoid the loop entirely, and is the right answer
the day this product has a secret to key it with. `docs/PROMOTIONS-CAPABILITY-MATRIX.md` §2 says so
plainly rather than presenting the salt as the finished design.

The raw code exists in the body of one authenticated request and nowhere else. Not in a column, not
in a URL, path or query string, not in a log, not in an audit row, not in a response, not in a
rendered page. The audit rows carry two row ids and nothing more.

### Normalisation, and why it is not politeness

`normalizeCode` strips everything that is not a letter or a digit and upper-cases the rest. A
customer reading a code aloud and a cashier typing it will not agree about spaces, hyphens or case,
and a coupon that fails because somebody typed `free-10` instead of `FREE10` is a coupon that
generates a complaint rather than a sale. The same function runs at create time and at redeem time,
so the two can never disagree.

---

## 14. One refusal, for everything

`redeemCoupon` returns exactly two shapes:

```ts
| { outcome: "RECORDED"; redemptionId; promotionName; benefitDescription }
| { outcome: "NOT_ACCEPTED" }
```

`NOT_ACCEPTED` is returned for: a malformed code, a code no promotion has, a draft, a paused
promotion, an expired one, one that has not started, one past its end, one whose global limit is
used up, one this customer has already used to their limit, another tenant's promotion, a card that
is not this business's — and from a catch-all, for anything not foreseen.

The reason is the entropy again. A refusal that distinguished "no such code" from "that code is
exhausted" is an oracle, and against a six-character code an oracle is most of the attack. Since the
route is authenticated and rate-limited, the practical threat is a till left running a script rather
than the open internet — which is exactly why `enforceStaffLimit(ctx, "write")` is applied here and
noted in the code as mattering more here than elsewhere.

**A bad coupon never fails the workflow it was typed into.** The coupon field on the scanner is its
own action against a card that has already been found. Typing nonsense into it produces a refusal
message and leaves the card, the stamp buttons and the reward button exactly where they were.

---

## 15. The lifecycle, and the two places it is enforced

```
DRAFT ──▶ ACTIVE ◀──▶ PAUSED
  │         │            │
  └─────────┴────────────┴──▶ EXPIRED   (terminal)
```

`TRANSITIONS` in `src/server/promotions/promotions.ts` and the `CASE` in `promotion_guard` are the
same table written twice, on purpose: the service gives a merchant a useful message, and the trigger
means a second service written later cannot skip it.

The trigger also forces `DRAFT` on every insert regardless of what the caller supplied. A promotion
that could be created already active is a promotion that can be created and used before anybody has
read it back.

`EXPIRED` is terminal and an expired promotion cannot be edited at all — not its name, not its
window, not its limits. Editing the terms of an offer that customers have already redeemed against
would rewrite what those redemptions meant.

The `Expire` button asks twice for this reason. It is the one lifecycle action with no way back.

---

## 16. Limits, concurrency, and the backstop

Two limits, both optional, both greater than zero by CHECK constraint: a global total and a
per-customer total.

The redemption transaction:

1. `SELECT id FROM "Promotion" WHERE id = $1 FOR UPDATE` — a lock on the one row every concurrent
   redemption of this promotion must pass through.
2. Re-read the promotion **inside** the lock. The state or the window may have changed between the
   candidate search and here.
3. Count standing redemptions — `entry: REDEEMED` with `voidedBy: { none: {} }` — globally and for
   this profile.
4. Insert.

Step 3 counts *standing* rows because a void here means "that did not happen", so a voided
redemption frees the slot. That is the deliberate opposite of `ReferralAttribution`, where voiding
does not free the card to be attributed again. Two tables, two meanings, and the reason is written in
both migrations rather than left for a reader to infer.

Then `promotion_redemption_validate` recounts the same thing from the table on `BEFORE INSERT`. That
is not belt-and-braces for its own sake: the lock lives in one function, and the guarantee should not
depend on every future caller remembering to take it.

---

## 17. What the database refuses, with no service in the way

`promotion_guard` (BEFORE INSERT OR UPDATE on `Promotion`)

- forces `DRAFT` on insert
- freezes `id`, `businessId`, `codeDigest`, `codeSalt`, `createdByUserId`, `createdAt`
- allows only the transitions above
- refuses any change at all to an `EXPIRED` promotion

`promotion_redemption_validate` (BEFORE INSERT on `PromotionRedemption`)

- the business, the promotion, the card and the profile must all be the same tenant's, and the card
  must be the profile's
- the promotion must be `ACTIVE`
- `now()` must be inside the window
- the global and per-customer limits must still hold, counted from the table
- a `REDEEMED` row may not name a row it voids
- a `VOIDED` row must name a `REDEEMED` row, and must be a faithful copy of it — same business,
  promotion, card and profile — so a void cannot quietly reassign what it withdraws

Constraints and indexes carry the rest: positive limits, `startsAt < endsAt`, one name per business,
one digest per business, and a partial unique index giving each redemption at most one void.

Every failure raises `check_violation` with a message naming the rule, because "new row violates
constraint" tells whoever hits it nothing.

### Proven against the database, not the service

`tests/integration/promotion-integrity.test.ts` inserts every invalid shape through `prisma` — the
**restricted runtime client**, with no service in the way — exactly as a second service would, and
inserts the valid shapes too, so the rules are known to refuse the wrong rows without refusing the
right ones.

The suite was confirmed to depend on what it claims. Dropping both
`promotion_redemption_validate` and `promotion_guard` and re-running turns **20 of its 27 tests
red**; the seven that stay green are the positive controls, the cases a foreign key or a unique index
already covered, and the privilege-level append-only checks — none of which a trigger is responsible
for. Both were then restored by rolling the migration back locally and reapplying it, and
`db-roles.mjs` was re-run. A test that has never been red is a test nobody has checked.

---

## 18. Who may do what

| | Cashier | Manager | Owner |
|---|---|---|---|
| Redeem a coupon at the till | ✅ `MAKE_REDEMPTIONS` | ✅ | ✅ |
| See a card's recorded offers | ❌ | ✅ `VIEW_CUSTOMERS` | ✅ |
| Create, edit, activate, pause, expire | ❌ | ✅ `EDIT_TEMPLATES` | ✅ |
| Void a redemption | ❌ | ✅ | ✅ |
| Read a code back | ❌ | ❌ | ❌ |

A cashier holds `EDIT_CUSTOMERS` — enrolling people is their job — so permission alone is not the
bar for managing promotions. `requirePromotionManager` requires `EDIT_TEMPLATES` **and** a role of
`OWNER` or `MANAGER`, and the reasoning is in the code beside it.

`/business/promotions` returns **404** for a cashier rather than an empty screen, and the sidebar
does not offer it. Being told there is a page you may not see is itself information.

The last row is the one worth stating: nobody reads a code back, including the owner who wrote it.
There is no reveal route and no selection that reads `codeDigest` or `codeSalt` out to a caller. An
owner who has forgotten their own code edits the promotion to set a new one.

---

## 19. What a void is

Owner or manager only. The `REDEEMED` row stays exactly as it was; a `VOIDED` row is written beside
it naming it, with an optional reason. The panel shows both, and the customer's entitlement comes
back.

That last part is a product decision with a sharp edge, recorded as **D25**: voiding is right when a
cashier mistyped, and wrong when a cashier voids after handing over a free coffee. The product cannot
tell those apart and does not guess.

---

## 20. What the screenshots found

Five were taken and read.

`desktop-en-promotions.png` came back showing the middle of the create form and nothing else — the
promotion that had just been created, its state badge and the "nothing is calculated" notice were all
above the top of the image. The dashboard shell scrolls `main`, not the document, so `fullPage` on a
shell like this captures the document's idea of the page, which is a viewport that never moved. A
`shot()` helper now rewinds `main` to the top before every capture. The screenshot is the only reason
this was noticed, which is the argument for reading them.

`phone-ar-promotions.png` and `phone-ar-coupon-till.png` confirm Arabic is usable at phone width:
headings, the disclaimer, the empty state, the field labels and the till's coupon box all read right
to left, with the hamburger and the locale switch on the left where they belong. The Latin phone
number and the ISO dates stay left-to-right inside the Arabic run via `<bdi>`.

`phone-en-coupon-till.png` shows the sentence a cashier actually has to act on, above the fold and in
the same green as every other success on that screen.

`desktop-en-customer-redemptions.png` shows the offers panel on the customer record with its own
"nothing here was discounted, charged or paid" line — a second place the claim is denied, because the
customer record is where somebody would go looking for a balance.

---

## 21. Four things found in review, before any of this was deployed

The promotions work was reviewed as a whole before it left this machine. Four defects came out of
it. The migration had not reached staging, so it was **amended** rather than followed by a second
one; the count stays at 13.

### 21.1 A file review could not read

`src/server/promotions/codes.ts` and `tests/unit/promotion-codes.test.ts` each held two physical
U+0000 bytes, used as separators in the digest input.

The separator is right. `sha256(salt ‖ businessId ‖ code)` without one lets salt `"ab"` with code
`"cd"` hash identically to salt `"a"` with code `"bcd"`, and a NUL is the conventional way to stop
it. Writing it as a **literal byte in the source** was the mistake: one NUL makes Git classify a
file as binary, and from then on it does not appear in `git diff`, `git log -p` or `git blame`,
`git grep` skips it, and a pull request renders it as *"Binary files differ"*.

So of every file in this feature, the one that could not be read during review was the one deciding
how coupon codes are hashed. That is not a cosmetic problem; it is a review that silently did not
happen.

Both now use the TypeScript escape `\0`, which compiles to exactly the same byte. To keep the
encoding change from becoming a behaviour change, the digest of a fixed input is hard-coded in the
test as the value computed before the rewrite, and a companion assertion proves the escape really is
one NUL rather than the two-character text.

`tests/unit/source-text-encoding.test.ts` walks `git ls-files` and fails on a physical NUL in any
reviewed extension, and asks Git itself — via `git diff --numstat`, which prints line counts for text
and a pair of dashes for binary — whether these two files can be diffed.

### 21.2 A duplicate code that two people could create at once

`createPromotion` read every existing salt, hashed the candidate against each, decided there was no
duplicate, and only then opened its transaction. Two managers submitting the same code at the same
moment both read "no duplicate" and both inserted.

**The unique index cannot catch that.** `(businessId, codeDigest)` sees two unrelated rows, because
each attempt minted its own 32-byte salt and the same code hashed differently under each. That is
the direct cost of salting, spelled out in §13 — and the check that pays it was not atomic.

The consequence is a coupon that works or does not depending on which candidate redemption reaches
first, which is the kind of bug a customer reports and nobody can reproduce.

Creation now takes `pg_advisory_xact_lock` as the first statement inside its transaction, and the
read, the duplicate check, the cap check and the insert all happen behind it. The lock releases on
commit or rollback, so no path leaks it.

**The key names the business, not the code.** Locking per code would put a number derived from a
short human-chosen secret into `pg_locks`, where it is readable for as long as the lock is held, and
into any statement log. Sixty-four bits of a hash over a six-character code is not a secret. Locking
per business gives up nothing worth having: creating a promotion is a manager pressing a button a
handful of times a year, so the contention is not measurable, and the serialisation is strictly
wider than the one required. The key is never stored in any column.

### 21.3 An event time the writer could choose

`recordedAt` is what every window check reads — *"was this promotion running when this happened?"* —
and it was supplied by the caller. A direct writer could date a row into a promotion that had already
ended, or into one that had not started, and the trigger would agree with them.

`walaaplus_validate_redemption` now assigns it from the server's clock before anything compares it:

```sql
NEW."recordedAt" := (now() AT TIME ZONE 'UTC');
```

`now()` is the transaction's start time, so a redemption and the audit row written beside it agree.
`AT TIME ZONE 'UTC'` is explicit because the column is a bare `TIMESTAMP(3)` holding UTC; an
implicit cast would be right only while the session's `TimeZone` happened to be UTC.

It is deliberately not conditional on the entry kind. A backdated `VOIDED` row is a falsified
withdrawal, which is the same problem wearing the other hat.

The service no longer passes a timestamp at all. It still checks the window itself, so a cashier gets
a refusal rather than a database error — but that is a message, not the rule.

This closes the door on imported and backdated redemptions for this phase. If a merchant ever needs
to import history, that is a decision with a policy attached, not a column somebody may set.

### 21.4 A canonical name that could drift from the name

`normalizedName` is what `(businessId, normalizedName)` is unique on, and what the merchant's own
list is ordered and de-duplicated by. `promotion_guard` froze the identity of a promotion and the
lifecycle it could walk, but left `normalizedName` free — so a direct writer could set it to anything,
including on an expired row, and hide a duplicate from the very index that depends on it.

The trigger now computes it from the name and **assigns** it, on every insert and every update.

Assigning rather than comparing is the deliberate choice, and the reason is measured rather than
assumed. PostgreSQL and JavaScript do not agree about what needs normalising:

| input | JavaScript | PostgreSQL |
|---|---|---|
| `\s` matching U+00A0 | matches | does **not** match |
| `lower("İ")` | `i` + combining dot | `i` |

A merchant pasting a name out of a word processor brings U+00A0 with it every time. A comparison
would refuse that name with a database error; an assignment cannot, and a supplied value is never
consulted, so it cannot be set independently either. The rule is stronger and the failure mode is
gone.

An **expired** promotion still refuses the edit out loud rather than silently correcting it: the
arriving value is checked against the old one *before* the assignment, so an attempt to rewrite a
finished promotion's canonical name raises `check_violation` like every other edit to one.

`normalizePromotionName` in the service is now advisory, and says so. It was also changed from
`toLocaleLowerCase` to `toLowerCase`, so a server running under a Turkish locale cannot quietly
produce a different answer from the database, and its whitespace class was written out to match
PostgreSQL's rather than relying on JavaScript's wider one.

### 21.5 Every new test was watched fail

| protection removed | tests that went red |
|---|---|
| the escape, replaced by a literal NUL | **3 of 3** in `source-text-encoding` |
| `NEW."recordedAt" := now()` | **4 of 5**; the fifth is the control, a valid redemption inside a real window |
| the canonical-name assignment and its expired check | **5 of 5** |
| the advisory lock | the deterministic lock-contention test |

Each rule was then restored and the suite re-run green.

The six-way concurrent-create test is the one honest exception, and it is labelled as such in the
file: it **passed with the lock removed**, because Prisma's transactions did not interleave far
enough to reproduce the race on this machine. A race that only sometimes reproduces is a test that
only sometimes checks anything, so the proof of the mechanism is a second test that takes the very
lock `createPromotion` takes, holds it, and asserts the create does not complete until it is
released. The six-way test is kept because the invariant it states — one code, one promotion,
whatever arrives — is what a merchant actually cares about, and it would catch a regression that
broke it by any route.
