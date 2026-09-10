# Boomerangme Capability Reference and WalaaPlus Phase Mapping

Compiled from the full Boomerangme documentation set (187 pages via `docs.boomerangme.cards/llms.txt`) and the machine-readable API v2 OpenAPI 3.0 specification at `api.digitalwallet.cards/api/v2/docs/json` (136 schemas, ~150 endpoints).

**Boomerangme is a feature reference, not an implementation source.** WalaaPlus builds a simpler, Syria-first product in deliberate phases. Every capability below carries its WalaaPlus phase, or is marked **deferred indefinitely** where it does not fit the market.

Phase definitions live in [PHASE-PLAN.md](PHASE-PLAN.md). Architecture decisions live in [PRODUCT-SPEC.md](PRODUCT-SPEC.md).

---

## 1. Platform shape

Three account tiers, each a "company" in their API:

| Tier | Purpose | WalaaPlus phase |
|---|---|---|
| Business sub-account | One merchant: templates, customers, cards, staff, locations | **Phase 0–1b** |
| Agency | White-label reseller creating and billing sub-accounts | **Phase 5** |
| Franchise | One brand, many branches, shared card | **Phase 5** |

---

## 2. Loyalty card types

Boomerangme type ids: Stamp 0, Cashback 1, Multipass 2, Coupon 3, Discount 4, Gift 5, Membership 6, Reward 7.

| Type | Core mechanic | WalaaPlus phase |
|---|---|---|
| **Stamp** | Earn per visit, per spend block, or manually; reward at threshold; multi-reward milestones; auto-redeem option | **Phase 1a** |
| **Reward (points)** | Points per visit or spend; unlimited reward tiers with thresholds, usage limits, segment and UTM eligibility | **Phase 1b** |
| **Cashback** | Percentage of purchase becomes spendable points; up to 6 progressive spend tiers; happy hours | **Phase 4** (may pull into Phase 2 on validated retail or pharmacy demand) |
| **Discount** | Instant percentage; up to 6 progressive spend tiers | **Phase 4** (same condition) |
| **Multipass** | Prepaid visits; add and redeem visits; optional points per visit used | **Phase 4** |
| **Coupon** | One-time redemption; converts into a linked loyalty card on redeem | **Phase 4** |
| **Gift** | Prepaid balance; single or multiple use; sold online via Stripe | **Phase 4**, online sale requires a payment provider |
| **Membership** | Club pass with tiers, periods, limits, trial, renewal; Stripe subscription | **Phase 4** free variant only; paid deferred to **Phase 5** |

### Template mechanics common to all types

| Capability | Phase |
|---|---|
| Barcode type (QR, PDF417) | **Phase 1a**, QR only. PDF417 deferred |
| Card expiry: unlimited, fixed date, N days after issue | **Phase 1.5** |
| Whole-balance inactivity expiry | **Phase 1.5** |
| Per-stamp and per-point FIFO lot expiry | **Deferred**, see spec §5.7 |
| Welcome bonus on issue or first visit | **Phase 1a** |
| Birthday bonus | **Phase 2**, needs the job runner |
| Happy hours multiplier window | **Deferred** |
| Daily earn limit, one check-in per day | **Phase 1a** |
| Custom enrollment form fields, required and unique | **Phase 1a** |
| UTM links with per-link welcome override, title and image | **Phase 1a** direct link; **Phase 1b** named links |
| Localization, date format, currency, separators, phone mask | **Phase 1a** for locale and currency |
| Legal: privacy policy, consent checkbox, terms of use | **Phase 1a** |
| Issuer info and back-of-card active links | **Phase 1a** |
| Feedback links shown after star rating | **Phase 2** |
| Platform toggles: Google Wallet, PWA | **Phase 1a** PWA only |
| Card face configurable fields | **Phase 1b** |
| Scanner mechanics: require purchase sum, daily limits | **Phase 1a** |
| Analytics scripts, GA and Meta Pixel | **Deferred** |
| Cards limit, test mode capped at 10 installs before activation | **Phase 1b** |
| Activation locks core mechanics | **Phase 1a**, spec §2.5 |
| Design: logo, icon, background, stamp images, colours | **Phase 1a** basic, **Phase 1b** full |

---

## 3. Issued card and ledger

