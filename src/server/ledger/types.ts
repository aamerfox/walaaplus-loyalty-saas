import type { OperationKind, OperationSource, UnitType } from "@prisma/client";

/** One ledger row to append. `quantity` is a signed non-zero integer in the unit's smallest step. */
export interface OperationInput {
  kind: OperationKind;
  unitType: UnitType;
  quantity: number;
  purchaseAmountMinor?: number | null;
  monetaryDeltaMinor?: number | null;
  redemptionValueMinor?: number | null;
  rewardTierId?: string | null;
  comment?: string | null;
  reason?: string | null;
  reversalOfOperationId?: string | null;
  externalProvider?: string | null;
  externalEventId?: string | null;
}

/** A set of rows that commit atomically under one transactionGroupId. */
export interface OperationGroupInput {
  businessId: string;
  customerCardId: string;
  locationId: string;
  /** null for ENROLLMENT / SYSTEM / AUTOMATION sources. */
  performedByUserId: string | null;
  source: OperationSource;
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
