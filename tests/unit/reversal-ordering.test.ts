import { describe, expect, it } from "vitest";
import { orderCompensating } from "@/server/ledger/ledger";

/**
 * A reversal must apply every credit before every debit.
 *
 * The bug this exists for was invisible and permanent. `reverseOperationGroup` read the original
 * group `ORDER BY "createdAt" ASC` and reversed it — but `createdAt` defaults to
 * `CURRENT_TIMESTAMP`, which in PostgreSQL is the **transaction** timestamp, so every row of a
 * group carries the identical value. The sort had nothing to order by, and PostgreSQL may return
 * tied rows in any order; the order it happens to pick changes with the plan and with table size.
 *
 * `appendOperationGroup` validates the balance after EVERY row, so an unlucky order makes the
 * running balance dip below zero mid-group and the reversal is refused with "dependent value was
 * already consumed" — blaming the merchant for a state that does not exist, on a reversal that is
 * perfectly valid, with no retry that can ever succeed.
 *
 * These tests are deliberately NOT integration tests. The hazard is "whatever order the database
 * returned", and the only way to prove the fix covers all of them is to enumerate the
 * permutations, which is a pure function's job. The end-to-end reversal behaviour stays covered by
 * `tests/integration/stamp-engine.test.ts` and `reversal-race.test.ts`.
 */

/** All orderings of a list — the set of orders PostgreSQL is entitled to hand back. */
function permutations<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) return [[...items]];
  return items.flatMap((item, index) => {
    const rest = [...items.slice(0, index), ...items.slice(index + 1)];
    return permutations(rest).map((tail) => [item, ...tail]);
  });
}

/** The running balance the ledger would compute, applying compensating rows in the given order. */
function runningBalances(startingBalance: number, rows: readonly { quantity: number }[]): number[] {
  const balances: number[] = [];
  let balance = startingBalance;
  for (const row of rows) {
    balance += row.quantity;
    balances.push(balance);
  }
  return balances;
}

describe("orderCompensating", () => {
  /*
   * The real group behind the bug. A five-stamp award onto a card holding five, with a threshold
   * of ten: the award converts, so the group is an award, a conversion debit and a reward credit.
   * Compensating it means negating each.
   */
  const compensatingRows = [
    { label: "undo the award", quantity: -5 },
    { label: "undo the conversion", quantity: +10 },
    { label: "undo the reward", quantity: -1 },
  ];

  it("puts every credit before every debit", () => {
    const ordered = orderCompensating(compensatingRows);
    const signs = ordered.map((row) => Math.sign(row.quantity));
    const firstDebit = signs.indexOf(-1);
    expect(firstDebit).toBeGreaterThanOrEqual(0);
    // No credit may appear after the first debit.
    expect(signs.slice(firstDebit).some((sign) => sign > 0)).toBe(false);
  });

  it("never drives the balance negative, from ANY order the database might return", () => {
    // Stamp balance after the award converted: zero stamps, one reward. Undoing must not dip
    // below zero at any point.
    for (const shuffled of permutations(compensatingRows)) {
      const balances = runningBalances(0, orderCompensating(shuffled));
      expect(Math.min(...balances), `order ${shuffled.map((r) => r.label).join(" → ")}`).toBeGreaterThanOrEqual(0);
      // And it still lands on the right total, whatever the input order was.
      expect(balances.at(-1)).toBe(4);
    }
  });

  it("shows what the old behaviour did on the same rows", () => {
    /*
     * Not a test of production code — a record of why this function exists. The old code was
     * `[...originals].reverse()`, which for one of the six possible database orders produces the
     * sequence below and fails at the second row.
     */
    const unluckyDatabaseOrder = [
      { label: "conversion", quantity: -10 },
      { label: "award", quantity: +5 },
      { label: "reward", quantity: +1 },
    ];
    const oldOrder = [...unluckyDatabaseOrder].reverse().map((row) => ({ ...row, quantity: -row.quantity }));
    expect(Math.min(...runningBalances(0, oldOrder))).toBeLessThan(0);

    // The same rows through the fix stay non-negative throughout.
    const fixed = orderCompensating(oldOrder);
    expect(Math.min(...runningBalances(0, fixed))).toBeGreaterThanOrEqual(0);
  });

  it("is stable among rows of the same sign", () => {
    // Two credits keep the order the database gave them, so history stays as close to the
    // original as the constraint allows.
    const rows = [
      { label: "first credit", quantity: +2 },
      { label: "second credit", quantity: +3 },
      { label: "a debit", quantity: -1 },
    ];
    expect(orderCompensating(rows).map((r) => r.label)).toEqual(["first credit", "second credit", "a debit"]);
  });

  it("handles the ordinary single-row reversal unchanged", () => {
    const one = [{ label: "undo one award", quantity: -3 }];
    expect(orderCompensating(one)).toEqual(one);
    expect(orderCompensating([])).toEqual([]);
  });

  it("reports a genuinely impossible reversal rather than hiding it", () => {
    // If the credits do not cover the debits, no order helps and the ledger must still refuse.
    // This is the case where "dependent value was already consumed" is the honest answer.
    const impossible = [
      { label: "undo a big award", quantity: -10 },
      { label: "undo a small conversion", quantity: +2 },
    ];
    expect(Math.min(...runningBalances(0, orderCompensating(impossible)))).toBeLessThan(0);
  });
});
