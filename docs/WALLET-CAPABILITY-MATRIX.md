# Apple Wallet and Google Wallet — capability audit

What each platform offers a loyalty product, what Zademi could use, and what it is deliberately not
using yet. Written before the Phase 3A Prompt 1 implementation was finished and used to check it:
the only capability this phase turns on is **a web link on the pass that opens the invitation page**,
and everything below either supports that decision or explains why something else is not in it.

**Nothing in this document is a claim that a capability works.** Nothing here has been run against a
real iPhone, Apple Watch, Android device, Apple Wallet or Google Wallet. Every "Supported now" row
means *buildable and testable locally as a payload*, and every production claim is gated on §6.

Four buckets, used consistently:

| bucket | means |
|---|---|
| **Supported now** | can be built and tested locally, with no credential, no external account and no device |
| **Needs provider setup** | requires an Apple certificate / APNs, or a Google issuer account / service account, or platform approval |
| **Needs business decision** | requires a commercial policy, a customer consent basis, or a retention rule that nobody has decided |
| **Not appropriate / deferred** | ruled out for now by B7, by privacy, or by the absence of supporting hardware |

---

## 1. Apple Wallet

### 1.1 Pass type, layout and presentation

| capability | bucket | notes |
|---|---|---|
| `storeCard` as the pass style | **Supported now** | The correct style for a stamp/points loyalty card: a prominent balance, a barcode, and a back. `coupon` expires by nature and `generic` has no balance affordance. Implemented in `buildApplePassJson`. |
| Front fields (header / primary / secondary) | **Supported now** | Balance, rewards ready, reward name. **No capability, URL or token may ever go here** — the front is what iOS renders on a lock screen, readable over a shoulder. Asserted in `tests/unit/wallet-pass-payloads.test.ts`. |
| Back fields | **Supported now** | Programme, serial, and the invitation link. The back is the only place Wallet detects a URL and the only place a capability belongs. |
| Colours (`backgroundColor`, `foregroundColor`, `labelColor`) | **Supported now** | Zademi navy / white / turquoise, matching the product. Contrast checked against the same bar as the web UI. |
| Localisation (`pass.strings` per `.lproj`) | **Needs provider setup** | Real localisation ships inside the signed `.pkpass` bundle, which cannot be produced without a certificate. Today the payload is built **per locale** at generation time, which produces a correct single-language pass and is the honest interim. Rebuilding as a localised bundle is a task for the signing phase. |
| Images (`icon`, `logo`, `strip`, `thumbnail`, `background`) at @1x/@2x/@3x | **Needs provider setup** | Also bundle contents. The official Zademi assets exist in `public/brand/` and are untouched by this phase; packaging them is part of signing. |
| Accessibility | **Supported now, partly** | Field labels are real labels, and `altText` on the barcode is the serial. What cannot be verified locally is VoiceOver's actual reading order on a device — §6. |

### 1.2 Links

| capability | bucket | notes |
|---|---|---|
| A tappable URL in a back field | **Supported now — and this is what this phase ships** | Wallet's data detectors linkify a URL in a back field value. `dataDetectorTypes: ["PKDataDetectorTypeLink"]` says link detection and nothing else, so a field does not also linkify phone numbers and addresses. Opens Safari. |
| A "button" on the front of the pass | **Not appropriate** | **Apple renders no such control.** A product claiming one would be describing an interface the platform does not have. This is written down because it is the most likely thing for a roadmap to promise by analogy with Google's link module. |
| Universal Links (`associatedStoreIdentifiers`, `appLaunchURL`) | **Not appropriate / deferred** | Both require a native iOS app, and Zademi has none. A Universal Link also needs an `apple-app-site-association` file served from the domain, which is infrastructure this phase may not touch. Revisit only if a native app is ever built. |
| `webServiceURL` + `authenticationToken` | **Needs provider setup** | See §1.4. |

### 1.3 Barcodes

