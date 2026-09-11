# Phase 1a — Stamp-Café Core (Prompt 1)

The server-side domain for one real café loyalty loop: one stamp program, one counter, an owner
and their cashiers, customers who enrol with a Syrian phone number, and stamps that turn into free
coffees. Pages and route handlers are Prompt 2; this document describes the services they call.

Phase 0 material it builds on: [PHASE-0-IMPLEMENTATION.md](PHASE-0-IMPLEMENTATION.md).

---

## 1. What is in scope

| In Phase 1a Prompt 1 | Deliberately not |
|---|---|
| Stamp cards only | Points, cashback, discount, coupon, gift, membership |
| One default `Main` location, **resolved by the server** | Multi-location programs, a location picker, geo rules |
| Owner + cashiers | Managers as staff administrators, permission editor |
| The `direct` enrollment source | Named UTM campaigns, referrals, promotions |
| Enrollment by Syrian mobile number | Email or social identity, OTP restore |
| Manual, visit and purchase awards | Automatic redemption on scan, kiosk mode |
| Redemption and reversal | "Edit transaction" (there is no such thing) |
| Customer and operation queries | Segments, RFM, exports |
| — | Expiry, birthday bonuses, push, integrations, public API |

Deferred mechanics are not merely unimplemented — they are **refused**. See §2.

---

## 2. Mechanics are a contract, not a JSON blob

`ProgramVersion.mechanics` is a JSON column, and JSON columns rot: a typo becomes a silently
absent rule and a later phase's field becomes an `any` three services deep. So nothing reads that
column directly. `src/server/program/mechanics.ts` owns a strict Zod contract, and every consumer
takes the parsed type.

Phase 1a settings, and nothing else:

```
kind: "STAMP"              contractVersion: 1
stampsRequiredPerReward    rewardName          rewardDescription?
rewardValueMinor?          earnMode            spendAmountPerBlockMinor?
stampsPerBlock?            requirePurchaseAmount   dailyAwardLimit?
countRewardRedemptionAsVisit                    welcomeStamps?
```

`earnMode` is `MANUAL`, `PER_VISIT` or `SPEND_BLOCK`. The two spend fields are required for
`SPEND_BLOCK` and refused for the others, so a program cannot be half-configured.

**The schema is strict.** An unknown key is an error, not a value to ignore: `pointsPerVisit`,
`cashbackPercent`, `cardExpiryMode`, `birthdayStamps`, `referralBonusStamps`, `availableLocations`
and a plain typo like `stampsRequiredPerRewards` are all rejected at the boundary. A merchant who
typed a rule that the engine ignores would believe it was in force; that is the failure this
prevents.

Two readers, on purpose:

| Function | For | On failure |
|---|---|---|
| `parseStampMechanics` | merchant input, at program creation | `ValidationError` (400) with field issues |
| `readStampMechanics` | mechanics already stored on a version | `LedgerInvariantError` (422) naming the version |

The second never falls back to a default. A corrupt or foreign version (a points program handed to
the stamp engine) stops the operation, because guessing a threshold would hand out the wrong number
of rewards.

**A welcome bonus may not complete a card on its own** (`welcomeStamps < stampsRequiredPerReward`).
Otherwise anyone who enrols walks away with a free coffee.

---

## 3. Creating the program

`createStampProgram` writes four things in one transaction, in the order the database forces:

1. `ProgramTemplate`, `cardType = STAMP`, status `ACTIVE`;
2. `ProgramVersion` 1, status **DRAFT**;
3. the `RewardTier` for the program's single reward — `reward_tier_protect` refuses a tier once
   its version leaves DRAFT, so this must happen before activation;
4. the version is **activated**, freezing mechanics and tier for every card that will pin it;
5. the `direct` `UtmSourceLink` with an opaque `publicToken`.

Requires `EDIT_TEMPLATES` (owner or manager; not a cashier). The transaction takes
`SELECT … FOR UPDATE` on the business row first, so two owners clicking at once cannot both pass
the "already has a program" check.

**One live program per business** is a Phase 1a pilot rule enforced in the service, not a database
constraint, because Phase 1b lifts it and a constraint would then have to be dropped.

**One location.** The program resolves the business's default `Main` location at creation and the
whole phase operates there. `availableLocations` is not part of the contract. §7.1 explains how
that is enforced at write time.

---

## 4. Card issuance is audited, not ledgered

PRODUCT-SPEC §6.1 sketches a `CARD_ISSUED` operation alongside `WELCOME_BONUS`. **There is no such
row, deliberately.**

The Phase 0 ledger refuses zero-quantity operations, which is what makes every ledger row a real
movement of value. Issuing a card moves nothing. Writing a `+0` row would break that invariant, and
writing a `+1` row would inflate a balance to represent an event that granted nothing — a fake
award, which is exactly what the prompt's "do not create fake zero-value awards merely to represent
issuance" rules out.

