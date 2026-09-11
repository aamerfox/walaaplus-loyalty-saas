import { Prisma, UnitType } from "@prisma/client";
import { prisma, type DbClient } from "../db";

/**
 * Reconciliation: recompute every card's balances from the ledger and compare with the stored
 * projections. Any difference is a defect — the ledger is authoritative.
 *
 * Phase 0 ships the query and a test utility. Phase 1.5 schedules it nightly in the worker.
 */

export interface BalanceMismatch {
  customerCardId: string;
  businessId: string;
  unitType: UnitType;
  projected: number;
  ledger: number;
}

export interface ReconciliationReport {
  checkedCards: number;
  mismatches: BalanceMismatch[];
}

interface Row {
  id: string;
  businessId: string;
  stampBalance: number;
  pointBalance: number;
  rewardBalance: number;
  cashBalanceMinor: number;
  visitBalance: number;
  l_stamp: number;
  l_point: number;
  l_reward: number;
  l_cash: number;
  l_visit: number;
}

export async function reconcileCardBalances(
  opts: { businessId?: string; customerCardId?: string } = {},
  db: DbClient = prisma,
): Promise<ReconciliationReport> {
  const cardFilter = Prisma.join(
    [
      Prisma.sql`TRUE`,
      opts.businessId ? Prisma.sql`c."businessId" = ${opts.businessId}` : Prisma.empty,
      opts.customerCardId ? Prisma.sql`c.id = ${opts.customerCardId}` : Prisma.empty,
    ].filter((s) => s !== Prisma.empty),
    " AND ",
  );

  const rows = await db.$queryRaw<Row[]>`
    WITH ledger AS (
      SELECT o."customerCardId" AS card_id,
             COALESCE(SUM(o.quantity) FILTER (WHERE o."unitType" = 'STAMP'),  0)::int AS l_stamp,
             COALESCE(SUM(o.quantity) FILTER (WHERE o."unitType" = 'POINT'),  0)::int AS l_point,
             COALESCE(SUM(o.quantity) FILTER (WHERE o."unitType" = 'REWARD'), 0)::int AS l_reward,
             COALESCE(SUM(o.quantity) FILTER (WHERE o."unitType" = 'CASH'),   0)::int AS l_cash,
             COALESCE(SUM(o.quantity) FILTER (WHERE o."unitType" = 'VISIT'),  0)::int AS l_visit
      FROM "LoyaltyOperation" o
      GROUP BY o."customerCardId"
    )
    SELECT c.id, c."businessId",
           c."stampBalance", c."pointBalance", c."rewardBalance", c."cashBalanceMinor", c."visitBalance",
           COALESCE(l.l_stamp, 0)  AS l_stamp,
           COALESCE(l.l_point, 0)  AS l_point,
           COALESCE(l.l_reward, 0) AS l_reward,
           COALESCE(l.l_cash, 0)   AS l_cash,
           COALESCE(l.l_visit, 0)  AS l_visit
    FROM "CustomerCard" c
    LEFT JOIN ledger l ON l.card_id = c.id
    WHERE ${cardFilter}`;

  const mismatches: BalanceMismatch[] = [];
  const pairs: Array<[UnitType, keyof Row, keyof Row]> = [
    [UnitType.STAMP, "stampBalance", "l_stamp"],
    [UnitType.POINT, "pointBalance", "l_point"],
    [UnitType.REWARD, "rewardBalance", "l_reward"],
    [UnitType.CASH, "cashBalanceMinor", "l_cash"],
    [UnitType.VISIT, "visitBalance", "l_visit"],
  ];
  for (const r of rows) {
    for (const [unitType, projCol, ledgerCol] of pairs) {
      const projected = Number(r[projCol]);
      const ledger = Number(r[ledgerCol]);
      if (projected !== ledger) {
        mismatches.push({ customerCardId: r.id, businessId: r.businessId, unitType, projected, ledger });
      }
    }
  }
  return { checkedCards: rows.length, mismatches };
}
