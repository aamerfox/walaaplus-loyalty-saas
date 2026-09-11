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

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),

  DATABASE_URL: z
    .string()
    .min(1)
    .regex(/^postgres(ql)?:\/\//, "must be a postgresql:// connection string"),

  NEXTAUTH_SECRET: z.string().min(32, "must be at least 32 characters"),

  NEXTAUTH_URL: z.url(),

  NEXT_PUBLIC_APP_URL: z.url().optional(),

  /** Port for the worker's /health endpoint. 0 = OS-assigned (tests). */
  WORKER_HEALTH_PORT: z.coerce.number().int().min(0).max(65535).default(8081),
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
