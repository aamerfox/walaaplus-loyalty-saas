# Design matrix — `IntegrationEvent` transaction identity

Written **before** the migration, and every assumption in it verified empirically against this
project's own PostgreSQL and Prisma rather than taken from documentation or memory. The probe outputs
are quoted verbatim in §2.

---

## 1. The defect being corrected

Migration 14 (`20260920120000_integration_events`) proves that an event was written *in the same
transaction as the action it describes* by comparing two timestamps:

```sql
IF NEW."occurredAt" IS DISTINCT FROM redemption."recordedAt" THEN
  RAISE EXCEPTION 'IntegrationEvent: an event must be written in the same transaction as the thing it describes'
```

Both are assigned by triggers from `now()` — the transaction start time — and both columns are
`TIMESTAMP(3)`. Neither can be chosen by the caller. Within its own terms the rule is sound, and
migration 14 states its own residual accurately:

> The residual window is one millisecond: the columns are `TIMESTAMP(3)`, so a second transaction
> beginning within the same millisecond as the first would compare equal.

**Measured, not assumed.** 400 consecutive *separate* transactions, each `BEGIN; SELECT
now()::timestamp(3); COMMIT;`:

```
consecutive SEPARATE transactions sharing the same TIMESTAMP(3): 3 of 399 (0.8%)
```

Roughly 1 attempt in 125. A writer performing a backfill is not limited to one attempt, so retrying
reaches ~99% in about 600 tries. **Against a deliberate direct writer the rule is not a guarantee.**
It does still completely prevent what it was written for: an *old* redemption can never be matched,
because no new transaction will share a millisecond weeks in the past.

This was surfaced by a **failed Phase 4 engineering gate**, not by review.

---

## 2. Assumptions, and how each was verified

### 2.1 `pg_current_xact_id()` is stable across subtransactions — VERIFIED

Probe against this project's PostgreSQL, every transaction rolled back:

```
server_version: 15.15

A. top-level pg_current_xact_id()           = 1459
B. pg_current_xact_id() inside a SAVEPOINT  = 1459 (SAME — top-level)

C. xmin of each inserted row:
     id=1  xmin=1459  == top-level xid                      (true top level)
     id=2  xmin=1460  != top-level xid  <-- SUBTRANSACTION  (inside SAVEPOINT)
     id=3  xmin=1461  != top-level xid  <-- SUBTRANSACTION  (inside plpgsql EXCEPTION block)
     id=4  xmin=1459  == top-level xid                      (inside plpgsql, no EXCEPTION)
```

Two conclusions, and the second is why the earlier proposal was rightly rejected:

* **`pg_current_xact_id()` returns the top-level id at every nesting depth.** Comparing it against a
  value produced by the *same function* is therefore immune to savepoints.
* **`xmin` is the subtransaction id.** A row inserted inside a `SAVEPOINT`, or inside a PL/pgSQL block
  carrying an `EXCEPTION` clause, carries a different xid from its enclosing transaction. An `xmin`
  comparison would have **refused legitimate same-transaction writes**. Phase 3B was right to decline
  it, and this design is different in kind, not a retry of it.

### 2.2 Prisma's transaction path introduces nothing unsafe — VERIFIED

SQL captured from Prisma's own query log for an interactive transaction:

```
BEGIN
SELECT …
SELECT …
COMMIT

SAVEPOINT emitted anywhere: false
xid stable across statements in one interactive tx : true
now() stable across statements (transaction start) : true
```

The real write path is a single flat `prisma.$transaction(async (tx) => { … })` in
`src/server/promotions/redemption.ts`, with `emitIntegrationEvent(tx, …)` inside it.

**This is not a licence to depend on the absence of savepoints.** It records that Prisma does not
introduce one today; the design in §3 is correct whether or not that stays true, which is the whole
reason for choosing it.

### 2.3 No PL/pgSQL `EXCEPTION` block exists in any migration — VERIFIED

```
grep -rn "EXCEPTION WHEN" prisma/migrations/*/migration.sql   →  no matches
```

