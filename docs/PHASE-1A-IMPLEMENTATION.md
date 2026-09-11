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

## 10. No migration

Phase 1a Prompt 1 adds **no schema change**. Every field it needs already exists from Phase 0:
`ProgramVersion.mechanics`, `RewardTier`, `UtmSourceLink.welcomeUnitQuantity`,
`CustomerCard.utmSourceLinkId`, the three card token columns and the balance projections. The index
review in `tests/integration/schema-review.test.ts` already covers every access path this phase
uses.
