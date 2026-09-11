import type { OperationKind, UnitType } from "@prisma/client";
import type { LedgerActor } from "./actor";

/** One ledger row to append. `quantity` is a signed non-zero integer in the unit's smallest step. */
export interface OperationInput {
  kind: OperationKind;
  unitType: UnitType;
  quantity: number;
  purchaseAmountMinor?: number | null;
  monetaryDeltaMinor?: number | null;
  redemptionValueMinor?: number | null;
  /** Must belong to the card's pinned ProgramVersion; validated by the ledger. */
  rewardTierId?: string | null;
  comment?: string | null;
  reason?: string | null;
  reversalOfOperationId?: string | null;
  externalProvider?: string | null;
  externalEventId?: string | null;
  /**
   * Explicit visit intent. REQUIRED for award kinds written by API/AUTOMATION actors, FORBIDDEN
   * for member actors and for non-award kinds (policy decides). See visits.ts.
   */
  countsAsVisit?: boolean;
}

/** A set of rows that commit atomically under one transactionGroupId. */
export interface OperationGroupInput {
  /** Who is writing. Business, acting user, permissions and location scope derive from this. */
  actor: LedgerActor;
  customerCardId: string;
  locationId: string;
  operations: OperationInput[];
  /** Supply to make a retried group reuse the same id; otherwise a UUID is generated. */
  transactionGroupId?: string;
}

export type Balances = Record<UnitType, number>;

export interface AppendedOperation {
  id: string;
  kind: OperationKind;
  unitType: UnitType;
  quantity: number;
  balanceAfter: number;
  countsAsVisit: boolean;
}

export interface AppendResult {
  transactionGroupId: string;
  customerCardId: string;
  operations: AppendedOperation[];
  balances: Balances;
}
