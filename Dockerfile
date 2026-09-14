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
RUN npm run build && npm run build:worker && npm run build:egress

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
# scripts/db-roles.mjs imports ./lib/db-role-membership.mjs. Copying only the two entry scripts
# built an image that passed every source-tree check and then died on a real deployment with
# ERR_MODULE_NOT_FOUND, inside the one container that runs before web and worker start. The whole
# lib directory is copied, not that one file, so a helper added later arrives with it.
# scripts/check-migrate-image.mjs builds this target and proves the module graph resolves INSIDE
# the image; it is a gate step, because a source tree cannot answer this question.
COPY --chown=app:app scripts/lib ./scripts/lib
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

# ---------------------------------------------------------------------------
# Webhook egress gateway: the ONE service in this product attached to a routable network.
#
# What is deliberately absent from this image, and why each absence is load-bearing:
#
#   node_modules      the bundle is self-contained (scripts/build-egress.mjs marks nothing
#                     external), so there is no Prisma client and no PostgreSQL driver here. This
#                     process could not open a database connection if it were asked to.
#   the source tree   one compiled entry point; no TypeScript loader, no scripts, no prisma/.
#   a database URL    never passed to this service by any compose file.
#   the encryption    never passed to this service either. It decrypts nothing: the worker signs
#   key              the body and hands over finished bytes.
#
# It publishes no host port in any compose variant. The only thing that can reach it is the worker,
# over a Docker network with `internal: true`.
FROM node:24-alpine AS egress
WORKDIR /app
ENV NODE_ENV=production
RUN addgroup -S app && adduser -S app -G app
COPY --from=build --chown=app:app /app/dist/egress ./dist/egress
COPY --chown=app:app package.json ./
USER app
EXPOSE 8082
CMD ["node", "dist/egress/index.mjs"]
