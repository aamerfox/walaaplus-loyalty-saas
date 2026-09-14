# WalaaPlus — Product Specification

Status: **Approved baseline for the rebuild.** Supersedes all prototype behaviour.
Owner: product owner. Last revised: Phase 0, Prompt 0.1.

Related documents: [PHASE-PLAN.md](PHASE-PLAN.md) · [BOOMERANGME-REFERENCE.md](BOOMERANGME-REFERENCE.md) · [DECISIONS-REQUIRED.md](DECISIONS-REQUIRED.md) · [PHASE-0-HYGIENE.md](PHASE-0-HYGIENE.md)

---

## 1. Product definition

WalaaPlus is an **Arabic-first, Syria-first digital loyalty and retention platform** for local businesses. It must work with no POS hardware, no wallet-pass availability, and no app-store distribution.

The product is **Zademi**. Its identity, palette, type and the brand assets still missing are in
[BRAND.md](BRAND.md); the merchant interface built on this spec is in
[PHASE-1B-IMPLEMENTATION.md](PHASE-1B-IMPLEMENTATION.md) §10.

The customer product is an **installable PWA loyalty card**. The staff product is an **authenticated scanner** with QR and manual phone lookup.

The complete MVP loop:

```
Merchant creates a loyalty program
  → Staff enrol the customer at the counter and hand over their card link
  → Customer opens the PWA card and adds it to the home screen
  → Staff scans the QR or enters the phone number
  → Staff awards or redeems loyalty value
  → An immutable ledger records every action
  → Merchant sees real customers and real activity
```

Target businesses: cafés, restaurants, bakeries, salons and barbershops, retail shops, pharmacies, clinics, gyms and studios, car washes, delivery-first businesses, professional services.

Arabic with RTL is the default experience. English remains fully supported.

---

## 2. Non-negotiable architecture principles

### 2.1 The ledger is the source of truth

A card balance is **never** edited directly. Every change to loyalty value writes one or more immutable `LoyaltyOperation` rows. Balance columns on the card are a **projection** maintained inside the same database transaction as the operation insert, never an independent authority.

Every metric — dashboards, customer history, LTV, ROI, retention, RFM, staff performance, referral attribution — derives from the ledger.

### 2.2 Corrections are compensating reversals

Operations are never deleted or updated. A mistake is corrected by writing a new operation group whose rows each reference the original through `reversalOfOperationId`, with a `reason`.

A reversal is **rejected** if it would drive any resulting balance below zero — for example, reversing an award whose earned reward has already been redeemed. That case routes to an explicit manual-correction workflow.

### 2.3 Writes are transactional and idempotent

Every scanner, API, webhook, import and automation write carries an `idempotencyKey` and an `idempotencyPayloadHash`.

- Same key, same payload → return the original stored result, create nothing.
- Same key, different payload → reject.
- Idempotency lives in its own `IdempotencyRecord` table, **not** on `LoyaltyOperation`, because one user action may write several ledger rows.
- The ledger insert and the balance projection commit in one transaction, using a `SELECT … FOR UPDATE` row lock on the card or serializable isolation with retry.

### 2.4 Append-only is enforced by PostgreSQL

`LoyaltyOperation` has no `updatedAt`. A database trigger rejects `UPDATE` and `DELETE`. The application runtime role holds no privilege to alter ledger history; a separate migration role owns schema changes.

### 2.5 Mechanics are versioned, presentation is live

Splitting these prevents the Boomerangme failure mode where a merchant changes a threshold and every installed card shows stale numbers.

| Pinned to `ProgramVersion` (immutable after activation) | Live on `ProgramTemplate` (editable always) |
|---|---|
| Card program type | Logo, icon, colours, background |
| Unit behaviour | Customer-facing labels |
| Earn rule and rates | Business links (url, phone, email, address) |
| Reward threshold structure | Terms, privacy, marketing-consent text |
| Reward tiers | Issuer name, email, phone |
| Daily limits | Enrollment page title and imagery |
| Card and inactivity expiry behaviour | Push copy and branding |
| Redemption rules | Arabic and English localized text |

`cardType` lives on `ProgramTemplate` and locks at first activation. A stamp program can never become a points program.

Issued cards keep `programVersionId` forever. The engine always reads mechanics from the card's pinned version, never the template's current active version. Retired versions stay readable.

**How a merchant changes a live program (built in Phase 1b Prompt 3).** They do not edit it; they publish the next version of it:

1. **Open a draft** from the live version. It starts as an exact copy, so "what changed" means what the merchant changed.
2. **Edit the draft.** Mechanics and reward tiers are mutable only while a version is `DRAFT`; the `walaaplus_protect_program_version` and `reward_tier_protect` triggers enforce that, not the application.
3. **Review the differences** against the live version, stated in the merchant's own language — thresholds, rewards, limits, counters — alongside how many cards will keep the old rules.
4. **Publish.** One transaction under the template's row lock: the live version is `RETIRED` (with `retiredAt`), the draft becomes `ACTIVE`, and the change is audited with the published mechanics in full. A publish whose draft number no longer matches the server's is refused, so nobody publishes a version they did not read.

At most one `DRAFT` and one `ACTIVE` version per template, both as partial unique indexes. **No issued card is written to at any point.** New cards issued after publication pin the new version; every existing card keeps the rules it was sold under, including its reward tiers, its limits and its counters.

A version is never deleted once it has been active, and a program is never deleted at all. `PAUSED` stops new sign-ups while every issued card keeps working; `ARCHIVED` remains unreachable from the product until the consequences for cards pinned to its versions are designed.

### 2.6 Tenant isolation and authorization are server-side

Every business-scoped query includes tenant scope. Never authorize because a record id exists.

```ts
// forbidden
prisma.programTemplate.findUnique({ where: { id } })

// required
prisma.programTemplate.findFirst({ where: { id, businessId: ctx.businessId } })
```

Shared guards on every protected route:

