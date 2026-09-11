-- Remediation item 3: an original operation may be reversed at most once.
--
-- reverseOperationGroup now locks the card row before checking for existing reversals, which
-- closes the race in application code. This partial unique index is the database-level backstop:
-- two compensating rows can never point at the same original, regardless of how they were written.
CREATE UNIQUE INDEX "LoyaltyOperation_reversalOfOperationId_key"
  ON "LoyaltyOperation" ("reversalOfOperationId")
  WHERE "reversalOfOperationId" IS NOT NULL;
