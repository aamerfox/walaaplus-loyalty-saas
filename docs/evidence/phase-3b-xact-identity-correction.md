# Foundation correction — `IntegrationEvent` transaction identity

| | |
|---|---|
| Branch | `fix/integration-event-xact-identity` (isolated worktree) |
| Baseline | `39fe9be8fbd55325e1872438b1fdd905357a7ee5` |
| Migration | **`20260925130000_integration_event_transaction_identity`** — ordered after deployed 19, **before** the in-progress Phase 4 migration |
| Migrations 14–19 | **byte-for-byte unchanged** — `git diff` against the baseline over `prisma/migrations/` is empty |
| Design matrix, written first | `docs/PHASE-3B-XACT-IDENTITY-DESIGN-MATRIX.md` |
| Staging | **not contacted.** No external network call, no provider, no device, no real data |

---

## 1. How this was found

**A Phase 4 engineering gate failed on a clean database** — 10 of 16 steps — on one test:

```
tests/integration/integration-events-integrity.test.ts
  > an event is written with the action, and never backfilled
  > refuses one written in a later transaction even seconds afterwards
```

It was first written up as a pre-existing flaky test. **That was wrong.** The test is correct and
fails exactly when the rule's documented window opens. A second gate run reported 16/16, and that
result was explicitly **not** accepted as evidence — retrying until the timing happens to avoid a gap
is not a pass.

The Phase 4 evidence record (`docs/evidence/phase-4-prompt-1.md`, in the Phase 4 working tree) already
carries the corrected account: §6 is titled *"THE FULL GATE DID NOT PASS CLEANLY"*, records the failed
run step by step, and retracts the flakiness claim in terms. **That file was not edited from this
worktree** — the Phase 4 tree was to be preserved exactly, and it was; see §7.

---

## 2. The defect, measured

The rule compared two `TIMESTAMP(3)` values, both trigger-assigned from `now()` (transaction start).
Migration 14 stated its own residual accurately: two different transactions beginning in the same
millisecond compare equal.

400 consecutive **separate** transactions on this project's database:

```
consecutive SEPARATE transactions sharing the same TIMESTAMP(3): 3 of 399 (0.8%)
```

About 1 attempt in 125. **A backfilling writer may retry**, so this reaches near-certainty in a few
hundred attempts. Against a deliberate direct writer the rule was not a guarantee. It did fully
prevent accidental backfill of *old* rows, and that half was never in question.

---

## 3. Why `pg_current_xact_id()` and not `xmin`

Phase 3B declined a transaction-id comparison because savepoint behaviour was not proven safe. **That
caution was correct**, and this work reproduced it rather than taking it on trust. Probe on
PostgreSQL 15.15, every transaction rolled back:

```
A. top-level pg_current_xact_id()           = 816
B. pg_current_xact_id() inside a SAVEPOINT  = 816 (SAME — top-level)

C. xmin of each inserted row:
     id=1  xmin=816  == top-level xid                      (true top level)
     id=2  xmin=817  != top-level xid  <-- SUBTRANSACTION  (inside SAVEPOINT)
     id=3  xmin=818  != top-level xid  <-- SUBTRANSACTION  (inside plpgsql EXCEPTION block)
     id=4  xmin=816  == top-level xid                      (inside plpgsql, no EXCEPTION)
```

`xmin` is the **subtransaction** id. Comparing it would have refused legitimate same-transaction
writes the moment anything opened a savepoint, and the failure mode would have been rejecting real
work in production. `pg_current_xact_id()` returns the top-level id at every depth.

Also verified, and deliberately **not** depended on:

* Prisma emits a flat `BEGIN … COMMIT` for an interactive transaction — `SAVEPOINT emitted anywhere:
  false`;
* no migration contains a PL/pgSQL `EXCEPTION` clause (`grep -rn "EXCEPTION WHEN"` → no matches).

Both could change. The design is correct either way, which is the reason for choosing it.

---

## 4. What the migration does

| | |
|---|---|
| Adds | `PromotionRedemption."writeXactId" xid8`, **nullable**, no default |
| Replaces | `walaaplus_validate_redemption`, `walaaplus_validate_integration_event` (`CREATE OR REPLACE`) |
| Rewrites, deletes, backfills, seeds or resets | **nothing** |
| Recreates triggers | **no** — `CREATE OR REPLACE FUNCTION` re-points the existing triggers, so neither table is ever unprotected |

`xid8` rather than `xid`: 64-bit and wraparound-free, so a persisted value cannot come to mean a
different transaction later. In `schema.prisma` it is `Unsupported("xid8")?`, which keeps it **out of
the generated Prisma client** — only the two triggers touch it.

