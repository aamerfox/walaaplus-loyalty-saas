-- Prompt 0.3 item 4: database-backed authentication rate limiting.
--
-- Enforcement must not live in process memory: a second web process, or a restart, would reset
-- it. One row per (scope, keyHash) holds a fixed window; the unique index is what makes the
-- upsert in src/server/security/rate-limit.ts atomic under concurrency, because ON CONFLICT DO
-- UPDATE takes a row lock and concurrent attempts therefore serialise on it.
--
-- keyHash is an HMAC of the normalised identifier, never a plain email address or raw IP: the
-- table answers "has this key been seen too often" without being a list of who tried to sign in.

CREATE TABLE "AuthRateLimit" (
    "id" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "keyHash" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 1,
    "windowStart" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "lastAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuthRateLimit_pkey" PRIMARY KEY ("id")
);

-- Identity of a window. Also the conflict target of the atomic upsert.
CREATE UNIQUE INDEX "AuthRateLimit_scope_keyHash_key" ON "AuthRateLimit"("scope", "keyHash");

-- Expiry sweep: `DELETE ... WHERE "expiresAt" < now()` must never scan the table.
CREATE INDEX "AuthRateLimit_expiresAt_idx" ON "AuthRateLimit"("expiresAt");
