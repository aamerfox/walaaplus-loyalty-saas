# Multi-stage build producing two images from one source tree:
#   --target web     Next.js standalone server
#   --target worker  pg-boss background worker (separate process, separate container)
#
# Owner deploys these; the agent never pushes images or deploys. See docs/PHASE-0-IMPLEMENTATION.md.

FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY prisma ./prisma
RUN npm ci --ignore-scripts && npx prisma generate

FROM node:24-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# Build-time only. Validation happens at RUNTIME start, so no real secret is needed to build.
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

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
FROM node:24-alpine AS worker
WORKDIR /app
ENV NODE_ENV=production
RUN addgroup -S app && adduser -S app -G app
COPY --from=deps --chown=app:app /app/node_modules ./node_modules
COPY --chown=app:app package.json tsconfig.json ./
COPY --chown=app:app prisma ./prisma
COPY --chown=app:app src/server ./src/server
COPY --chown=app:app src/worker ./src/worker
USER app
EXPOSE 8081
CMD ["npx", "tsx", "src/worker/index.ts"]