```
requireSession()
requireBusinessMembership(businessId)
requireLocationAccess(locationId)
requirePermission(permission)
```

Membership and permissions are resolved **per request**, not carried in the session token, because a user may hold several memberships and permissions change.

### 2.7 The customer PWA is the primary wallet

Google Wallet is unavailable in Syria and Apple pass signing requires a paid developer account that is hard to obtain locally. The PWA card is therefore the product, not a fallback. Wallet passes are a later optional enhancement.

### 2.8 Money and phone identity

- All monetary values are **integers in minor units** with the business currency. No floating-point money. Column names carry no currency code.
- Phone numbers are normalized at the input boundary to a canonical international format, and are **mandatory** for MVP enrollment.
- Global `Customer` identity is separate from per-business `CustomerBusinessProfile`.

---

## 3. Identity and tenancy model

```
User                            global merchant identity
  └─ BusinessMembership         role + permissions per business
      └─ Business
          ├─ Location           default "Main" created at registration
          ├─ ProgramTemplate
          │   ├─ ProgramVersion    pinned mechanics
          │   ├─ RewardTier        keyed to a version
          │   └─ UtmSourceLink     includes default "direct"
          ├─ CustomerBusinessProfile
          │   └─ CustomerCard
          │       └─ LoyaltyOperation
          ├─ PushMessage / PushDelivery
          └─ AuditLog

Customer                        global person identity (phone)
  └─ CustomerBusinessProfile    one per business
```

Global users with memberships, rather than staff embedded in a business, is what later allows one person to own two businesses, agency staff to reach client businesses, and franchise staff to move between branches without account migration.

### Roles

| Role | Scope |
|---|---|
| `OWNER` | Full access to one business |
| `MANAGER` | Configurable permission set |
| `CASHIER` | Scanner and manual loyalty actions, restricted to assigned locations |
| `AGENCY_OWNER`, `AGENCY_MANAGER` | Phase 5 |
| `FRANCHISE_OWNER`, `FRANCHISE_MANAGER` | Phase 5 |

### Permissions

```
VIEW_DASHBOARD      VIEW_TEMPLATES     EDIT_TEMPLATES
VIEW_CUSTOMERS      EDIT_CUSTOMERS     VIEW_OPERATIONS
MAKE_ACCRUALS       MAKE_REDEMPTIONS   VIEW_LOCATIONS
EDIT_LOCATIONS      VIEW_STAFF         EDIT_STAFF
VIEW_PUSHES         EDIT_PUSHES        VIEW_SEGMENTS
EDIT_SEGMENTS       VIEW_INTEGRATIONS  EDIT_INTEGRATIONS
VIEW_BILLING        EDIT_BILLING       VIEW_AGENCY
EDIT_AGENCY
```

Cashier defaults: `MAKE_ACCRUALS`, `MAKE_REDEMPTIONS`, `VIEW_CUSTOMERS` limited to the scanned or searched customer, `VIEW_OPERATIONS` limited to assigned locations.

### Registration

Registration is atomic and creates, in one transaction:

1. Global `User`
2. `Business` with currency, `defaultLocale = ar`, and timezone (default `Asia/Damascus`)
3. `BusinessMembership` with role `OWNER`
4. A non-removable default `Location` named **Main**

Every `LoyaltyOperation` requires a non-null `locationId`. Dashboard-originated actions attribute to Main.

---

## 4. Core entities

### User
```
id, email, passwordHash, firstName, lastName, phone,
platformRole, active, createdAt, updatedAt
```

### BusinessMembership
```
id, businessId, userId, role, permissionsJson, active,
createdAt, updatedAt
```

### Business
```
id, agencyId (nullable, Phase 5), name, legalName, phone, email,
currency (SYP), defaultLocale (ar), timezone, logoUrl, active,
createdAt, updatedAt
```

### Location
```
id, businessId, name, address, latitude (nullable), longitude (nullable),
isDefault, active, createdAt, updatedAt
```
Latitude and longitude are reserved for geo-push in a later phase; nothing sets them, and no screen collects them.

**A location is closed, never deleted** (Phase 1b Prompt 3). `active: false` means no new value may be written at that counter; everything already written stays attributed to it, readable in the per-location breakdown forever. An owner or manager may open a counter, rename it, close it and open it again — the row keeps its id, so a branch that reopens keeps its history. Three closures are refused because each would break the business: the default `Main` counter (enrolment and every main-only version write there), the last active counter, and the only active counter of a live program. `address` is a note staff read: it is never published, geocoded or written to an audit row.

### Customer — global identity
```
id, normalizedPhone (unique), email, birthDate, createdAt, updatedAt
```
Names are **not** held here. Café A may know the person as Ahmad and salon B as Ahmed; one business must never overwrite another's record.

### CustomerBusinessProfile — tenant-scoped
```
id, businessId, customerId, firstName, lastName,
marketingConsent, privacyConsentAt, consentTextVersion,
customFieldsJson, utmSource, utmMedium, utmCampaign,
referrerCustomerCardId, firstSeenAt, lastSeenAt,
createdAt, updatedAt
```

### ProgramTemplate — live presentation
```
id, businessId, name, status, cardType, defaultLocale,
livePresentationJson, liveLegalJson, liveIssuerJson, livePlatformJson,
createdAt, updatedAt
```
`status`: `DRAFT`, `ACTIVE`, `PAUSED`, `ARCHIVED`. `PAUSED` blocks **new enrollment** while existing cards continue to scan and redeem normally. Pausing and resuming are owner verbs in the product; `ARCHIVED` is not reachable from a screen.

### ProgramVersion — immutable mechanics
```
id, templateId, versionNumber, status, mechanicsJson,
createdAt, activatedAt
```
`status`: `DRAFT`, `ACTIVE`, `RETIRED`. Exactly one `ACTIVE` version per template, enforced by a partial unique index. There is deliberately no `activeVersionId` pointer on the template, to avoid two sources of truth that can drift.