| capability | bucket | notes |
|---|---|---|
| `PKBarcodeFormatQR` | **Supported now — in use** | Carries the card's scanner `qrToken` and nothing else. Unchanged by this phase. |
| `PKBarcodeFormatPDF417` | **Not appropriate** | A dense 2D format for high-capacity IDs and boarding passes. A loyalty token is short; PDF417 buys nothing and scans worse on a phone screen. |
| `PKBarcodeFormatAztec` | **Deferred** | Slightly better at small sizes and on damaged displays. Only worth revisiting if real scanners in the field struggle with QR, which is a field observation nobody has made. |
| `PKBarcodeFormatCode128` | **Not appropriate** | 1D, low capacity, and the existing scanner contract reads QR. |
| Putting the invitation capability in any barcode | **Not appropriate — prohibited** | A barcode is held up to a cashier's scanner. A capability in one is a capability handed to whoever holds the scanner. The cashier QR and the invitation link stay separate, and a unit test asserts it. |

### 1.4 Updates, expiry and revocation

| capability | bucket | notes |
|---|---|---|
| `webServiceURL` + device registration endpoints | **Needs provider setup** | Requires a signed pass (so, a certificate) and four public endpoints under a stable domain. Also a **business decision**: a registration endpoint stores a device library identifier and a push token per pass, which is a new category of customer data with no retention policy — see D16. |
| APNs push to refresh a pass | **Needs provider setup** | Requires the Pass Type ID certificate and an APNs connection. |
| **A pass already saved by a customer gaining the new link** | **Not supported today — explicitly** | Without `webServiceURL` and APNs there is no update channel at all. A saved pass gains the invitation link only when the pass is **issued again and saved again**. The owner UI says this in as many words (`Wallet.reinstallNote`), because the alternative is a merchant telling a customer to look for a link that will never appear. |
| `expirationDate` / `voided` | **Supported now (payload)** | `expirationDate` is emitted when the card has one. `voided` is not used: a voided pass is a dead object in a wallet, and the product's own model is that a card is expired or paused, not voided. |
| Revoking the invitation without touching the pass | **Supported now — in use** | The capability is revoked server-side; the URL in the pass stops resolving and the page shows a generic notice. This is the revocation that actually matters, and it needs no update channel. |

### 1.5 Relevance

| capability | bucket | notes |
|---|---|---|
| `relevantDate` | **Needs business decision** | Surfacing a pass on the lock screen at a time of day is plausible for a café. It is also a notification-shaped behaviour with no consent basis recorded, and consent in this product is `MARKETING` only — a lock-screen appearance is arguably not marketing, and arguably is. Not built until that is decided (D17). |
| `locations` / `maxDistance` (geo-relevance) | **Needs business decision, and deferred** | Putting a branch's coordinates in a pass makes the customer's device surface it nearby. It does **not** send the location anywhere, which is the common misreading — but it is still a location-triggered behaviour a customer did not ask for. Explicitly out of scope: the prompt requires an independent decision and an appropriate consent basis first (D17). Branch coordinates are not stored in the product today either. |
| `beacons` (iBeacon) | **Not appropriate / deferred** | Requires physical beacon hardware per branch and a UUID registry. No merchant has one. |

### 1.6 Other Apple surfaces

| capability | bucket | notes |
|---|---|---|
| Apple Watch | **Supported now, unverifiable locally** | A `storeCard` appears on a paired Watch automatically; there is no separate payload. What cannot be checked without hardware is whether the front fields are legible at that size and whether the barcode scans off a Watch screen — §6. |
| Add to Apple Wallet from a web page | **Needs provider setup** | Serving a `.pkpass` with the right MIME type is trivial; producing a valid signed one is not. |
| Associated iOS app | **Not appropriate** | No native app exists. |
| **NFC / Apple VAS (Value Added Services)** | **Needs provider setup — and eligibility, and hardware** | Three separate gates, all closed: (1) Apple must grant NFC certificate entitlement, which is an application and an approval, not a setting; (2) the merchant needs VAS-capable NFC terminals, which Syrian cafés do not have; (3) it requires a certificate this build cannot hold. **Nothing in this codebase claims, implements or prepares NFC**, and no roadmap entry should imply it is near. |

---

## 2. Google Wallet

### 2.1 Pass type and structure