Issuance is therefore recorded where the question is actually answered:

| Question | Answered by |
|---|---|
| When was this card issued? | `CustomerCard.issuedAt` |
| Which link did the customer come through? | `CustomerCard.utmSourceLinkId`, `CustomerBusinessProfile.utmSource` |
| Who issued it, and under what program version? | `AuditLog` `card.issued`, with template, version, profile and source |

The `CARD_ISSUED` enum value stays unused in Phase 1a. A welcome bonus, which *does* move value,
is a real `WELCOME_BONUS` ledger row.

---

## 5. Phone identity

`Customer.normalizedPhone` is unique and is the global identity, so every accepted spelling of one
number must collapse to exactly one string. If two survive, one person becomes two customers with
two cards and two balances, and nothing later puts that back together.

Accepted: `+963 944 123 456`, `00963944123456`, `963944123456`, `0944123456`, `944123456`, with any
spacing, dashes, dots or parentheses, and Arabic-Indic digits (`٠٩٤٤…`), which is what an Arabic
keypad produces.

Refused, rather than guessed:

- **foreign numbers**, with a distinct message — silently truncating `+9715…` into a Syrian-looking
  number would merge two different people;
- **Syrian landlines**. They are valid numbers, but the product delivers the card and its restore
  link over mobile messaging, so a landline creates an identity that cannot receive the thing it
  identifies. Recorded as a limitation in the evidence;
- lengths that could be read two ways, and anything with unexpected characters.

`tryNormalizeSyrianPhone` is the non-throwing variant for search boxes, where a half-typed query is
simply no match.

---

## 6. Enrollment, and why it is written with `ON CONFLICT DO NOTHING`

`enrollCustomer` is **public**: no session, no tenant context, no merchant login anywhere in the
path. The link's opaque token is the only input that says which program is being joined, and every
business fact is derived from it.

Two taps on a slow connection, or a customer and a cashier enrolling the same person at once, must
produce one customer, one profile and one card. Prisma's `upsert` is read-then-write and loses that
race, and catching `P2002` inside a transaction is useless because the transaction is already
poisoned. So each of the three rows is inserted with `INSERT … ON CONFLICT DO NOTHING RETURNING`:
the statement waits for a competing transaction, then does nothing, and the follow-up `SELECT` sees
the committed row. The inserts always run in the same order — customer, profile, card — so
concurrent enrollments queue rather than deadlock.

**The card insert is the arbiter of the welcome bonus.** `RETURNING id` yields a row only for the
transaction that actually inserted the card, so exactly one caller writes the welcome stamps, in
the same transaction. No idempotency key is involved, so the bonus cannot be duplicated by a retry
that forgot one or lost by a retry that reused one.

A repeat enrollment **does not overwrite the stored name or consent**. Anyone can open a public
enrollment form and type someone else's number; letting a second submission rewrite the first would
let a stranger rename a profile or flip its marketing consent.

Welcome stamps are written with a system actor and source `ENROLLMENT`, so the Phase 0 visit policy
records `countsAsVisit = false` without anyone having to say so: nobody came in.

---

## 7. The stamp engine

`src/server/stamp/engine.ts` is the only way loyalty value changes. Routes never build ledger rows.

| Verb | Kind | Notes |
|---|---|---|
| `awardManualStamps` | `MANUAL_AWARD` | allowed in every earn mode: a café always needs "the tablet was down" |
| `awardVisitStamp` | `VISIT_AWARD` | requires `PER_VISIT`; grants exactly one stamp |
| `awardPurchaseStamps` | `PURCHASE_AWARD` | requires `SPEND_BLOCK`; whole blocks only |
| `redeemReward` | `REWARD_REDEEMED` | `-1` reward; never touches stamps |
| `reverseStampOperation` | `REVERSAL` | delegates to the Phase 0 compensating-entry flow |

Every one of them:

1. runs under `runIdempotent` with a caller-supplied key, because each is triggered by a person
   tapping a phone at a counter on a bad network, and the tap will be repeated;
2. **locks the card row first**, then reads balances and counts today's awards under that lock, so
   two cashiers serving the same customer cannot both pass a check only one should pass;
3. reads mechanics from the version **pinned to the card**, never the program's current version;
4. writes one atomic group through `appendOperationGroup`, which derives business and acting user
   from the verified actor and refuses a caller-supplied `transactionGroupId`.

### 7.1 The location is not an input

Phase 1a is one café at one counter, so **no verb accepts a `locationId`**. Every award,
redemption and reversal attributes to the business's default `Main` location, resolved inside the
transaction from the business itself. Supplying one anyway — which untyped JavaScript can still
do — is refused before anything is validated or written, including when the value supplied is the
correct one: the rule is about who decides, not about which id arrives.