### RewardTier
```
id, programVersionId, name, description, requiredPoints,
rewardValueMinor, usageLimit, sortOrder
```
A table, not a JSON array, because the ledger references `rewardTierId` and later phases add segment and UTM eligibility.

### CustomerCard
```
id, businessId, templateId, programVersionId, customerBusinessProfileId,
serialNumber, qrToken (unique), shareToken (unique), status, deviceChannel,
stampBalance, pointBalance, rewardBalance,
cashBalanceMinor, visitBalance,          -- reserved for later card types
issuedAt, firstOpenedAt, lastOpenedAt, pwaDetectedAt,
expiresAt, lastActivityAt, utmSourceLinkId,
createdAt, updatedAt
```

`status`: `ISSUED`, `ACTIVE`, `PAUSED`, `EXPIRED`, `DELETED`.

Unique constraint on `(customerBusinessProfileId, templateId)` — one card per customer per program. This is what makes enrollment idempotent.

`qrToken` is a short, opaque, unguessable value. It is never the card id, never the customer id, and carries no personal data. The card page URL uses a separate token, so knowing a scanned QR does not grant access to the card page.

**Three balances are required.** A stamp card holds stamps and earned-but-unredeemed rewards simultaneously; one balance column cannot represent it.

### LoyaltyOperation — append-only ledger
```
id, transactionGroupId, businessId, locationId,
customerId, customerBusinessProfileId, customerCardId,
templateId, programVersionId, performedByUserId, rewardTierId,
kind, unitType, quantity,
purchaseAmountMinor, monetaryDeltaMinor, redemptionValueMinor,
balanceAfter, countsAsVisit, source, comment, reason,
reversalOfOperationId, externalProvider, externalEventId,
createdAt
```

No `updatedAt`. Field meanings:

| Field | Meaning |
|---|---|
| `purchaseAmountMinor` | What the customer spent in this transaction |
| `monetaryDeltaMinor` | Monetary balance moved, for money-based programs later |
| `redemptionValueMinor` | Merchant cost or value of a redeemed reward |
| `balanceAfter` | Resulting balance of the affected `unitType` |
| `transactionGroupId` | Groups atomic rows, such as a stamp conversion |
| `countsAsVisit` | Frozen at write time, see §5.4 |
| `source` | `SCANNER`, `DASHBOARD`, `ENROLLMENT`, `AUTOMATION`, `IMPORT`, `API`, `SYSTEM` |

**Kinds**
```
CARD_ISSUED        WELCOME_BONUS       BIRTHDAY_BONUS
MANUAL_AWARD       VISIT_AWARD         PURCHASE_AWARD
STAMP_CONVERTED    REWARD_EARNED       REWARD_REDEEMED
BALANCE_REDEEMED   BALANCE_EXPIRED     IMPORT_ADJUSTMENT
REVERSAL           REFERRAL_BONUS      PROMOTION_REDEEMED
INTEGRATION_AWARD  INTEGRATION_REVERSAL
```

**Unit types**
```
STAMP   POINT   REWARD   CASH   VISIT
```

### IdempotencyRecord
```
id, businessId, key, payloadHash, transactionGroupId,
responseJson, createdAt
```
Unique on `(businessId, key)`.

### AuditLog
```
id, businessId, actorUserId, action, entityType, entityId,
metadataJson, ipAddress, createdAt
```
For non-ledger security and business events: restore-link generation, template activation, staff changes, permission changes, exports.

### Push
```
PushSubscription  id, businessId, customerCardId, endpoint (unique),
                  p256dh, auth, userAgent, active, createdAt, updatedAt

PushMessage       id, businessId, templateId, title, body, targetUrl,
                  kind, status, scheduledAt, createdByUserId, createdAt

PushDelivery      id, pushMessageId, pushSubscriptionId, customerCardId,
                  status, attemptCount, providerStatusCode, failureReason,
                  sentAt, failedAt, createdAt
```
One campaign row plus one delivery row per recipient. A broadcast to 5,000 cards is one `PushMessage` and 5,000 `PushDelivery` rows.

**None of these three tables exists.** They describe delivery, and no delivery is built. What exists
is the draft that would one day feed them:

### Campaign (built, Phase 2 Prompt 2)
```
Campaign          id, businessId, name, normalizedName, channel, locale,
                  segmentId (nullable), state, archivedAt,
                  createdByUserId, createdAt, updatedAt

CampaignRevision  id, campaignId, revisionNumber, subject, body,
                  placeholders, createdByUserId, createdAt        APPEND-ONLY

ConsentRecord     id, businessId, customerBusinessProfileId, scope, state,
                  previousState, policyVersion, capturedVia, reason,
                  recordedByUserId, recordedAt                    APPEND-ONLY
```
### Campaign approval (built, Phase 2 Prompt 3)
```
CampaignApproval          id, businessId, campaignId, campaignRevisionId,
                          revisionNumber, decision, intendedChannel,
                          audienceSnapshotId, withdrawsApprovalId,
                          decidedByUserId, decidedAt, note        APPEND-ONLY

CampaignAudienceSnapshot  id, businessId, campaignId, campaignRevisionId,
                          segmentId, segmentName, takenAt, matchedCount,
                          eligibleCount, unknownCount, withdrawnCount,
                          takenByUserId                           APPEND-ONLY

CampaignAudienceMember    id, snapshotId, customerBusinessProfileId,
                          consentState, consentRecordId           APPEND-ONLY
```
### CardShareLink (built, Phase 3A Prompt 1)
```
CardShareLink  id, businessId, customerCardId, tokenDigest (unique),
               issuedFor, issuedAt, issuedByUserId, revokedAt
               ISSUE-ONCE: no DELETE, no TRUNCATE, and one UPDATE (revokedAt, once, from NULL)
```
`tokenDigest` is SHA-256 of a 32-byte random capability. **The raw value is never stored.** One live
row per card, enforced by a partial unique index.