So no implicit subtransaction is created by this project's own trigger code. Again: the design does
not depend on this remaining true.

### 2.4 `xid8` is wraparound-free — VERIFIED (version) and relied upon

`SHOW server_version` → **15.15**. On PostgreSQL 13+, `pg_current_xact_id()` returns `xid8`: a 64-bit
transaction id that does not wrap. That is what makes it safe to *persist* and compare later, unlike
the 32-bit `xid` type.

---

## 3. The correction

| | Old | New |
|---|---|---|
| What is compared | `NEW."occurredAt"` vs `redemption."recordedAt"` | `redemption."writeXactId"` vs `pg_current_xact_id()` |
| Type | `TIMESTAMP(3)` | `xid8` |
| Exactness | equal within 1 ms | exactly equal or not |
| Chooseable by caller | no (overwritten) | no (overwritten) |
| Savepoint-safe | n/a | yes (§2.1) |

Both sides are produced by `pg_current_xact_id()`, assigned by triggers, and overwritten regardless of
what a caller supplies — the same discipline `recordedAt` and `occurredAt` already follow.

### 3.1 Legacy rows fail closed

`PromotionRedemption."writeXactId"` must be **nullable**: rows already exist on staging and nothing
may be backfilled. A guessed value would be a fabricated claim about when something happened.

A `NULL` therefore means *"this row predates the guarantee"*, and the event validation **refuses** it
with its own distinct message. That is not a regression: such a redemption could only ever have
received an event inside its own transaction, which ended before this migration existed. Refusing is
the backfill rule stated exactly.

### 3.2 Both event shapes are covered

The same-transaction check sits below the `expected_entry` mapping, so it already governs
`PROMOTION_REDEMPTION_RECORDED` **and** `PROMOTION_REDEMPTION_VOIDED`. Both are tested; fixing only
the redemption path would leave the withdrawal path bypassable.

### 3.3 Every migration-14 rule is preserved

The new function is built by **extracting migration 14's body and editing only the same-transaction
block**, not by retyping it. A diff of old against new is part of the evidence, so a silently dropped
rule is visible rather than trusted.

Preserved exactly: the server-assigned `occurredAt`; the event-type → entry mapping and its refusal;
"the redemption does not exist"; the tenant check; the entry-kind check; and the fatal fallthrough for
an unknown `entityType`. The append-only and no-truncate triggers are untouched.

**The timestamp comparison is kept as well as, not replaced by, the xid comparison.** It costs nothing,
it is a second independent statement of the same fact, and removing a working rule while adding
another is a larger change than this needs to be.

---

## 4. Migration ordering

Named `20260925130000_integration_event_transaction_identity` so it sorts **after** deployed migration
19 (`20260925120000_api_key_name_active_only`) and **before** the uncommitted Phase 4 migration
(`20260926120000_cashback_and_discount_core`).

This matters operationally: staging must be able to deploy this correction **without** deploying
incomplete Phase 4 work. Migrations 14–19 are byte-for-byte unchanged; both altered functions are
replaced with `CREATE OR REPLACE` in the new migration, never by editing an applied file.

---

## 5. What proof will and will not be accepted

Requirement 5 of the prompt, restated as the standard this work is held to:

* **No sleeps.** A pause that makes a test pass hides the window it was meant to expose.
* **No probability, no timing, no shared pool as proof.** "It failed 100 times in a row" is not a
  guarantee.
* **Determinism or nothing.** The cross-transaction test must construct the *exact* condition that
  defeats the old rule — two separate transactions whose `TIMESTAMP(3)` values are equal — and require
  refusal. If that condition cannot be constructed, the test must **fail as inconclusive**, never pass.

The deterministic construction available here is that `recordedAt` is written by a trigger from
`now()`, so a test can read a committed redemption's `recordedAt` and then, in a **separate**
transaction, use `SET LOCAL` / an explicit clock override or a directly inserted legacy-shaped row to
make the timestamps equal by construction rather than by racing. §6 of the evidence records which
construction was actually achievable.
