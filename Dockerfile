# Multi-stage build producing three images from one source tree:
#   --target migrate  one-shot: `prisma migrate deploy` + runtime-role grants, AS THE MIGRATOR role
#   --target web      Next.js standalone server                    (runtime role)
#   --target worker   compiled pg-boss worker, separate container  (runtime role)
#
# Owner deploys these; the agent never pushes images or deploys. See docs/PHASE-0-IMPLEMENTATION.md.

# ---------------------------------------------------------------------------
# All dependencies (dev included) + generated Prisma client. Used to build and to migrate.
FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY prisma ./prisma
RUN npm ci --ignore-scripts && npx prisma generate

# Production dependencies only, for the worker image. The generated client is copied from `deps`
# because `prisma generate` needs the CLI, which is a dev dependency.
FROM node:24-alpine AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY --from=deps /app/node_modules/.prisma ./node_modules/.prisma

FROM node:24-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# Build-time only. Validation happens at RUNTIME start, so no real secret is needed to build.
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build && npm run build:worker

# ---------------------------------------------------------------------------
# Migrator. Runs to completion before web and worker start (docker-compose.yml `migrate`).
# It is the ONLY image that ever receives MIGRATE_DATABASE_URL.
FROM node:24-alpine AS migrate
WORKDIR /app
ENV NODE_ENV=production
RUN addgroup -S app && adduser -S app -G app
COPY --from=deps --chown=app:app /app/node_modules ./node_modules
COPY --chown=app:app package.json ./
COPY --chown=app:app prisma ./prisma
COPY --chown=app:app scripts/db-migrate.mjs scripts/db-roles.mjs ./scripts/
USER app
CMD ["sh", "-c", "node scripts/db-migrate.mjs deploy && node scripts/db-roles.mjs"]

# ---------------------------------------------------------------------------
FROM node:24-alpine AS web
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
RUN addgroup -S app && adduser -S app -G app
COPY --from=build --chown=app:app /app/.next/standalone ./
COPY --from=build --chown=app:app /app/.next/static ./.next/static
COPY --from=build --chown=app:app /app/public ./public
USER app
EXPOSE 3000
CMD ["node", "server.js"]

# ---------------------------------------------------------------------------
# Worker: compiled ESM bundle (scripts/build-worker.mjs), production node_modules, no TypeScript
# loader and no source tree in the image.
FROM node:24-alpine AS worker
WORKDIR /app
ENV NODE_ENV=production
RUN addgroup -S app && adduser -S app -G app
COPY --from=prod-deps --chown=app:app /app/node_modules ./node_modules
COPY --from=build --chown=app:app /app/dist/worker ./dist/worker
COPY --chown=app:app package.json ./
USER app
EXPOSE 8081
CMD ["node", "dist/worker/index.mjs"]