### 4.1 The function bodies were extracted, not retyped

Both were read out of the applied migrations and edited in place by script, and the diff is recorded:

```
walaaplus_validate_redemption        : 0 lines removed, 12 added
walaaplus_validate_integration_event : 16 lines removed, 58 added
```

**Every one of the 16 removed lines is comment prose.** The timestamp `IF` was matched as unchanged by
difflib, i.e. it survives verbatim. Ten rules from migrations 13 and 14 were then confirmed present in
the output by name, including `does not describe a promotion redemption`, `the redemption it names
does not exist`, `the redemption belongs to a different business`, `names a % row`, `no integrity rule
exists for entity type`, and both `now() AT TIME ZONE 'UTC'` assignments.

### 4.2 Legacy rows fail closed

A `NULL` `writeXactId` means "written before the guarantee existed" and is **refused**, with its own
message:

```
IntegrationEvent: the redemption predates the transaction-identity guarantee and can never receive an event
```

Not a regression: such a redemption could only ever have received an event inside its own
transaction, which ended before this migration ran. Nothing is backfilled, and no value is guessed.

---

## 5. Tests — 15, all through the restricted runtime role

| | Test | Establishes |
|---|---|---|
| 1 | redemption + event in one transaction | accepted, and the stored identity is a real xid |
| 2 | **VOID/withdrawal** event in one transaction | the withdrawal path, not only the happy path |
| 3 | event written **two SAVEPOINTs deep** | **accepted** — the regression the `xmin` design would have caused |
| 4 | earlier-transaction event **with timestamps forged equal** | refused, and *not* for the legacy reason |
| 5 | same forgery for a **VOID** event | refused |
| 6 | earlier-transaction event, no forgery | refused |
| 7 | legacy row (`writeXactId IS NULL`) | refused by name, fails closed |
| 8 | caller supplies `writeXactId` | discarded and replaced by the server's own |
| 9 | runtime role `UPDATE`s the identity | permission denied / append-only |
| 10 | runtime role disables the trigger | must be owner |
| 11–15 | migration-14 rules | tenant, entry-kind, missing entity, `occurredAt` overwrite, envelope version |

### 5.1 The forgery is constructed, never raced

Requirement: no sleeps, no probability, no timing, no shared pool as proof.

The cross-transaction tests do **not** wait for a millisecond collision. They commit a redemption,
open a second transaction, read *its* `now()`, and then — from the table owner, with triggers
disabled — move the committed redemption's `recordedAt` onto that exact value. The old rule would
therefore have **accepted** the row; only the identity check refuses it.

The rig asserts the forgery actually took:

```ts
expect(timestampsWereEqual, "the test rig failed to manufacture timestamp equality — this run proves nothing").toBe(true);
```

**Inconclusive is a failure, not a pass.** That assertion fired on the first run and caught a real
mistake: `now()` carries microseconds while the columns are `TIMESTAMP(3)`, so storing the
full-precision value produced no match. Corrected with an explicit `::timestamp(3)` on both sides.

---

## 6. Red proof

Each condition removed **on its own** from the live function, on a freshly recreated database, with
everything else left in place:

| Condition removed | With it | Without it |
|---|---|---|
| the **xid equality** check (migration 14's timestamp rule left intact) | GREEN | **RED** |
| the **legacy `NULL`** fail-closed check | GREEN | **RED** |

```
2/2 conditions red-proved
full suite on a clean database: GREEN
```

The first row is the load-bearing one: with the identity check gone and the timestamp check still
present, the forged cross-transaction event is **accepted**. That is a direct demonstration that the
timestamp route is insufficient — not an argument that it is.

---

## 7. The Phase 4 working tree was preserved exactly

Verified by snapshot taken before this work began and re-checked afterwards:

| | |
|---|---|
| `git status --porcelain` | **identical** |
| tracked `git diff` | **identical** |
| 16 untracked files, sha256 each | **identical** |
| Phase 4 migration `20260926120000_cashback_and_discount_core` | present, unmodified |
| Phase 4 `node_modules` | intact |

One hazard was caught and avoided: the worktree's `node_modules` was first created as a **junction**
to the Phase 4 tree's. Running `prisma generate` through it would have overwritten Phase 4's generated
client with one built from the baseline schema. The link was removed (the link only, not its target)
and the worktree given its own `npm ci` install.

---

## 8. What this evidence does not claim

* **Nothing was tested against staging, a device, a provider, a POS or any external network.** No such
  call exists in this change.
* **No event or redemption row was rewritten, deleted, backfilled or seeded.** One nullable column was
  added and two functions were replaced.
* **The correction is not deployed.** It is committed on an isolated branch for review.
