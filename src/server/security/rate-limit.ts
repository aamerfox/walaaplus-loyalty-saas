import { createHmac, randomUUID } from "node:crypto";
import { AuditAction, recordAudit } from "../audit/audit";
import { prisma } from "../db";
import { env } from "../env";

/**
 * Authentication rate limiting, enforced in PostgreSQL.
 *
 * Why not in process memory: a second web process, a restart, or a rolling deploy resets an
 * in-process counter, and the staging design (one VPS today, more later) must not depend on
 * there being exactly one process. The limit therefore lives in one row per (scope, key).
 *
 * How it stays correct under concurrency: `INSERT … ON CONFLICT (scope, keyHash) DO UPDATE`
 * is a single statement. PostgreSQL takes a row lock on the conflicting row, so simultaneous
 * attempts serialise on it and the counter is exact — there is no read-then-write window for
 * a burst of parallel requests to slip through.
 *
 * Privacy: the stored key is an HMAC of the NORMALISED identifier, keyed with a pepper. The
 * table can answer "has this key been seen too often" without being a readable list of who
 * tried to sign in, and it is not vulnerable to hashing a dictionary of email addresses.
 *
 * What callers get back is deliberately thin: allowed or not, and how long to wait. Nothing in
 * it distinguishes "this account exists" from "this account does not".
 */

export const RateLimitScope = {
  REGISTER_IP: "auth.register.ip",
  REGISTER_IDENTIFIER: "auth.register.identifier",
  SIGNIN_IP: "auth.signin.ip",
  SIGNIN_IDENTIFIER: "auth.signin.identifier",
  /**
   * One window for ALL registrations, keyed on a constant.
   *
   * Every other auth window is keyed on something the caller chooses. Per-email is the right
   * shape for "stop guessing at THIS account" and no shape at all for "stop creating accounts":
   * a fresh email is a fresh window, so with no trusted client address - which is the co-hosted
   * staging posture, deliberately (docker-compose.staging-cohost.yml) - registration had no
   * effective limit. Each attempt costs a 12-round bcrypt on a 0.35-CPU container BEFORE the
   * transaction opens, so unlimited registration is also a way to stop the till working.
   *
   * A global window can be exhausted on purpose, which pauses new sign-ups for the rest of the
   * hour. For a pilot with a handful of merchants that is a far smaller harm than the one it
   * closes, and it fails in the direction of "nobody registers" rather than "the café stops
   * serving".
   */
  REGISTER_GLOBAL: "auth.register.global",
  /** Public customer enrollment. Welcome bonuses make this an abuse target (PRODUCT-SPEC §6.1). */
  ENROLL_IP: "enroll.ip",
  ENROLL_LINK: "enroll.link",
} as const;
export type RateLimitScopeName = (typeof RateLimitScope)[keyof typeof RateLimitScope];

export interface RateLimitDecision {
  allowed: boolean;
  /** Whole seconds until the current window ends. 0 when allowed. */
  retryAfterSeconds: number;
}

/** A single window's configuration. */
export interface RateLimitRule {
  scope: RateLimitScopeName;
  max: number;
  windowSeconds: number;
}

export function registerRules(): RateLimitRule[] {
  const e = env();
  const max = e.AUTH_RATE_LIMIT_REGISTER_MAX;
  const windowSeconds = e.AUTH_RATE_LIMIT_REGISTER_WINDOW_SECONDS;
  return [
    // Per submitted email. This window does not depend on a client address, so registration stays
    // limited even where no trusted proxy supplies one (see docs/PHASE-0-IMPLEMENTATION.md §9).
    { scope: RateLimitScope.REGISTER_IDENTIFIER, max, windowSeconds },
    { scope: RateLimitScope.REGISTER_IP, max, windowSeconds },
    // The backstop that does not depend on the caller choosing anything. Generous next to the
    // per-email window, because it is shared by every genuine sign-up at once.
    { scope: RateLimitScope.REGISTER_GLOBAL, max: e.AUTH_RATE_LIMIT_REGISTER_GLOBAL_MAX, windowSeconds },
  ];
}

export function signInRules(): RateLimitRule[] {
  const e = env();
  return [
    { scope: RateLimitScope.SIGNIN_IDENTIFIER, max: e.AUTH_RATE_LIMIT_SIGNIN_MAX, windowSeconds: e.AUTH_RATE_LIMIT_SIGNIN_WINDOW_SECONDS },
    { scope: RateLimitScope.SIGNIN_IP, max: e.AUTH_RATE_LIMIT_SIGNIN_MAX, windowSeconds: e.AUTH_RATE_LIMIT_SIGNIN_WINDOW_SECONDS },
  ];
}

/**
 * Normalise before hashing, so "  Foo@Bar.COM " and "foo@bar.com" share one window and an
 * attacker cannot multiply their allowance by changing capitalisation or padding.
 */
export function normalizeIdentifier(raw: string | null | undefined): string {
  return (raw ?? "").trim().toLowerCase();
}

