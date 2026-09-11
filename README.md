# WalaaPlus

Arabic-first, Syria-first digital loyalty platform for local businesses. The customer product is an
installable PWA loyalty card; the staff product is a QR and phone-lookup scanner; every change of
loyalty value is an immutable ledger row.

**Status:** Phase 0 (foundation) on branch `rebuild/phase-0-foundation`. `master` holds the original
visual prototype and is not built on.

## Documents

| Document | Purpose |
|---|---|
| [docs/PRODUCT-SPEC.md](docs/PRODUCT-SPEC.md) | Architecture and product rules — the source of truth |
| [docs/PHASE-PLAN.md](docs/PHASE-PLAN.md) | Phases 0–6, engineering gates and pilot gates |
| [docs/PHASE-0-IMPLEMENTATION.md](docs/PHASE-0-IMPLEMENTATION.md) | Local setup, worker, migrations, tests, gate, deployment boundary |
| [docs/DECISIONS-REQUIRED.md](docs/DECISIONS-REQUIRED.md) | Decisions only the owner can make |
| [docs/BOOMERANGME-REFERENCE.md](docs/BOOMERANGME-REFERENCE.md) | Feature reference mapped to phases |
| [docs/PHASE-0-HYGIENE.md](docs/PHASE-0-HYGIENE.md) | Repository audit and prototype defect backlog |
| `docs/evidence/` | Per-prompt evidence files |

## Quick start

```bash
cp .env.example .env        # fill in values; see the file for every variable name
npm ci
docker compose up -d db
npx prisma migrate deploy
npm run dev                 # web
npm run worker:dev          # background worker, separate terminal
```

## Engineering gate

```bash
npm run gate
```

Lint, typecheck, Prisma validation, unit tests, integration tests against a disposable PostgreSQL,
migration status, production build. CI runs the same command. Playwright end-to-end tests are
separate (`npm run test:e2e`) and start in Phase 1a.
