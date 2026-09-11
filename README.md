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
| [docs/PHASE-1A-IMPLEMENTATION.md](docs/PHASE-1A-IMPLEMENTATION.md) | Stamp-café domain: mechanics contract, enrollment, the stamp engine, authorization |
| [docs/STAGING-RUNBOOK.md](docs/STAGING-RUNBOOK.md) | Deploying to HTTPS staging: DNS, secrets, migration order, health, backups, rollback, certificates |
| [docs/DECISIONS-REQUIRED.md](docs/DECISIONS-REQUIRED.md) | Decisions only the owner can make |
| [docs/BOOMERANGME-REFERENCE.md](docs/BOOMERANGME-REFERENCE.md) | Feature reference mapped to phases |
| [docs/PHASE-0-HYGIENE.md](docs/PHASE-0-HYGIENE.md) | Repository audit and prototype defect backlog |
| `docs/evidence/` | Per-prompt evidence files (latest: `phase-1a-prompt-2-cohost-config.md`) |

## Quick start

```bash
cp .env.example .env        # fill in values; see the file for every variable name
npm ci
docker compose up -d db
npm run db:migrate          # migrations, as the owner/migrator role (MIGRATE_DATABASE_URL)
npm run db:roles            # create the restricted runtime role that DATABASE_URL names
npm run dev                 # web
npm run worker:dev          # background worker, separate terminal
```

Web and worker connect with a **restricted runtime role** that can append to the ledger but never
update, delete or truncate it, alter a table, or touch a trigger. Migrations run as a separate
owner role. See [docs/PHASE-0-IMPLEMENTATION.md §4](docs/PHASE-0-IMPLEMENTATION.md).

## Engineering gate

```bash
npm run gate
```

Production dependency audit (zero high/critical), lint, typecheck, Prisma validation, unit tests,
migrations and runtime-role grants on a disposable PostgreSQL, integration tests connected as the
runtime role, production build. CI runs the same command. Playwright end-to-end tests are
separate (`npm run test:e2e`) and start in Phase 1a.