This is a **scope boundary, not a security boundary**. `requireLocationAccess` already stops a
cashier acting outside their assignment, but an `OWNER` is unrestricted across their own
locations, so without this rule a second counter could appear in the ledger and Phase 1b's
multi-location work would begin by accident, underneath screens that were never designed for it.

Phase 1b adds the parameter back deliberately, together with the program's `availableLocations`
and a location picker. Until then, a second `Location` row may exist in the database and simply
receives no operations.

### Conversion

Immediate, atomic, remainder carried forward, several rewards from one award (PRODUCT-SPEC §5.3):

```
transactionGroupId: <server-generated>
MANUAL_AWARD     STAMP   +5    balanceAfter 13
STAMP_CONVERTED  STAMP  -10    balanceAfter  3
REWARD_EARNED    REWARD  +1    balanceAfter  1
```

Quantities carry the multiplicity: a 25-stamp award on a 10-stamp program writes one
`STAMP_CONVERTED −20` and one `REWARD_EARNED +2`, not four rows.

### Spend blocks

Floor-rounded, **no remainder carry-over** (PRODUCT-SPEC §5.5). At 1 stamp per 10,000 minor units,
25,000 earns 2 and the 5,000 is discarded; two separate 5,000 purchases earn nothing at all. A
purchase too small to complete a block is refused rather than written as a zero-quantity row.

All money is integer minor units. A float is refused at the boundary.

### Daily limits

`dailyAwardLimit` counts award **operations** per card per **business-timezone day** — one award of
five stamps is one award. The window is computed as absolute UTC instants from the business's IANA
zone (`src/server/time/business-day.ts`), so the query stays
`createdAt >= start AND createdAt < end` and uses `LoyaltyOperation_customerCardId_createdAt_idx`.
A `("createdAt" AT TIME ZONE …)::date = …` predicate would be correct but unindexable on the
highest-volume table. The midnight conversion re-resolves the offset at the candidate instant, so
DST transition days give 23- and 25-hour days rather than landing an hour into the neighbouring one.

### Cards that may not transact

`PAUSED`, `EXPIRED` and `DELETED` are refused, and so is any card whose `expiresAt` has passed
regardless of status — the scheduled expiry job is Phase 1.5, so until it runs the date on the card
is what counts. `ISSUED` and `ACTIVE` may transact; `ISSUED` means enrolled but not yet opened.

---

## 8. Authorization

Resolved from the database on every request, never from the session token.

| Action | Requires |
|---|---|
| Create the program | `EDIT_TEMPLATES` (owner, manager) |
| Read the program | `VIEW_TEMPLATES` |
| Create a cashier | **role `OWNER`** — not a permission bit |
| Award, redeem | `MAKE_ACCRUALS` / `MAKE_REDEMPTIONS`, plus location access |
| Reverse | both accrual and redemption permissions |
| Look up by QR, phone, serial | `VIEW_CUSTOMERS` |
| Browse the customer directory | `VIEW_CUSTOMERS` **and** role owner or manager |
| Read a card's operations | `VIEW_OPERATIONS`, narrowed to assigned locations |

Cashier creation checks the **role**, so it cannot be widened by granting `EDIT_STAFF` to a
manager. A cashier holds `VIEW_CUSTOMERS`, but that is scoped to "the scanned or searched customer"
(PRODUCT-SPEC §3): they can serve whoever is at the counter, not export the customer list. A
cashier with no location assignment has `locationIds: []`, which is a denial everywhere, never
"unrestricted".

Every lookup is **filtered** by `businessId`, not checked afterwards, so another business's card,
token or phone number is `NotFoundError` — the same answer as a value that does not exist. A
merchant who could tell "not found" from "forbidden" could use a competitor's QR code to confirm
that a person is their customer.

---

## 9. Contended transactions

`CONTENDED_TX` in `src/server/db.ts` raises Prisma's 2-second `maxWait` to 10 s for enrollment,
program creation and cashier creation. Those paths queue **by design** — six people enrolling one
phone number serialise on a unique index, and that serialisation is the mechanism keeping them from
becoming six customers. They should wait and then succeed, not error. The statement timeout still
bounds a transaction that is genuinely stuck.

---

## 10. The screens (Prompt 2)

Pages and route handlers call the services above. None of them builds a ledger row, writes a
balance, or reaches for Prisma to change anything.

### 10.1 Public enrollment — `/{locale}/join/{token}`

No session anywhere in the path. The opaque link token is the only input; business, program and
offer are derived from it. The page shows the business name, the program, the offer and any
welcome bonus — nothing else, and no identifier.

`POST /api/enroll` adds the two controls a public write needs (PRODUCT-SPEC §6.1):

- **A database-backed rate limit**, per client address and per link, reusing the Prompt 0.3
  limiter. The per-link window is what holds when no trusted proxy supplies an address, and it
  matches the actual threat: farming a welcome bonus means hammering one merchant's link.