### ReferralAttribution (built, Phase 3A Prompt 2)
```
ReferralAttribution  id, businessId, entry, referringShareLinkId,
                     referringCustomerCardId, enrolledCustomerCardId,
                     enrolledProfileId, method, voidsAttributionId,
                     reason, recordedAt, recordedByUserId        APPEND-ONLY
```
Internal ids only. **No amount, currency, points, reward reference, eligibility flag, expiry or
campaign** — an attribution is not a reward, and D15 owns the policy that would make one. One
`ATTRIBUTED` row per enrolled card, ever, by partial unique index; voiding writes a `VOIDED` row and
does not free the slot.

`Campaign.state` is `DRAFT | IN_REVIEW | APPROVED | WITHDRAWN | ARCHIVED` — there is no sent,
scheduled or queued value, and `channel` is a LABEL on the draft, not a route to anything. `APPROVED`
and `WITHDRAWN` are written only by the approval service, never by a state-setting request.

All five append-only tables are protected twice: by trigger, and by a runtime role that holds only
`SELECT` and `INSERT` on them.

### UtmSourceLink
```
id, templateId, name, publicToken (unique), utmSource, utmMedium,
utmCampaign, welcomeUnitQuantity, welcomeBonusExpiresAfterDays,
enrollmentTitle, enrollmentImageUrl, active, createdAt, updatedAt
```

Every template gets a default link named **Direct** with `utmSource = direct` at creation. There is no separate generic enrollment token, so **every issued card always carries source attribution**. Since B7 option 3 the Direct link's `publicToken` is **server-side only** — it is resolved from the staff session at counter enrollment and is never published, rendered or returned to any client.

Uniqueness: `publicToken` is globally unique; `name` is unique **per template**. `utmSource` is deliberately *not* unique — several links (two Instagram campaigns, two in-store table codes) may share one source and differ by name, medium or campaign.

---

## 5. MVP loyalty engine

Two program types ship in the MVP. The ledger and rules model stay unit-agnostic so later types are configuration, not a second engine.

### 5.1 Stamp program

Earn: manual staff award, one stamp per visit, or stamps per spend block.
Redeem: earned rewards, with optional reward value recorded.

```
stampsRequiredPerReward   rewardName            rewardDescription
rewardValueMinor          earnMode              spendAmountPerStampMinor
dailyAwardLimit           requirePurchaseAmount cardExpiryMode
cardExpiryDate            cardExpiryDaysAfterIssue
inactivityExpiryDays      welcomeStamps         birthdayStamps
availableLocations        enrollmentFields
privacyPolicy             termsOfUse            marketingConsentText
countRewardRedemptionAsVisit
```

### 5.2 Points and reward program

Earn: manual staff award, points per visit, or points per spend block.
Redeem: a configured `RewardTier`, recorded with `rewardTierId`.

**Implemented in Phase 1b Prompt 1.** The shipped contract is the subset below that this phase
builds — `earnMode`, `pointsPerVisit`, `spendAmountPerBlockMinor` + `pointsPerBlock`,
`maxPointsPerManualAward`, `dailyAwardLimit`, `requirePurchaseAmount`, `welcomePoints`,
`countRewardRedemptionAsVisit`, `availableLocations`, `pointsLabel` — and the schema is **strict**,
so expiry modes, birthday points and every other deferred mechanic are refused at the boundary
rather than stored and half-honoured. `rewardTiers` are **rows** (`RewardTier`), not JSON, because
the ledger references them by id. Points never convert automatically: a redemption debits
`tier.requiredPoints` in one row and there is no intermediate reward balance. See
[PHASE-1B-IMPLEMENTATION.md](PHASE-1B-IMPLEMENTATION.md) §2.

```
earnMode                  pointsPerVisit        spendAmountPerPointsRule
dailyAwardLimit           requirePurchaseAmount cardExpiryMode
cardExpiryDate            cardExpiryDaysAfterIssue
inactivityExpiryDays      welcomePoints         birthdayPoints
rewardTiers               availableLocations    enrollmentFields
privacyPolicy             termsOfUse            marketingConsentText
countRewardRedemptionAsVisit
```

### 5.3 Stamp-to-reward conversion

Conversion is **immediate** on reaching the threshold, writes an atomic group, carries the remainder over, and can produce several rewards from one large award.

```
transactionGroupId: <uuid>

PURCHASE_AWARD    unitType STAMP    quantity +12
STAMP_CONVERTED   unitType STAMP    quantity -10
REWARD_EARNED     unitType REWARD   quantity  +1
                                    → stampBalance 2, rewardBalance 1
```

Rewards remain in `rewardBalance` until staff redeem them. Automatic redemption on the next scan is deferred.

### 5.4 Visit definition

`countsAsVisit` is written immutably on each operation so the definition is frozen per row even if the rule later changes.

- **Counts:** manual award, visit award, purchase award.
- **Never counts:** welcome, birthday, referral, conversion, reward earned, import, expiry, correction, reversal, system events.
- **Reward redemption:** governed by the program-version setting `countRewardRedemptionAsVisit`, default `false`. A customer who comes only to claim a free coffee is a real visit for some merchants, so this is a merchant decision.

### 5.5 Spend-block rounding

Spend earning uses whole blocks with **floor rounding and no remainder carry-over**. With 1 stamp per 10,000 minor units, a 25,000 purchase awards 2 stamps and the 5,000 remainder is discarded. Merchants expect this and it matches Boomerangme.

### 5.6 Daily limits and timezone

`dailyAwardLimit` counts award operations per card per **business-timezone day**. Timezone lives on `Business`.

### 5.7 Expiry (Phase 1.5)

MVP supports three modes only:
- Fixed expiry date on the card
- Expiry N days after issue
- **Whole-balance inactivity expiry** after N days without activity

Per-stamp and per-point FIFO lot expiry is **deferred**. It requires lot tracking, expiry queues, customer-facing "expiring soon" messaging, and complicates redemption. Whole-balance inactivity expiry is one column and one job, and merchants understand it.