let cachedPepper: Buffer | undefined;

function pepper(): Buffer {
  if (!cachedPepper) {
    const e = env();
    cachedPepper = e.AUTH_RATE_LIMIT_PEPPER
      ? Buffer.from(e.AUTH_RATE_LIMIT_PEPPER, "utf8")
      : // Derived, not reused verbatim: the session secret never appears as the HMAC key itself.
        createHmac("sha256", e.NEXTAUTH_SECRET).update("walaaplus:auth-rate-limit:v1").digest();
  }
  return cachedPepper;
}

/** Test-only: drop the derived pepper so a test can change the environment. */
export function resetRateLimitPepperForTests(): void {
  cachedPepper = undefined;
}

/** Keyed hash of a normalised identifier. Scope is bound in, so one identifier's windows are independent. */
export function hashKey(scope: RateLimitScopeName, identifier: string): string {
  return createHmac("sha256", pepper()).update(`${scope}:${normalizeIdentifier(identifier)}`, "utf8").digest("hex");
}

interface UpsertRow {
  attempts: number;
  expiresAt: Date;
}

/**
 * Count one attempt against `rule` and report whether it is allowed.
 *
 * A refused attempt still counts, but never extends the window: `expiresAt` only moves when a
 * new window starts. So an attacker cannot hold a legitimate user out indefinitely by hammering.
 */
async function consumeOne(rule: RateLimitRule, keyHash: string): Promise<RateLimitDecision> {
  // `excluded."windowStart"` is this statement's own `now()`, computed once and reused, so the
  // expiry comparison and the new window start cannot drift apart mid-statement.
  const rows = await prisma.$queryRaw<UpsertRow[]>`
    INSERT INTO "AuthRateLimit" ("id", "scope", "keyHash", "attempts", "windowStart", "expiresAt", "lastAttemptAt")
    SELECT ${randomUUID()}, ${rule.scope}, ${keyHash}, 1, s.t, s.t + make_interval(secs => ${rule.windowSeconds}::double precision), s.t
      FROM (SELECT (now() AT TIME ZONE 'UTC') AS t) s
    ON CONFLICT ("scope", "keyHash") DO UPDATE SET
      "attempts" = CASE WHEN "AuthRateLimit"."expiresAt" <= excluded."windowStart" THEN 1 ELSE "AuthRateLimit"."attempts" + 1 END,
      "windowStart" = CASE WHEN "AuthRateLimit"."expiresAt" <= excluded."windowStart" THEN excluded."windowStart" ELSE "AuthRateLimit"."windowStart" END,
      "expiresAt" = CASE WHEN "AuthRateLimit"."expiresAt" <= excluded."windowStart" THEN excluded."expiresAt" ELSE "AuthRateLimit"."expiresAt" END,
      "lastAttemptAt" = excluded."lastAttemptAt"
    RETURNING "attempts", "expiresAt"`;

  const row = rows[0];
  const remainingMs = row.expiresAt.getTime() - Date.now();
  const retryAfterSeconds = Math.max(1, Math.ceil(remainingMs / 1000));
  if (row.attempts <= rule.max) return { allowed: true, retryAfterSeconds: 0 };

  // Audit the FIRST refusal of each window only. Every refusal would let an attacker turn one
  // request into unbounded audit writes; the first one is what an operator needs to see.
  if (row.attempts === rule.max + 1) {
    await recordAudit(prisma, {
      action: AuditAction.AUTH_RATE_LIMITED,
      entityType: "AuthRateLimit",
      entityId: null,
      businessId: null, // pre-authentication: there is no tenant yet
      actorUserId: null,
      metadata: {
        scope: rule.scope,
        limit: rule.max,
        windowSeconds: rule.windowSeconds,
        // A short prefix of the keyed hash: enough to correlate repeated refusals with each
        // other, not enough to recover the identifier. No email, no IP, no credential.
        keyFingerprint: keyHash.slice(0, 12),
      },
    }).catch(() => undefined); // auditing must never turn a refusal into a 500
  }
  return { allowed: false, retryAfterSeconds };
}

/**
 * Count one attempt against every rule and refuse if ANY of them is exhausted.
 *
 * All rules are consumed even when an earlier one already refused, so the per-identifier and
 * per-address windows stay consistent with each other and the outcome does not depend on the
 * order rules happen to be listed in.
 */
export async function consumeRateLimit(rules: RateLimitRule[], identifiers: Partial<Record<RateLimitScopeName, string>>): Promise<RateLimitDecision> {
  let decision: RateLimitDecision = { allowed: true, retryAfterSeconds: 0 };
  for (const rule of rules) {
    const identifier = identifiers[rule.scope];
    // `undefined` means there is nothing to key on - no client address, say. An EMPTY STRING is
    // different: it is a value the caller supplied, and skipping it on truthiness let a request
    // with `email: ""` consume no window at all.
    if (identifier === undefined) continue;
    const one = await consumeOne(rule, hashKey(rule.scope, identifier));
    if (!one.allowed && (decision.allowed || one.retryAfterSeconds > decision.retryAfterSeconds)) {
      decision = one;
    }
  }
  return decision;
}