- **A honeypot field**, hidden with the clip-based `sr-only` pattern rather than `display:none`
  (which many bots skip) and rather than a large negative offset — that pushes the document's edge
  and, in RTL, moves every other control out from under the pointer. A filled honeypot is answered
  like an ordinary failure and still counts against the rate limit, so a script pays for being
  caught and learns nothing.

**No enumeration.** A first enrollment and a repeat return the same status and the same body. The
response carries the card's page token and nothing else — no ids, no phone number, and no `created`
flag that would say "you were already a customer here".

### 10.2 The customer card — `/{locale}/card/{shareToken}`

Addressed by the **page** token, never the scanner token: a cashier who scanned a QR still cannot
open the customer's card. The view returns no internal identifier of anything, and the page offers
no action — awards, redemptions and reversals are staff operations behind a session.

The QR is rendered as **inline SVG on the server**. The alternative a prototype reaches for is an
image URL from a third-party QR service, which sends the card's scanner token to someone else on
every page view; that was removed from this codebase once already in Phase 0.3.

### 10.3 PWA foundation

Installability, and nothing more.

| Piece | Where | Note |
|---|---|---|
| Manifest | `/{locale}/card/{token}/manifest.webmanifest` | **Per card**: `id`, `start_url` and `scope` are that card's path, so three cards install as three apps (PRODUCT-SPEC §6.2). Carries only the business and program name |
| Service worker | `public/sw.js`, registered with the card's path as its scope | **Caches nothing.** No `fetch` handler at all |
| Icons | `public/icons/*.png`, generated by `scripts/make-icons.mjs` | Committed; the script runs when the artwork changes, never in the gate |

The worker is deliberately almost empty. A card page carries a balance, a name and a scanner
token; a cache-first strategy would leave that in cache storage after the customer stops using the
card and would serve a stale balance that disagrees with the counter — the one thing a loyalty card
must never do. Caching an authenticated staff response would be worse.

**Not claimed:** offline card state, web push, VAPID keys, `lastOpenedAt`, install telemetry and
card restore. All Phase 1.5. An installed card is an ordinary online page in an app window.

### 10.4 Scanner — `/{locale}/scanner`

Mobile-first, for a cashier who uses it all day. QR and phone lookup are equal first-class paths
(PRODUCT-SPEC §7): a delivery business never sees the customer's screen.

- Every mutating call carries a **client-generated idempotency key**, minted once per intent and
  reused by a retry.
- **No location anywhere**: no picker, no field, no hidden default. The server resolves `Main`, and
  a request that names a location is refused at the HTTP boundary before it reaches a service —
  including a location nested one level down or spelled `location`.
- **Conflicts are translated from a code**, not from a server message: `NO_REWARD_AVAILABLE`,
  `DAILY_LIMIT_REACHED`, `CARD_NOT_TRANSACTABLE`, `ALREADY_REVERSED`, `IDEMPOTENCY_CONFLICT`. An
  Arabic screen must never print an English sentence from an API.
- The camera uses the browser's own `BarcodeDetector` where it exists and degrades to the
  paste/type field everywhere else, including iOS Safari. No camera library is bundled, and **no
  automated test claims a physical scan** — the field accepts a decoded token, which is what the
  end-to-end journey drives.

Authorization is resolved three times on the way to a write: the proxy refuses an anonymous
request, the page re-reads the membership, and the API route does it again. A page that "already
checked" is not an authorization for a route.

### 10.5 Owner screens

`/{locale}/business/customers` (list with phone-normalised search and cursor paging),
`/{locale}/business/customers/{cardId}` (card balances and the immutable operation history), and
`/{locale}/business/team` (the owner-only cashier form and a read-only staff list). Every one reads
through a tenant-scoped service; no page queries Prisma.

The sidebar shows only routes that exist. The remaining prototype pages stay hidden.

### 10.6 Tests

`npm run gate` keeps unit and integration. Browser tests are a **separate command**,
`npm run test:e2e`, and a separate CI workflow (`.github/workflows/e2e.yml`): a browser run needs a
production build, a server and a database, and folding it into the gate would make the fast loop
unusable.

The end-to-end server runs the **standalone build** — the artifact the Dockerfile ships — because
`next start` does not support `output: standalone`, and because a missing static asset in that
assembly should fail a test rather than a deployment.

---

## 11. No migration

Phase 1a Prompt 1 adds **no schema change**. Every field it needs already exists from Phase 0:
`ProgramVersion.mechanics`, `RewardTier`, `UtmSourceLink.welcomeUnitQuantity`,
`CustomerCard.utmSourceLinkId`, the three card token columns and the balance projections. The index
review in `tests/integration/schema-review.test.ts` already covers every access path this phase
uses.