---

## 6. Enrollment and the customer PWA

### 6.1 Enrollment flow

Enrollment is **staff-assisted**, from the authenticated Scanner. Public self-service enrollment was
withdrawn by owner decision **B7 option 3** on 2026-09-12; see §6.1.1.

```
Staff search a phone number in the Scanner and find no customer
  → server resolves business → template → Direct UtmSourceLink from the STAFF SESSION
  → mandatory phone (the one just searched), optional name, explicit consent tick
  → match or create Customer by normalized phone
  → match or create CustomerBusinessProfile
  → issue CustomerCard (unique per profile+template)
  → card issuance recorded in AuditLog; WELCOME_BONUS operation when configured
  → staff hand over the card link or QR, on screen
  → customer opens their card and installs it
```

Requirements: `EDIT_CUSTOMERS`, re-verified against an active membership of **that** business; the
caller supplies no business, tenant, source token, location, balance or reward setting; idempotent
enrollment, so a repeat returns the existing card and grants no second welcome bonus; per-source
welcome bonus overrides the template default; the exact consent text version and the server's own
timestamp stored; no card token, card URL, phone number or name in logs, error responses or audit
metadata.

#### 6.1.1 Why public self-service enrollment is withdrawn

A public form must issue a live card to a number with no card, and must **not** hand an existing
customer's card to whoever typed their number. Those two outcomes are distinguishable by whoever
submits the form, in any implementation, so the form reports whether a phone number belongs to a
customer of that business — to anyone, at scale. Suppressing the difference in the response body
does not close it.

Closing it requires proving the submitter owns the number, and no verification channel is
authorized in Phase 1a (D2 SMS and D4 WhatsApp remain deferred). **Public enrollment must not
return until proof of phone ownership exists and has been independently audited.**

**Card restore** follows the same rule: a customer who loses their link asks staff, who look the
number up in the Scanner and show the card link and QR again. That reveal is audited, without the
token or the URL in the audit record. There is no public restore page.

**Card issuance is audited, not ledgered.** An earlier draft of this flow wrote a `CARD_ISSUED`
operation. The ledger refuses zero-quantity rows — that invariant is what makes every ledger row a
real movement of value — and issuing a card moves none. A `+0` row would break the invariant and a
`+1` row would inflate a balance to represent an event that granted nothing. Issuance is therefore
recorded by `CustomerCard.issuedAt`, `CustomerCard.utmSourceLinkId` and an `AuditLog` entry; the
`CARD_ISSUED` kind is unused. A welcome bonus, which does move value, remains a real operation.
See [PHASE-1A-IMPLEMENTATION.md](PHASE-1A-IMPLEMENTATION.md) §4.

High-entropy public tokens still apply to the **card** link the customer walks away with, which is
a capability: it is never written to an audit record, a log line or an error response.

### 6.2 The card is its own PWA

A customer holding cards from three businesses needs three home-screen icons. Therefore:

- The **web manifest is generated per card**, with its own `id`, `name`, `short_name`, `icons`, `start_url`, `theme_color`, `background_color`.
- The service worker is **registered per card path**, scope `/card/<token>/`. This yields per-card push subscriptions, per-card caches, and cache isolation between cards by construction. A single root-scoped worker would permit only one push subscription per browser and would make `PushSubscription.customerCardId` impossible.

### 6.3 Card page contents

Arabic RTL mobile-first, English supported: business logo and name, customer name, stamp balance, reward balance, progress to next reward, available rewards, card status and expiry, QR code (QR only in MVP, no PDF417), business links, terms and privacy, push permission prompt, offline display of the last known state.

The customer card route is public and must **never** redirect to merchant login.

### 6.4 Installation telemetry is best-effort

`appinstalled` fires on Android Chrome but **not on iOS Safari**, where the only reliable signal is standalone display mode on first open.

Track `firstOpenedAt`, `lastOpenedAt`, `pwaDetectedAt`, and a single `deviceChannel`. The dashboard label is **"cards opened as an app"**, not "installed". No business rule may depend on installation being a guaranteed fact.

### 6.5 Card restore

MVP restore is **staff-assisted**: the merchant searches the customer, opens the card, copies the personal restore link, and sends it through WhatsApp or SMS manually. The action writes an `AuditLog` entry.

Automated OTP restore is deferred because every verification channel (SMS, email, WhatsApp) is itself deferred.

---

## 7. Scanner

Entry paths: camera QR scan, phone lookup, name lookup, email lookup, card serial lookup. Phone lookup is a **first-class path**, not a fallback, because delivery businesses never see the customer's screen.

```
Staff login
  → assigned or default location
  → scan QR or search
  → validate active card
  → choose award or redemption
  → enter units, purchase amount, comment as required
  → client generates idempotency key
  → server validates role, location, and program rules
  → one transaction writes the ledger group and projections
  → return final balances
```

Rules: cashier sees only permitted data and actions; cashier is limited to assigned locations; `locationId` and `performedByUserId` are always non-null; purchase amount required only when mechanics demand it; internal comments stored on the operation and never shown to the customer; no direct balance updates; camera permission failure degrades gracefully to search.

Kiosk mode, scanner sound preferences, offline operation queue, promotion redemption, and other card-type operations are deferred.

---

## 8. Operational requirements

- **Background jobs** run in a **separate `pg-boss` worker process**, never tied to the Next.js server lifecycle. Jobs: birthday bonus, expiry, scheduled push, push retry, invalid-subscription cleanup, nightly ledger reconciliation, later integration retries and analytics aggregation.
- **Reconciliation** asserts that the sum of ledger operations equals each card's materialized balance, and alerts on drift. The query and test utility land in Phase 0; the scheduled nightly job in Phase 1.5.
- **Backups**: nightly database dump to owner-chosen storage with a documented restore drill.
- **Monitoring**: health checks for the web process, the worker, and job failure rates.
- **Security**: no hardcoded fallback secrets anywhere; environment validation at startup that fails fast; Argon2 or bcrypt password hashing; HTTP-only session cookies; rate limits on login and scanner writes; validated request bodies; encrypted external credentials; no secrets in logs.

