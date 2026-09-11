/**
 * Domain error hierarchy. Route handlers map `status` to HTTP; services throw these and
 * never construct HTTP responses themselves.
 */
export class AppError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.status = status;
  }
}

export class ValidationError extends AppError {
  readonly issues: unknown;
  constructor(message = "Invalid request", issues?: unknown) {
    super("VALIDATION_ERROR", message, 400);
    this.issues = issues;
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = "Authentication required") {
    super("UNAUTHORIZED", message, 401);
  }
}

export class ForbiddenError extends AppError {
  constructor(message = "Forbidden") {
    super("FORBIDDEN", message, 403);
  }
}

export class NotFoundError extends AppError {
  constructor(message = "Not found") {
    super("NOT_FOUND", message, 404);
  }
}

/**
 * Codes a scanner screen can act on.
 *
 * A 409 is not one situation: "this card has no reward to give", "this card has had its stamps
 * for today" and "this card is paused" all need different words at a counter, and the cashier is
 * standing in front of a customer. The message stays English for logs; the CODE is what the UI
 * translates, so an Arabic screen never has to display a server string.
 */
export const ConflictCode = {
  GENERIC: "CONFLICT",
  /** Redemption attempted with nothing earned. */
  NO_REWARD_AVAILABLE: "NO_REWARD_AVAILABLE",
  /** The program's dailyAwardLimit is spent for this card today. */
  DAILY_LIMIT_REACHED: "DAILY_LIMIT_REACHED",
  /** Paused, expired or deleted. */
  CARD_NOT_TRANSACTABLE: "CARD_NOT_TRANSACTABLE",
  /** The group was already reversed, or is itself a reversal. */
  ALREADY_REVERSED: "ALREADY_REVERSED",
} as const;
export type ConflictCodeName = (typeof ConflictCode)[keyof typeof ConflictCode];

export class ConflictError extends AppError {
  constructor(message = "Conflict", code: ConflictCodeName = ConflictCode.GENERIC) {
    super(code, message, 409);
  }
}

/** Same idempotency key reused with a different payload. */
export class IdempotencyConflictError extends AppError {
  constructor(message = "Idempotency key was already used with a different payload") {
    super("IDEMPOTENCY_CONFLICT", message, 409);
  }
}

/** A ledger write would violate an invariant (negative balance, unknown card, etc.). */
export class LedgerInvariantError extends AppError {
  constructor(message: string) {
    super("LEDGER_INVARIANT", message, 422);
  }
}

export function isAppError(e: unknown): e is AppError {
  return e instanceof AppError;
}
