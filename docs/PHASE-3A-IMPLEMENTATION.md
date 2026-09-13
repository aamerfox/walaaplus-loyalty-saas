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

**What it shows**: the Zademi mark, the business name, a QR of **its own URL**, a native share button
where the device has one, a copy button, the link as selectable text, eight platform links, and one
line telling a newcomer that cards come from the counter.

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