/**
 * Forget a key's window. Called after a SUCCESSFUL sign-in so that a legitimate user who
 * mistyped a few times is not locked out by their own successful attempt, while failures still
 * accumulate for everyone else.
 */
export async function resetRateLimit(scope: RateLimitScopeName, identifier: string): Promise<void> {
  await prisma.authRateLimit.deleteMany({ where: { scope, keyHash: hashKey(scope, identifier) } });
}

/** How many expired rows one sweep removes. Bounded so a sweep is never a long-running delete. */
export const PRUNE_BATCH = 1_000;

/**
 * Delete a bounded batch of expired windows. Returns how many rows went.
 *
 * Called opportunistically (see `maybePrune`) and exported so a scheduled worker job can own it
 * outright when the job runner takes on business jobs in Phase 1.5.
 */
export async function pruneExpiredRateLimits(batch: number = PRUNE_BATCH): Promise<number> {
  const result = await prisma.$executeRaw`
    DELETE FROM "AuthRateLimit"
     WHERE "id" IN (
       SELECT "id" FROM "AuthRateLimit" WHERE "expiresAt" < (now() AT TIME ZONE 'UTC') LIMIT ${batch}
     )`;
  return result;
}

/** Fraction of new windows that also trigger a sweep. Keeps the table bounded without a cron. */
const PRUNE_SAMPLE_RATE = 0.02;

async function maybePrune(): Promise<void> {
  if (Math.random() >= PRUNE_SAMPLE_RATE) return;
  await pruneExpiredRateLimits().catch(() => undefined);
}

/**
 * Registration: one window per submitted email, and one per client address when a trusted proxy
 * supplied one. An untrusted or absent address contributes no window rather than a forgeable one,
 * which is why the email window exists: it holds regardless of the network boundary.
 */
export async function consumeRegisterLimit(clientIp: string | null, identifier?: string | null): Promise<RateLimitDecision> {
  const identifiers: Partial<Record<RateLimitScopeName, string>> = {
    // A constant, so this window is always open and always counted. It is the only registration
    // rule an attacker cannot sidestep by changing what they submit.
    [RateLimitScope.REGISTER_GLOBAL]: "all",
  };
  if (identifier !== undefined && identifier !== null) identifiers[RateLimitScope.REGISTER_IDENTIFIER] = identifier;
  if (clientIp) identifiers[RateLimitScope.REGISTER_IP] = clientIp;
  const decision = await consumeRateLimit(registerRules(), identifiers);
  await maybePrune();
  return decision;
}

/** Credential sign-in: one window per identifier and one per client address; either can refuse. */
export async function consumeSignInLimit(identifier: string, clientIp: string | null): Promise<RateLimitDecision> {
  const identifiers: Partial<Record<RateLimitScopeName, string>> = { [RateLimitScope.SIGNIN_IDENTIFIER]: identifier };
  if (clientIp) identifiers[RateLimitScope.SIGNIN_IP] = clientIp;
  const decision = await consumeRateLimit(signInRules(), identifiers);
  await maybePrune();
  return decision;
}

/**
 * Public enrollment: one window per client address, and one per enrollment LINK.
 *
 * The link window is what holds when no trusted proxy supplies an address, and it is also the
 * right shape for the actual threat: a welcome bonus is worth farming, and farming it means
 * hammering ONE merchant's link. It is deliberately generous — a café handing out QR cards at a
 * launch event has many genuine customers joining from one network in an hour.
 */
export async function consumeEnrollmentLimit(clientIp: string | null, sourceToken: string): Promise<RateLimitDecision> {
  const e = env();
  const rules: RateLimitRule[] = [
    { scope: RateLimitScope.ENROLL_IP, max: e.ENROLL_RATE_LIMIT_IP_MAX, windowSeconds: e.ENROLL_RATE_LIMIT_WINDOW_SECONDS },
    { scope: RateLimitScope.ENROLL_LINK, max: e.ENROLL_RATE_LIMIT_LINK_MAX, windowSeconds: e.ENROLL_RATE_LIMIT_WINDOW_SECONDS },
  ];
  const identifiers: Partial<Record<RateLimitScopeName, string>> = { [RateLimitScope.ENROLL_LINK]: sourceToken };
  if (clientIp) identifiers[RateLimitScope.ENROLL_IP] = clientIp;
  const decision = await consumeRateLimit(rules, identifiers);
  await maybePrune();
  return decision;
}

/** Clear a successful signer's identifier window. The address window is left as it is. */
export async function clearSignInLimit(identifier: string): Promise<void> {
  await resetRateLimit(RateLimitScope.SIGNIN_IDENTIFIER, identifier);
}
