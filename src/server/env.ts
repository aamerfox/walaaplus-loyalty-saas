import { createHash } from "node:crypto";
import { z } from "zod";

/**
 * Startup environment validation.
 *
 * Every server process (Next.js via src/instrumentation.ts, the worker via src/worker/index.ts)
 * calls `env()` before doing anything else. If a required variable is missing or malformed the
 * process refuses to start with a message that lists VARIABLE NAMES ONLY — values are never
 * printed, logged, or included in errors.
 *
 * There are deliberately NO fallback values for secrets. The prototype shipped a hardcoded
 * NEXTAUTH_SECRET fallback that is now public in git history (docs/PHASE-0-HYGIENE.md H-1);
 * this module also refuses to start if either burned value is ever supplied.
 */

/**
 * Does this string actually parse as a usable PostgreSQL connection string?
 *
 * The prefix regex above is not enough, and the gap is a real deployment failure rather than a
 * theoretical one. A database password is embedded in this URL, and `openssl rand -base64 24` —
 * the obvious way to generate one — produces a `/` about a third of the time. In
 *
 *   postgresql://walaaplus:ab/cd@db:5432/loyalty
 *
 * the authority ends at that slash, so the string is not a URL at all. Without this check the
 * process starts happily and fails later, at the first query, with a driver error that points
 * nowhere near the password. The same password also breaks `psql` and `pg_dump`, which is what
 * makes it look intermittent: it depends entirely on which random bytes were drawn.
 *
 * A correctly percent-encoded password (`ab%2Fcd`) parses and is accepted.
 *
 * Returns a boolean and never throws, so zod reports the variable NAME and the fix, never the
 * value.
 */
function isWellFormedPostgresUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (!/^postgres(ql)?:$/.test(url.protocol)) return false;
  if (!url.hostname) return false;
  // `/loyalty` -> `loyalty`. An empty path means no database was named.
  if (url.pathname.replace(/^\//, "").length === 0) return false;
  try {
    // An unencoded `%` in the password makes this throw where the driver would.
    decodeURIComponent(url.password);
    decodeURIComponent(url.username);
  } catch {
    return false;
  }
  return true;
}

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),

  DATABASE_URL: z
    .string()
    .min(1)
    .regex(/^postgres(ql)?:\/\//, "must be a postgresql:// connection string")
    .refine(isWellFormedPostgresUrl, {
      message:
        "must parse as a connection string with a host and a database name. " +
        "A password containing / + % : @ or whitespace must be percent-encoded; " +
        "generate database passwords with `openssl rand -hex 32` to avoid the question entirely.",
    }),

  NEXTAUTH_SECRET: z.string().min(32, "must be at least 32 characters"),

  NEXTAUTH_URL: z.url(),

  NEXT_PUBLIC_APP_URL: z.url().optional(),

  /** Port for the worker's /health endpoint. 0 = OS-assigned (tests). */
  WORKER_HEALTH_PORT: z.coerce.number().int().min(0).max(65535).default(8081),

  /**
   * Whether `X-Forwarded-For` / `X-Real-IP` may be believed.
   *
   * These headers are client-supplied unless something in front of the app overwrites them.
   * If the app is reachable directly, an attacker sets a different value on every request and
   * any per-address limit becomes decoration. So the default is **false**: without a trusted
   * proxy the app reports NO client address at all rather than a forgeable one.
   *
   * Set it to true ONLY when every request passes through a proxy that REPLACES the header
   * (docker-compose.yml's `proxy` service does) and the app's own port is not published.
   * Accepts exactly "true" or "false" so a typo cannot quietly enable trust.
   */
  TRUST_PROXY_HEADERS: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),

  // ── Authentication rate limiting (src/server/security/rate-limit.ts) ────────
  // Defaults are deliberately usable as-is: a real merchant retypes a password a handful of
  // times, an attacker does not. Every value is validated, so a typo cannot silently disable
  // the limit — `AUTH_RATE_LIMIT_REGISTER_MAX=0` is refused at startup, not treated as "off".

  /** Registration attempts allowed per client address per window. */
  AUTH_RATE_LIMIT_REGISTER_MAX: z.coerce.number().int().min(1).max(10_000).default(10),
  /** Registration window length, seconds. */
  AUTH_RATE_LIMIT_REGISTER_WINDOW_SECONDS: z.coerce.number().int().min(1).max(86_400).default(900),
  /**
   * Registrations allowed in one window across the WHOLE deployment.
   *
   * Every other auth window is keyed on something the caller picks, so a fresh email is a fresh
   * allowance and registration had no effective ceiling wherever no client address is trusted.
   * 40 per 15 minutes is far above any genuine pilot rate and far below what it takes to matter
   * as a bcrypt CPU load.
   */
  AUTH_RATE_LIMIT_REGISTER_GLOBAL_MAX: z.coerce.number().int().min(1).max(100_000).default(40),
  /** Credential sign-in attempts allowed per identifier and per client address per window. */
  AUTH_RATE_LIMIT_SIGNIN_MAX: z.coerce.number().int().min(1).max(10_000).default(10),
  /** Sign-in window length, seconds. */
  AUTH_RATE_LIMIT_SIGNIN_WINDOW_SECONDS: z.coerce.number().int().min(1).max(86_400).default(900),
  /**
   * Optional dedicated pepper for the keyed hash of rate-limit identifiers. When absent, one is
   * derived from NEXTAUTH_SECRET — so there is always a keyed hash, never a bare sha256 that a
   * dictionary of email addresses could be matched against. Set it to rotate the two
   * independently. Rotating either simply starts fresh windows.
   */
  AUTH_RATE_LIMIT_PEPPER: z.string().min(16, "must be at least 16 characters").optional(),

  // ── Public enrollment (src/app/api/enroll/route.ts) ─────────────────────────
  // Deliberately generous: a café handing out QR cards at a launch event has many genuine
  // customers joining from one network within the hour. The limit exists to stop a script
  // farming welcome bonuses, not to throttle a queue at the counter.

  /** Enrollment attempts per client address per window. */
  ENROLL_RATE_LIMIT_IP_MAX: z.coerce.number().int().min(1).max(100_000).default(20),
  /** Enrollment attempts per enrollment LINK per window; holds when no address is trusted. */
  ENROLL_RATE_LIMIT_LINK_MAX: z.coerce.number().int().min(1).max(100_000).default(200),
  /** Enrollment window length, seconds. */
  ENROLL_RATE_LIMIT_WINDOW_SECONDS: z.coerce.number().int().min(1).max(86_400).default(3_600),
});