| capability | bucket | notes |
|---|---|---|
| `LoyaltyClass` / `LoyaltyObject` split | **Supported now (payload)** | The correct type. The class is the programme — shared by every card issued under it; the object is one customer's card. `buildGoogleLoyaltyObject` emits an object referencing a `classId`. |
| Creating the class | **Needs provider setup** | A class is created through the Google Wallet API under an issuer id, with a service-account key. Both are credentials this phase may not add, so `classId` and `objectId` are **parameters**, filled with visible placeholders in a preview. Nothing in the code invents an issuer id: a configuration decision written as a constant is a configuration decision nobody made. |
| `GenericClass`/`GenericObject` instead | **Not appropriate** | Loses the loyalty affordances — points, the account row, the programme framing — for no gain. |
| `loyaltyPoints` / `secondaryLoyaltyPoints` | **Supported now (payload)** | Stamps and rewards-ready. |
| `accountId` / `accountName` | **Supported now (payload)** | The card serial and the holder's first name. **Never the phone number, never an internal id.** |

### 2.2 Links, images, text

| capability | bucket | notes |
|---|---|---|
| `linksModuleData.uris[]` | **Supported now — and this is what this phase ships** | The official field for a tappable web link on a Google pass, the same mechanism a merchant's site or phone number uses. Not a text module dressed up to look like a button. |
| `textModulesData` | **Supported now** | Carries the programme name. **No URL and no capability** — it renders in the card body. |
| `messages[]` (pass messages) | **Needs business decision** | A message on a pass can trigger a device notification. That makes it a messaging channel, and this product has a consent contract that governs those: `UNKNOWN`, withdrawn or absent permission is not marketing permission. Using pass messages without routing them through that contract would be a side door around it (D18). |
| `imageModulesData`, `heroImage`, `logo` | **Needs provider setup** | Images are hosted URLs on a Google pass rather than bundle contents, so this is less blocked than Apple — but it still needs a class, which needs an issuer. |
| Localisation (`LocalizedString` / `translatedValues`) | **Supported now (payload), not yet used** | Google takes translated strings inline, so unlike Apple this is achievable without a bundle. Today the payload is built per locale. Emitting both languages in one object is a small, worthwhile follow-up once a class exists. |
| App links (`appLinkData`) | **Not appropriate** | Requires an Android app, which does not exist. |

### 2.3 Lifecycle

| capability | bucket | notes |
|---|---|---|
| Updating an object (PATCH) | **Needs provider setup** | Needs the API and a service account. Would be how a balance stays fresh; today a Google pass shows the balance at issuance. |
| `state: EXPIRED` / `validTimeInterval` | **Supported now (payload)** | `state` is derived from the card's own `expiresAt`. |
| Deleting / invalidating an object | **Needs provider setup** | Google has no true delete; an object is expired. The invitation capability is revoked server-side regardless, which is the revocation that matters. |
| **A pass already saved gaining the new link** | **Not supported today — explicitly** | Same answer as Apple, for a different reason: updating a saved object needs the API. Re-issue and re-save. |

### 2.4 Notifications, location, hardware

| capability | bucket | notes |
|---|---|---|
| Notifications from a pass update or message | **Needs business decision** | And a correction that belongs in writing: **Google accepting an API call is not evidence that a notification was delivered, shown, or read.** There is no receipt. Any future feature must not report an API 200 as a delivery. (D18) |
| `locations[]` / nearby notifications | **Needs business decision, and deferred** | Same reasoning as Apple §1.5, plus: branch coordinates are not stored in the product. Requires an independent decision and a consent basis (D17). |
| **Smart Tap (NFC)** | **Needs provider setup — and approval, and hardware, and a POS** | Requires Smart Tap enablement on the issuer account, a collector id, key exchange, NFC terminals and a point-of-sale integration. Every one of those is absent. **Not enabled, not implemented, not prepared in this phase.** |
| Multiple devices / multiple holders per object | **Needs business decision** | Google allows an object to be saved on several devices, and `multipleDevicesAndHoldersAllowedStatus` controls it. Which setting is right is a product decision about whether a loyalty card is a person or a household (D19). Left unset rather than guessed. |
| Grouping (`groupingInfo`) | **Deferred** | Useful when a customer holds several cards from one business. Zademi's model is one card per programme per customer, so grouping matters only once a business runs several programmes — a real case, just not an urgent one. |
| Callbacks (save/delete webhooks) | **Not appropriate / deferred** | A webhook endpoint is an external integration surface, and this phase adds none. It would also record when a customer saved or removed a pass, which is behavioural data with no retention policy (D16). |
| Issuer account, audit and approval | **Needs provider setup** | A Google Wallet issuer account is applied for and reviewed. Passes cannot reach the public before that completes. |