| Capability | Phase |
|---|---|
| Card serial, install link, share link, QR link, direct install links | **Phase 1a** |
| Device channel: Apple Wallet, Google Wallet, Google Pay, PWA | **Phase 1a**, PWA only |
| Card status: installed, not installed, deleted | **Phase 1a** |
| Per-card counters: visits, rewards earned and redeemed, referral totals, last-activity dates | **Phase 1a–1b** |
| Operation ledger with purchase sum, running balance, source, manager, location | **Phase 0** engine, **Phase 1a** in use |
| Twenty balance operations by card type | Phased with each card type |
| Reversal as compensating entry | **Phase 0** |
| Transaction export with 15 columns | **Phase 2** |

WalaaPlus adds three things Boomerangme does not expose: `transactionGroupId` for atomic multi-row operations, a separate `IdempotencyRecord` table, and an immutable `countsAsVisit` flag.

---

## 4. Scanner

| Capability | Phase |
|---|---|
| QR scan, search by name, phone, email, serial | **Phase 1a** |
| Per-type award and redeem actions | Phased with each card type |
| Purchase amount and internal comment | **Phase 1a** |
| Manager login with permissions and location binding | **Phase 1a** minimal cashier, **Phase 1b** full |
| Kiosk mode with duplicate-accrual guard | **Deferred** |
| Scanner settings: beep, show result, clipboard, debug | **Deferred** |
| White-label scanner branding | **Phase 5** |
| Promotion redemption | **Phase 3a** |
| 24-hour session expiry | **Phase 1.5** |

---

## 5. CRM

| Capability | Phase |
|---|---|
| Customer list with cards, balances, UTM, device, custom fields | **Phase 1a** basic, **Phase 1b** full |
| Customer profile with per-card stats and manual balance actions | **Phase 1b** |
| Edit transaction purchase sum | **Phase 2** |
| Change card status, edit expiry | **Phase 1.5** |
| Copy install and referral links | **Phase 1a** install, **Phase 3a** referral |
| Send push to one customer | **Phase 1.5** |
| CSV import with balance preservation, max 20k rows | **Phase 2** |
| Export customers, per-template customers, transactions | **Phase 2** |
| Bulk card issue with SMS or email delivery | **Deferred**, needs messaging channels |
| 22 filter parameters with AND/OR groups | **Phase 2** basic filters |
| Saved segments used for push, rewards and automations | **Phase 2** |
| RFM 3×3 segmentation with configurable buckets | **Deferred to Phase 2+**, listed under analytics |
| Gender auto-detection from name | **Deferred indefinitely** |

---

## 6. Engagement

| Capability | Phase |
|---|---|
| Manual push to all or to a segment | **Phase 1.5** basic, **Phase 2** segments |
| Scheduled push with history and bulk delete | **Phase 2** |
| Push to an individual customer | **Phase 1.5** |
| Push automation: feedback request, next-visit reminder, birthday | **Phase 2** |
| Triggered custom auto-push with delay | **Phase 6** workflow builder |
| Transactional push on balance change | **Phase 1.5** |
| Geo-push within ~100 m, iOS only, 10 locations per pass | **Deferred**, location lat/lng reserved in schema |
| AI behaviour-based push with control and active groups | **Phase 6** |
| Feedback collection: star rating, low-rating comment, Google redirect | **Phase 2** |
| Referral share link and QR with configurable rewards | **Phase 3a** |
| Promotions that reskin the card, with limits and scheduled pushes | **Phase 3a** |
| Wheel of Fortune mini-game, review-gated, prize odds | **Deferred indefinitely** |
| Marketing kit: 11 print materials generated from card design | **Phase 3a** simplified |
| A4 PDF table tent and QR download | **Phase 3a** |
| Mailings by SMS and email with placeholders | **Deferred**, needs messaging providers |
| WhatsApp, Telegram, Messenger bots | **Phase 6** |

WalaaPlus replaces OneSignal with native VAPID web push, since the PWA card is the only delivery channel and OneSignal adds a third-party dependency with possible sanctions exposure.

---

## 7. Analytics

| Capability | Phase |
|---|---|
| Visits, new versus repeat customers, referrals, last period | **Phase 1b** |
| Transactions per day, average order value | **Phase 1b** |
| Retention rate at 60, 120, 240 days | **Phase 2** |
| Feedback metrics | **Phase 2** |
| Referral metrics and top-10 lists | **Phase 3a** |
| Customer profile charts: gender, device, age | **Deferred** |
| Gross revenue split by loyalty, referral, non-loyalty | **Phase 2** |
| ROI, CLV, total investment, rewards cost | **Phase 2** |
| Enrollment rate, engagement rate, churn, activity heatmap | **Phase 2** |
| Points analytics, RFM distribution, real-time timeline | **Phase 2** |
| Weekly report by email or Telegram | **Deferred** |
| Per-template reward and UTM statistics | **Phase 1b** UTM, **Phase 2** rewards |

