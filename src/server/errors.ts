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

/**
 * A webhook endpoint on a port this product does not offer.
 *
 * Its own error class, and therefore its own code on the wire, for one reason: the screen has to be
 * able to say WHICH rule was broken. Every other refusal on that form is "check the address", which
 * is no help at all to an owner who typed a perfectly good address with `:8443` on the end.
 *
 * **The message is a fixed sentence and never contains the submitted value** — not the URL, not the
 * hostname, not the path, not the query, not the port that was tried. An endpoint's path or query
 * can carry a token the receiver treats as authentication, and an error message is the single most
 * likely place for one to end up copied into a screenshot, a support ticket or a log.
 */
export class WebhookPortError extends AppError {
  constructor() {
    super("WEBHOOK_PORT_NOT_443", "Webhook endpoints must use HTTPS port 443", 400);
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

  /*
   * Phase 1b Prompt 3. The lifecycle refusals a merchant can act on.
   *
   * Each of these is a 409 that a screen must explain differently, in the merchant's own language.
   * The English message stays for logs; the CODE is what the UI translates, which is why a refusal
   * that would otherwise need the server to speak Arabic does not.
   */
  /** The main counter is where enrolment and every main-only program writes. */
  LOCATION_IS_MAIN: "LOCATION_IS_MAIN",
  /** A business must keep at least one active counter. */
  LOCATION_LAST_ACTIVE: "LOCATION_LAST_ACTIVE",
  /** Closing this counter would leave a live program with nowhere to trade. */
  LOCATION_STRANDS_PROGRAM: "LOCATION_STRANDS_PROGRAM",
  /** Another active row of the same kind already uses this name. */
  NAME_TAKEN: "NAME_TAKEN",
  /** The draft changed while it was being reviewed; it must be read again before publishing. */
  DRAFT_STALE: "DRAFT_STALE",
  /** The built-in counter source cannot be renamed or switched off. */
  SOURCE_PROTECTED: "SOURCE_PROTECTED",
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

/**
 * A window is spent. 429, with the seconds to wait.
 *
 * `retryAfterSeconds` is carried on the error rather than assembled at the route, so every caller
 * answers the same way and a screen can say "try again in a minute" instead of "something went
 * wrong". It says nothing about WHOSE window, or what else has been done in it.
 */
export class RateLimitedError extends AppError {
  readonly retryAfterSeconds: number;
  constructor(retryAfterSeconds: number, message = "Too many requests; please wait a moment") {
    super("RATE_LIMITED", message, 429);
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export function isAppError(e: unknown): e is AppError {
  return e instanceof AppError;
}
