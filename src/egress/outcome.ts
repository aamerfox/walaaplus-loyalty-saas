/**
 * The bounded vocabulary the gateway is allowed to say back.
 *
 * These are the **names** of `WebhookAttemptOutcome` and `WebhookErrorClass`, written out as plain
 * string literals rather than imported from `@prisma/client`.
 *
 * That is deliberate and it is not stylistic. The gateway is the one process in this product with a
 * route to the Internet. It has no database credential, no database connection and no reason to
 * hold either, so it must not carry a Prisma client — importing the enums would pull the generated
 * client, and therefore a query engine, into an image whose entire job is to open one socket and
 * throw the answer away.
 *
 * The cost of writing them twice is drift, and drift is what a test is for:
 * `tests/unit/webhook-gateway-contract.test.ts` asserts these lists are exactly the enum values
 * Prisma generates, so a value added to the schema and not here fails the gate rather than
 * producing a string the worker cannot store.
 */

/** Every outcome, in the schema's order. */
export const DISPATCH_OUTCOMES = ["DELIVERED", "RETRYABLE", "PERMANENT"] as const;
export type DispatchOutcome = (typeof DISPATCH_OUTCOMES)[number];

/**
 * Every error class the GATEWAY can produce.
 *
 * Shorter than the schema's list on purpose. `ENCRYPTION_UNAVAILABLE`, `CIPHERTEXT_INVALID` and
 * `DESTINATION_NOT_ELIGIBLE` are decisions the worker makes before it ever calls here — the gateway
 * cannot decrypt anything and has never heard of a destination's state — and `GATEWAY_UNAVAILABLE`
 * is what the worker records when it could not reach the gateway, which the gateway is in no
 * position to report about itself.
 */
export const DISPATCH_ERROR_CLASSES = [
  "NONE",
  "HTTP_CLIENT_ERROR",
  "HTTP_RATE_LIMITED",
  "HTTP_SERVER_ERROR",
  "HTTP_REDIRECT",
  "TIMEOUT",
  "NETWORK",
  "TLS",
  "UNSAFE_ADDRESS",
  "GATEWAY_REJECTED",
] as const;
export type DispatchErrorClass = (typeof DISPATCH_ERROR_CLASSES)[number];

/** Exactly what crosses the internal hop back to the worker. No body, no headers, no address. */
export interface DispatchResult {
  outcome: DispatchOutcome;
  errorClass: DispatchErrorClass;
  httpStatus: number | null;
}

/** Is this parsed JSON a result this product can store? Used by the worker on the way back. */
export function isDispatchResult(value: unknown): value is DispatchResult {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  if (!DISPATCH_OUTCOMES.includes(candidate.outcome as DispatchOutcome)) return false;
  if (!DISPATCH_ERROR_CLASSES.includes(candidate.errorClass as DispatchErrorClass)) return false;
  const status = candidate.httpStatus;
  if (status === null) return true;
  return typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599;
}