---

## 8A. Customer records, segments and analytics (Phase 2)

### 8A.1 A customer is a person

`CustomerBusinessProfile` is one person per business, and the merchant-facing record is scoped to it
rather than to a card. A customer holding a stamp card and a points card is ONE customer with two
cards; each card is read through the contract its own `cardType` owns, and each keeps the version it
was issued under.

The record shows identity, every card with its balances and pinned version, the branches that card's
version runs at, the display name of the source it came from, and the ledger activity across all of
them. It shows **no card token, no card URL, no QR and no source token** — none is selected by any
query behind it — and there is no export: downloading customer data needs its own privacy,
retention, authorization and audit contract.

Reading the record requires `VIEW_CUSTOMERS` and is refused for a CASHIER, whose permission is to
serve whoever is at the counter. Activity is narrowed to the member's assigned branches.

### 8A.2 A segment is a definition, not a list

A saved segment is a validated, versioned object over an allowlist of fields the domain can prove —
program, card type, pinned version, the three balances, source name, "served at a branch", joined
date, last activity. It is never a SQL fragment, never a Prisma `where`, and never a stored list of
customers: membership is derived on every read from live data, so a segment cannot go stale and
cannot become a second copy of anybody's personal data.

**`all` means one CARD satisfies every card-scoped rule**, not one card per rule. `any` is the union.
Names are unique per business, case- and whitespace-insensitively. Segments are archived, never
deleted, because a campaign draft references one by id (§8A.5).

`VIEW_SEGMENTS` reads, `EDIT_SEGMENTS` writes, and counting additionally requires a membership with
no branch restriction — a count narrowed per viewer would be a different number on every screen.

### 8A.3 Analytics say only what the ledger proves

Every figure is derived from `LoyaltyOperation` and `CustomerCard` by aggregate query. There is no
stored counter, no cached total, and no metric called revenue, ROI, lifetime value or campaign
performance, because the data to compute one honestly does not exist. `redemptionValueMinor` is what
a reward cost the merchant and is labelled as that.

Date presets and custom ranges are **business-timezone days** (§5.6), so the dashboard and the daily
award limit agree about which day a 01:00 sale belongs to. A range beyond the ceiling is refused
rather than clamped. Segment dates are UTC instead, because a segment is a standing rule with no
clock attached and must mean the same set to every reader.

### 8A.4 Marketing permission is a history, and a gap in it is not a yes

A customer's marketing preference is an append-only `ConsentRecord` history, not a column that gets
overwritten. Each entry records the state, the state it replaced, the policy version in force, when
it was recorded, how it was captured, which staff member recorded it, and an optional reason. The
enrolment answer is the first entry in the history and is never rewritten by anything a staff member
does.

Three states, and only one of them is a permission:

- `GRANTED` — agreed, on a known date, to a known version of the wording. The only state that may be
  contacted.
- `WITHDRAWN` — said no. Complete on its own; a refusal needs no timestamp to be unambiguous.
- `UNKNOWN` — the record cannot say *when* they agreed or *to what wording*. Treated as no.

`UNKNOWN` is a real state rather than a silent false because the two mean different things to a
merchant: one person declined, the other was never properly asked, and only the second is worth
going back to. Every enrolment taken before the consent version was recorded lands here.

There is **no customer-facing preference page and no unsubscribe route.** Both would be public
endpoints that identify a customer and change something about them, which is the unsolved problem of
B7 (§7.1). Consent is recorded by a staff member with `EDIT_CUSTOMERS`, from what the customer told
them, and is captured as exactly that — never as a customer action.

The history is append-only in the database, by trigger, and the runtime role holds only `SELECT` and
`INSERT` on the table. Consent that can be edited afterwards is not evidence of anything.

### 8A.5 A campaign is a draft, and this phase gives it nothing to send with

A campaign is a name, an intended channel label, a language, an optional saved segment as its
audience, and content kept as numbered, append-only revisions. It has five states — `DRAFT`,
`IN_REVIEW`, `APPROVED`, `WITHDRAWN`, `ARCHIVED` — none of which is operational, and none of which
schedules, queues or reserves anything.

**No delivery exists anywhere in this phase**: no provider, credential, queue, worker, scheduler or
send verb, and no state a draft can enter that implies one. Drafts archive and restore; they are
never deleted, because a revision history that can be removed is not a history.

The audience is **three integers** — matched, may be contacted, may not — recomputed live from the
segment's stored definition each time they are asked for. No recipient list is built, stored,
returned or logged; no name, phone, card, serial or token of any recipient reaches a preview, an
audit row or a log line. A branch-scoped member cannot ask for the numbers at all, for the same
reason they cannot count a segment.

Content may use exactly two placeholders, `{{firstName}}` and `{{businessName}}`. The grammar has no
paths, filters, fallbacks or expressions, and any `{{ … }}` that is not a well-formed known
placeholder is refused by name. `programName`, `stampBalance`, `pointBalance` and `rewardName` are
refused with their own reason: a customer may hold several cards, and the product does not guess
which one was meant. Previews render from fixed sample values in the draft's own language and
direction, so no customer is ever read to draw one.

### 8A.6 Approval is a record of a person, and it authorises nothing

**`APPROVED` is a consequence, not a setting.** It is what it looks like from outside when an
append-only `CampaignApproval` row exists for a campaign's current revision. No request can set it:
the state-setting action accepts `DRAFT`, `IN_REVIEW` and `ARCHIVED` and refuses everything else.

One approval row carries the campaign, **the exact revision**, the decision, the channel declared at
the moment of the decision, the audience snapshot, the approver, the time, and an optional note. The
channel is declared rather than read back from the draft: approving an SMS and later relabelling the
draft as WhatsApp does not approve a WhatsApp message.