---

## 8. Team and permissions

| Capability | Phase |
|---|---|
| Manager accounts with email, phone, note, location binding | **Phase 1a** minimal, **Phase 1b** full |
| 20+ granular permissions | **Phase 1b** |
| Manager transaction history and downloadable activity | **Phase 1b** |

WalaaPlus uses global `User` plus `BusinessMembership` rather than business-embedded staff, so one person can hold roles in several businesses. This is a deliberate divergence required by the agency and franchise roadmap.

---

## 9. Agency, white-label, franchise

| Capability | Phase |
|---|---|
| Sub-account creation, statuses, trial reset, SSO switching, search, export | **Phase 5** |
| Snapshots: ready-made template sets by niche | **Phase 5** |
| Plans with limits and option flags, custom pricing, hidden plans | **Phase 5** |
| Payments: MRR, renewals, overdue, Stripe only | **Phase 5**, blocked on payment provider decision |
| White-label domain via CNAME with SSL | **Phase 5** |
| Dashboard, scanner and promo-page branding | **Phase 5** |
| Sub-account menu visibility control | **Phase 5** |
| Agency promo page and proposal pages | **Phase 5** |
| Prospecting with Google Places and AI cold email | **Phase 6** |
| Franchise card duplicated across branches, leaderboard, scheduled reports | **Phase 5** |
| Partner plan with revenue share and ZIP territories | **Phase 6** |

---

## 10. Platform and integrations

| Capability | Phase |
|---|---|
| Public API v2 with `X-API-Key`, 10 req/s per key | **Phase 3b** |
| Multiple API keys with rename, revoke, rotation | **Phase 3b** |
| Response envelope and list pagination | **Phase 3b** |
| Outbound webhooks with HMAC `X-Signature`, ~40 event types | **Phase 3b** |
| Marketplace apps with POS accrue and reverse endpoints | **Phase 3b** one validated connector only |
| MCP server with OAuth 2.1 and scoped tools | **Phase 6** |
| GoHighLevel: OAuth install, contact sync, custom fields, SSO menu, workflow actions and triggers | **Phase 3b** private app, **Phase 5** public listing |
| Toast, Square, Shopify, Lightspeed, GloriaFood, Altegio, WooCommerce | **Phase 3b** on validated demand only |
| Zapier, Make, Pabbly, Integrately, Albato, KonnectzIT | **Deferred**, reachable through webhooks |
| ActiveCampaign, ManyChat, UChat, Vendasta | **Deferred** |

---

## 11. Deliberate divergences from Boomerangme

| Area | Boomerangme | WalaaPlus | Reason |
|---|---|---|---|
| Primary wallet | Apple and Google Wallet, PWA third | PWA first, passes optional later | Google Wallet unavailable in Syria; Apple signing impractical |
| Push provider | OneSignal and pass push | Native VAPID web push | Removes third-party dependency and sanctions exposure |
| Staff identity | Manager embedded in company | Global user plus membership | One person may serve several businesses, agencies, branches |
| Template versioning | Mechanics lock, design pushes live | Same, but explicit `ProgramVersion` split | Boomerangme documents stale-stamp-count failures caused by conflating the two |
| Idempotency | Kiosk duplicate-scan guard | Explicit `IdempotencyRecord` on every write | Unstable mobile internet in the target market |
| Unit expiry | Per-stamp FIFO countdown | Whole-balance inactivity expiry | Lot tracking is disproportionate for the MVP |
| Barcode | QR and PDF417 | QR only | Simplifies the locked card identity format |
| Currency | Per-company with USD-centric billing | Integer minor units, currency on business | SYP has no meaningful subunit and large values |

---

## 12. Sources

- Documentation index: `https://docs.boomerangme.cards/llms.txt` — append `.md` to any page URL for raw markdown
- API reference: `https://docs.digitalwallet.cards` — underlying spec at `https://api.digitalwallet.cards/api/v2/docs/json`
- GoHighLevel integration: `https://docs.boomerangme.cards/integrations/highlevel`
- HighLevel OAuth: `https://marketplace.gohighlevel.com/docs/Authorization/OAuth2.0/`
- HighLevel webhooks: `https://marketplace.gohighlevel.com/docs/webhook/WebhookIntegrationGuide/`
