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

export class ConflictError extends AppError {
  constructor(message = "Conflict") {
    super("CONFLICT", message, 409);
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