**The approval policy is one approver** — `EDIT_PUSHES`, plus a membership with no branch
restriction, because a snapshot is business-wide and a branch-scoped approver cannot verify the
number they are signing off. A mandatory second approver is not invented while a pilot merchant is
one person (§D12).

Editing approved content is allowed and **drops the campaign back to `DRAFT`**, clearing its approval
pointers, in the same transaction that writes the new revision. The approval row is untouched: it
remains a true statement about the revision it named. Changing the *audience* while approved is
refused outright — withdrawing first makes that a decision somebody takes.

Withdrawal is explicit, audited and **adds a row** pointing at the approval it took back. Nothing is
deleted, and approving again writes a third row and a new snapshot.

### 8A.7 The audience snapshot, and why it is frozen

A segment is a live definition whose membership moves. A decision has to keep meaning what it meant,
so approving takes an immutable snapshot in the same transaction.

A snapshot stores the counts, the segment's name as it was, and **one row per customer who may be
contacted** — an internal profile reference, the consent state observed at that instant, and the
consent record that decided it (null when the permission came from the enrolment answer itself).

It stores no phone, name, email, card id, serial, card URL, QR token, share token, source token or
rendered message. **No row at all is written for an excluded customer**: the two exclusion reasons
live on the header as counts, because somebody who never agreed to be contacted has not agreed to
appear in a marketing artefact either.

Retention is an open decision (§D13). Nothing deletes a snapshot today.

### 8A.8 The delivery boundary

`src/server/campaigns/delivery.ts` is the only delivery-shaped thing in the product. Its sole
implementation throws before reading anything, and it takes a snapshot id and nothing else — no
variant accepts a recipient, a phone number or a rendered message.

Every campaign response carries a readiness object: `deliverable` is `false`, the blocker list always
ends with `NO_DELIVERY_CHANNEL_EXISTS`, and `consentMustBeRecheckedAtDispatch` is `true`.

**An approval is not permission to contact anybody.** A snapshot is the *ceiling* of an audience at
one instant, never its authority. Whatever builds delivery re-reads each customer's current consent
at the moment it contacts them: a customer who withdraws tomorrow must not be messaged from a
snapshot taken today.

### 8A.9 The invitation capability, and the public page a wallet pass opens (Phase 3A)

A card may carry a fifth opaque value beside its `qrToken`, `shareToken`, serial and enrolment
source: an **invitation capability**, drawn independently of all of them so that holding one yields
none of the others.

**Only the SHA-256 digest is stored.** The raw value exists in the response that mints it and in the
wallet pass built from it, and nothing reads it back. No salt and no keyed HMAC: the input is 32
bytes of `crypto.randomBytes`, so there is no dictionary to precompute, and a keyed digest would
need a secret this phase may not introduce. A copy of the database yields nobody a working link.

**The link is `https://<host>/share#<capability>`.** The token is in the fragment, which is never
sent with a request — so it appears in no access log, no proxy log, no `Referer` header and no error
report. The page reads it in the browser and posts it to `/api/share/resolve` in a body, which is
the only point on the server that ever sees one.

`/api/share/resolve` **writes nothing**: no audit row, no visit counter, no timestamp, no IP, no
user agent, and no rate-limit record. It is not rate limited, deliberately — a per-address limit
would mean storing the address of everyone who opens an invitation, which is the tracking this page
exists without, and a 256-bit token behind one indexed lookup does not need one. Every failure —
unknown, revoked, malformed, a card since deleted, a business gone inactive — answers in one
identical shape.

**Lifecycle.** Minted lazily, only by the authorized wallet-pass issuance path; nothing backfills and
no bulk job walks the card table. Issuing retires the card's previous link in the same transaction,
so a card never has two live ones. Revoking is explicit and final. `CardShareLink` refuses DELETE and
TRUNCATE by trigger and permits exactly one UPDATE — `revokedAt`, once, from NULL — and the runtime
role holds SELECT, INSERT and UPDATE on it and never DELETE or TRUNCATE (`NO_DELETE_TABLES` in
`scripts/db-roles.mjs`).

**Permissions.** Minting takes `EDIT_CUSTOMERS` and a cashier may do it: handing over a card and
adding it to a wallet are the same moment at the counter. Revoking destroys something the customer
already holds, and reading a card's link history is reading their record, so both take
`EDIT_CUSTOMERS`/`VIEW_CUSTOMERS` **and not a cashier** — the same bar as the consent history.

**The public page shows a business name and nothing else.** No customer name, phone, card number,
serial, balance, programme, card link or scanner QR. Its QR encodes the page's own URL, which is
what a visitor hands to a friend. Its share targets are plain links — no SDK, no script, no app id,
no account — so nothing third-party is loaded onto it.

**It joins nobody to anything.** No form, no field, no enrolment, no lookup: public self-service
enrolment stays withdrawn (B7 option 3, §6.1.1), and a page reachable by a forwarded link is the last
place to reintroduce one. It also grants nothing — no stamp, no reward, no referral credit — because
no referral policy exists (§D15). The copy says "invite your friends" and "share the link", which is
what actually happens, and a unit test enforces that neither locale promises otherwise.

### 8A.10 Wallet passes

Apple `pass.json` and Google `loyaltyObject` payload builders exist, are fixture-tested, and are
**not signed and not delivered**: Apple needs a Pass Type ID certificate and Google a service-account
key, and this phase adds no secret or environment variable. Issuer identifiers are parameters filled
with visible placeholders in a preview, because a configuration decision written as a constant is a
configuration decision nobody made.

Where the invitation link goes, and where it must not:

| | Apple | Google |
|---|---|---|
| the link | a **back field** with `dataDetectorTypes: ["PKDataDetectorTypeLink"]` | `linksModuleData.uris[]`, the official tappable-link field |
| the barcode | the card's scanner `qrToken`, unchanged | the same, unchanged |
| the front of the card | **never** — front fields print on a lock screen | **never** — text modules render in the card body |

