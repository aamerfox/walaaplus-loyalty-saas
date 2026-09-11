# WalaaPlus — Product Specification

Status: **Approved baseline for the rebuild.** Supersedes all prototype behaviour.
Owner: product owner. Last revised: Phase 0, Prompt 0.1.

Related documents: [PHASE-PLAN.md](PHASE-PLAN.md) · [BOOMERANGME-REFERENCE.md](BOOMERANGME-REFERENCE.md) · [DECISIONS-REQUIRED.md](DECISIONS-REQUIRED.md) · [PHASE-0-HYGIENE.md](PHASE-0-HYGIENE.md)

---

## 1. Product definition

WalaaPlus is an **Arabic-first, Syria-first digital loyalty and retention platform** for local businesses. It must work with no POS hardware, no wallet-pass availability, and no app-store distribution.

The customer product is an **installable PWA loyalty card**. The staff product is an **authenticated scanner** with QR and manual phone lookup.

The complete MVP loop:

```
Merchant creates a loyalty program
  → Customer joins through a QR or link
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
Latitude and longitude are reserved for geo-push in a later phase.

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
`status`: `DRAFT`, `ACTIVE`, `PAUSED`, `ARCHIVED`. `PAUSED` blocks **new enrollment** while existing cards continue to scan and redeem normally.

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

### UtmSourceLink
```
id, templateId, name, publicToken (unique), utmSource, utmMedium,
utmCampaign, welcomeUnitQuantity, welcomeBonusExpiresAfterDays,
enrollmentTitle, enrollmentImageUrl, active, createdAt, updatedAt
```

Every template gets a default link named **Direct** with `utmSource = direct` at creation. There is no separate generic enrollment token, so **every issued card always carries source attribution**.

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

```
Public QR or link carrying a UtmSourceLink publicToken
  → resolve source → template → business
  → Arabic RTL enrollment form
  → mandatory phone, consent capture
  → match or create Customer by normalized phone
  → match or create CustomerBusinessProfile
  → issue CustomerCard (unique per profile+template)
  → card issuance recorded in AuditLog; WELCOME_BONUS operation when configured
  → PWA install guidance
  → customer opens their card
```

**Card issuance is audited, not ledgered.** An earlier draft of this flow wrote a `CARD_ISSUED`
operation. The ledger refuses zero-quantity rows — that invariant is what makes every ledger row a
real movement of value — and issuing a card moves none. A `+0` row would break the invariant and a
`+1` row would inflate a balance to represent an event that granted nothing. Issuance is therefore
recorded by `CustomerCard.issuedAt`, `CustomerCard.utmSourceLinkId` and an `AuditLog` entry; the
`CARD_ISSUED` kind is unused. A welcome bonus, which does move value, remains a real operation.
See [PHASE-1A-IMPLEMENTATION.md](PHASE-1A-IMPLEMENTATION.md) §4.

Requirements: no merchant login anywhere in the path; high-entropy public tokens; idempotent enrollment; per-source welcome bonus overrides the template default; exact consent text version stored; required and unique enrollment fields validated; rate limiting and a honeypot field, because welcome bonuses make enrollment an abuse target.

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
- **Security**: no hardcoded fallback secrets anywhere; environment validation at startup that fails fast; Argon2 or bcrypt password hashing; HTTP-only session cookies; rate limits on login, enrollment, and scanner writes; validated request bodies; encrypted external credentials; no secrets in logs.

---

## 9. Deferred by design

Not in the MVP, sequenced in [PHASE-PLAN.md](PHASE-PLAN.md):

Cashback · discount · multipass · coupon · gift · membership · paid subscriptions · Apple and Google Wallet passes · geo-push · referrals · promotions · mini-games · RFM · advanced segments · workflow builder · email, SMS and WhatsApp campaigns · two-way inbox · POS integrations · public API · API keys · outbound webhooks · MCP server · GoHighLevel · agency white-label · franchise · billing · Employee Sales · AI onboarding · partner directory · managed service.

The ledger, identity, authorization and template models are designed so that none of these requires replacing the core.