---

## 3. Rules that hold across both platforms

1. **An accepted API call is not a delivered notification.** Neither Apple nor Google reports whether
   a notification was shown or read. Nothing in this product may present an API response as
   evidence of reach — the same rule the analytics work already follows.
2. **No token, no personal data, no cashier QR and no card link in a log, an audit row or an owner
   screen.** The invitation capability exists in the customer's wallet and nowhere else; the owner UI
   shows the payload with it redacted.
3. **No location, NFC, notification or callback without a stated consent basis and a retention
   rule.** None of the four is enabled here.
4. **No messaging, no reward, no public enrolment.** This phase shares a link. It grants nothing,
   sends nothing, and enrols nobody — B7 is unchanged.
5. **A capability that needs real hardware is not "nearly working".** NFC, Smart Tap, Apple Watch
   legibility and beacons are all in this class.

---

## 4. What Phase 3A Prompt 1 actually turned on

Exactly two rows from the tables above:

- Apple: **a tappable URL in a back field** (§1.2);
- Google: **`linksModuleData.uris[]`** (§2.2).

Both point at `https://<host>/share#<capability>`. Everything else is documented and scheduled, not
implemented.

---

## 5. Roadmap, in the order the gates open

| # | work | blocked on |
|---|---|---|
| 1 | Google Wallet issuer account + class creation | provider setup, approval |
| 2 | Apple Pass Type ID certificate + `.pkpass` signing and bundle assets | provider setup |
| 3 | "Add to Wallet" as a real customer action | 1 and 2 |
| 4 | Balance updates on a saved pass (Apple `webServiceURL`+APNs, Google PATCH) | 1, 2, and D16 (device-token retention) |
| 5 | Localised pass bundles | 1 and 2 |
| 6 | Pass messages / notifications | D18, and the existing consent contract |
| 7 | Location relevance | D17 |
| 8 | Referral **rewards** | D15. The attribution half shipped in Phase 3A Prompt 2 and grants nothing; crediting anybody is still an owner decision, and not a wallet capability either way |
| 9 | Smart Tap / Apple VAS | approval, terminals, POS. No date. |

---

## 6. Manual device gate — required before any production claim

None of the following has been done. Until every line is ticked by a person holding a device, this
product must not claim that wallet passes work.

### iPhone / Apple Wallet
- [ ] A signed `.pkpass` installs from Safari and from Mail.
- [ ] The front of the pass is legible in light and dark, and shows **no** link or token.
- [ ] The back shows the invitation row, and its URL is tappable.
- [ ] Tapping opens Safari at the invitation page, and the page resolves.
- [ ] The barcode scans at a counter and is still the cashier QR.
- [ ] VoiceOver reads the fields in a sensible order, with the Arabic pass in Arabic.
- [ ] Lock-screen appearance shows nothing sensitive.
- [ ] An expired card shows as expired.

### Apple Watch
- [ ] The pass appears on a paired Watch.
- [ ] Front fields are legible at Watch size.
- [ ] The barcode scans off the Watch screen, or the limitation is documented.

### Android / Google Wallet
- [ ] The object saves from a link.
- [ ] The invitation link appears in the pass's links section and opens a browser.
- [ ] The page resolves; the URL fragment is intact after the platform's handoff.
- [ ] The barcode scans and is still the cashier QR.
- [ ] TalkBack reads the pass; the Arabic pass renders right-to-left correctly.
- [ ] An expired card shows as expired.

### Both
- [ ] Revoking the link server-side makes a **saved** pass's link show the generic unavailable notice.
- [ ] Re-issuing a pass produces a new link and the old one stops working.
- [ ] No server log, anywhere, contains a capability after the whole walkthrough.

The last line is the one to actually check, not assume: it is the claim the fragment design exists to
make, and a platform that rewrote the URL during a handoff would break it silently.