Apple renders **no button on the front of a pass**; a product claiming one would be describing an
interface the platform does not have.

**A pass already saved in a customer's wallet does not gain the link on its own.** There is no update
channel — Apple's needs `webServiceURL` and APNs, Google's needs the API — so the link appears when
the pass is issued again and saved again. The owner UI says this rather than implying otherwise.

Everything each platform offers, what Zademi uses and what it does not, is audited in
`docs/WALLET-CAPABILITY-MATRIX.md`, including the manual device gate (§6 there) that must be
completed before any production claim about wallet passes.

### 8A.11 Referral attribution (Phase 3A Prompt 2)

A member of staff enrolling a customer at the counter may record that the customer **presented a
valid invitation**. That is the whole feature: it records an arrival and grants nothing.

**The capability reaches the server in one place only** — the body of the authenticated counter
enrolment route. The scanner strips everything before the `#` on the device, so it never enters a
path, a query string or a log. It is hashed, resolved to a row id, and discarded; neither it nor its
digest reaches the row, an audit entry, a response or a screen.

**One generic refusal.** Invalid, revoked, malformed, another business's, the customer's own, and a
card that already carries an attribution all answer the same way. Staff are never told who referred
whom, and an unusable invitation never turns a successful enrolment into an error.

**Integrity.** One attribution per enrolled card, ever. Only for a card the call actually issued —
a customer who already had one was not referred today. Self-referral is refused where identity the
system already holds makes it safe to determine (the same profile, or the same underlying customer);
nothing beyond that is guessed, and §D19 is not answered here.

**Voiding** is owner or manager only, additive, and permanent in both directions: the original row
stays, a `VOIDED` row is written beside it, and the card cannot be attributed again — re-attributing
later would be retrospective attribution.

**What an owner sees** is a per-card fact on the enrolled customer's own record, and a business-wide
**count**. Nothing lists attributions, names a referrer or ranks anybody: that report is a list of
customers ordered by how many friends they brought, which belongs to a reward programme that does not
exist (§D15).

**Nothing is awarded.** No balance, ledger row, campaign or money changes, and both screens say so.

### 8A.12 Promotions and coupon redemption (Phase 3A Prompt 3)

An owner or manager writes an **offer** — a name only they see, a sentence describing what the
customer gets, and a **code**. A customer says the code at the counter. A cashier, with that
customer's card already on screen, types it in and is told the offer was **recorded for manual
fulfilment**. Then a person hands the thing over.

**Nothing is calculated.** There is no amount, percentage, currency, tax, invoice or total anywhere
in this feature, and there is no verb that changes money, points, stamps, balances, referral records,
campaigns or wallet passes, and nothing is sent. A redemption row says a named customer was owed a
described thing at a recorded moment. Both screens say so in both languages, and the browser suite
asserts they keep saying so.

**The code is never stored in the clear.** What is kept is
`sha256(per-promotion salt ‖ businessId ‖ normalised code)`. A coupon code is short and
human-typed — people say it out loud — so it is low-entropy in a way a 256-bit share capability is
not, and an unsalted digest column of short codes is a rainbow table away from being plaintext. The
salt costs something real and it is paid deliberately: the unique index can no longer see that two
promotions share a code, so creating one compares the candidate against every existing salt instead.
The raw code is not logged, audited, returned, rendered or stored after the request that carried it.

**Lifecycle.** `DRAFT → ACTIVE ↔ PAUSED`, and any of the three → `EXPIRED`, which is terminal. A
promotion is always created as a draft, whatever the caller asks for. Its identity and its code are
frozen from the first insert.

**Limits.** A global total and a per-customer total, each optional and each positive. Both are
enforced inside the redemption transaction under a row lock on the promotion, and again by a trigger
that recounts from the table — so a service that one day forgets the lock still cannot exceed them.
Limits are global and per customer only: there is no per-branch and no per-day cap (§D26).

**One generic refusal.** Unknown, malformed, expired, not yet started, paused, still a draft,
exhausted globally, exhausted for this customer, already used, or another tenant's — every one of
them answers identically. A cashier learns nothing from a refusal, which is the point when the secret
is four characters long. **An unusable coupon never fails the staff workflow it was typed into.**

**Voiding** is owner or manager only and additive: the `REDEEMED` row stays and a `VOIDED` row is
written beside it, carrying an optional reason. A void here **returns** the customer's entitlement —
voided rows count toward no limit — which is the opposite of a referral void, and deliberately so:
a mistyped coupon should be usable again, whereas re-attributing a referral later would be
retrospective attribution. What a void should mean when the item was already handed over is §D25.

**Who may do what.** Cashiers redeem. They may not create, edit, pause, activate, expire or void, and
the promotions screen returns 404 for them rather than an empty page. Owners and managers do
everything else. No one may read a code back.

**Nothing public was added.** No coupon lookup, no redemption page, no QR claim flow, no phone
lookup, and B7 is byte-identical. How a customer comes to know the code is the merchant's own
business today (§D22).

**The database refuses a wrong row without a service in the way.** Two triggers and a set of
constraints check tenant agreement across business, promotion, card and profile; the active state and
the window; both limits; one-time semantics; and that a void is a faithful copy of the row it
withdraws. `PromotionRedemption` is append-only at the grant level and `Promotion` cannot be deleted.

---

## 9. Deferred by design

Not in the MVP, sequenced in [PHASE-PLAN.md](PHASE-PLAN.md):

Cashback · discount · multipass · gift · membership · paid subscriptions · Apple and Google Wallet passes · geo-push · referral REWARDS · mini-games · RFM · advanced segments · workflow builder · email, SMS and WhatsApp campaigns · two-way inbox · POS integrations · public API · API keys · outbound webhooks · MCP server · GoHighLevel · agency white-label · franchise · billing · Employee Sales · AI onboarding · partner directory · managed service.

The ledger, identity, authorization and template models are designed so that none of these requires replacing the core.