export type Env = z.infer<typeof envSchema>;

/**
 * sha256 digests of the two fallback strings that leaked in prototype history
 * (docs/PHASE-0-HYGIENE.md H-1). Stored as hashes so the literals never reappear in source.
 * Any environment supplying one of them is refused at startup.
 */
const BURNED_SECRET_HASHES: ReadonlySet<string> = new Set([
  "820e1e41d0153bc79029cbcaba4c509ad4359f74bfb5eb0e1c77b9d5360d6501", // committed prototype fallback
  "91b5ac601263558ffb395d7892dfbb21e36422d832b8ad5bf02c7fb7a25c8970", // working-tree prototype fallback
]);

export class EnvValidationError extends Error {
  readonly variables: string[];
  constructor(variables: string[], detail?: string) {
    super(
      `Environment validation failed. Missing or invalid: ${variables.join(", ")}.` +
        (detail ? ` ${detail}` : "") +
        " Values are never printed. See .env.example for the required variables.",
    );
    this.name = "EnvValidationError";
    this.variables = variables;
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/**
 * Validate an environment object. Pure: does not cache, does not read process.env unless asked.
 * Exported for unit tests.
 */
export function validateEnv(source: Record<string, string | undefined> = process.env): Env {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const names = [...new Set(parsed.error.issues.map((i) => String(i.path[0] ?? "?")))].sort();
    throw new EnvValidationError(names);
  }
  if (BURNED_SECRET_HASHES.has(sha256(parsed.data.NEXTAUTH_SECRET))) {
    throw new EnvValidationError(
      ["NEXTAUTH_SECRET"],
      "The supplied value is a known-compromised prototype fallback and is refused.",
    );
  }
  return parsed.data;
}

let cached: Env | undefined;

/** Validated, cached environment for the current process. Throws EnvValidationError on first call if invalid. */
export function env(): Env {
  if (!cached) cached = validateEnv();
  return cached;
}

/** Test-only: drop the cache so a test can re-validate with different process.env. */
export function resetEnvCacheForTests(): void {
  cached = undefined;
}
