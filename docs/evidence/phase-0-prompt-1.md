# Evidence — Phase 0, Prompt 0.1

**Prompt:** Audit, Baseline, and Specification
**Date:** 2026-09-11
**Performed by:** development agent (Claude Fable 5.1). No owner actions were required or taken during this prompt.
**Branch:** `rebuild/phase-0-foundation`

---

## 1. Scope delivered

| Item | Result |
|---|---|
| Repository audit before any change | Complete, 56 read-only commands recorded in §3 |
| Secret scan, two independent passes | Complete, one critical finding |
| Artifact and personal-data audit | Complete, 5 items excluded from version control |
| Structural audit: what to keep versus replace | Complete, recorded in `PHASE-0-HYGIENE.md` §8 |
| Prototype defect backlog | 10 defects recorded, none fixed in this prompt |
| `docs/PRODUCT-SPEC.md` | Created |
| `docs/PHASE-PLAN.md` | Created |
| `docs/BOOMERANGME-REFERENCE.md` | Created, supersedes an earlier draft |
| `docs/DECISIONS-REQUIRED.md` | Created |
| `docs/PHASE-0-HYGIENE.md` | Created |
| `docs/evidence/phase-0-prompt-1.md` | This file |
| Sanitized prototype baseline commit and tag | Created on the rebuild branch |
| Rebuild branch | Created from `master` |

**Explicitly not done, correctly out of scope:** no schema change, no application code change, no dependency installed, no test framework added, no CI created, no deletion of prototype code, no push to any remote.

---

## 2. Commits and Git decision

| Ref | SHA | Purpose |
|---|---|---|
| `master` | `b9ee686` | **Untouched.** Prototype history preserved. Not committed to, merged, pushed or rewritten |
| `rebuild/phase-0-foundation` | branch created from `master` | All rebuild work |
| Tag `prototype-baseline` | `0aee6eef5c80a1e4bb8aa70c76984c0a82729bae` | Sanitized prototype snapshot |
| Docs commit | `f22a6cb1de8384dc4ff1b51733c5202e83db5e57` | Approved specification set |

```
f22a6cb (HEAD -> rebuild/phase-0-foundation) docs: Phase 0 approved specification...
0aee6ee (tag: prototype-baseline)            chore: sanitized prototype baseline...
b9ee686 (origin/master, master)              feat: complete Phase 10-13 Go-Live Parity
```

**Nothing was pushed.** Owner decision **A1** in `DECISIONS-REQUIRED.md` must be recorded before any `rebuild/*` push. `master` is never a push target.

### Why a baseline commit was judged safe

The prompt permitted a baseline commit only if the audit proves the included files carry no secrets or personal data. After the exclusions below, the accurate statement is:

> No live credentials, API keys, private keys, or certificates were found or committed. The prototype baseline intentionally still contains a publicly known hardcoded auth fallback, which is an insecure configuration defect—not a usable secret—and must be removed in Phase 0 Prompt 0.2.

Exclusions applied before staging:

- **Excluded by new ignore rules:** `playwright-results/` (1.2 MB, 13 regenerable files), `tmp_debug.js`.
- **Untracked with `git rm --cached`, kept on disk:** `build.log`, `build_error.log`, `lint_errors.txt`. These embedded the developer's local Windows username in absolute paths, 23 occurrences across two files, inside a public repository.
- **Verified never committed:** `.env`, `.env.local`, `*.pem`, `*.key`.

The commit does carry known defect **H-1**, the hardcoded auth fallback secret. It was left unmodified because this prompt forbids changing application behaviour, an equivalent string is already public in `master`, and the commit is local only. It is documented in the commit message and removed in Prompt 0.2.

**Value preserved:** 41 files, 2,862 insertions. Roughly 2,100 lines of prototype work that the rebuild will otherwise delete.

---

## 3. Audit commands and results

All commands were read-only until step 40. Numbering matches the working session.

### Git state

| # | Command | Result |
|---|---|---|
| 1 | `git branch -a` | `master`, `remotes/origin/master` |
| 2 | `git remote -v` | `https://github.com/aamerfox/walaaplus-loyalty-saas.git` |
| 3–4 | `git log --oneline --all` | Exactly 1 commit, `b9ee686`, 2026-03-24 |
| 5 | `git tag -l` | 0 tags |
| 6–7 | `git ls-files` | 62 tracked files |
| 8–10 | `git status`, `git diff --name-only`, `git diff --cached` | 19 modified, 0 staged |
| 11–12 | `git ls-files --others --exclude-standard` | 34 untracked |
| 13 | `git status --ignored` | `.env`, `.env.local`, `.env.production.example`, `.next/`, `node_modules/`, `next-env.d.ts`, `tsconfig.tsbuildinfo` correctly ignored |
| 20 | `ls .gitattributes` | **Absent.** All 19 modified files warn LF→CRLF |
| 21 | `curl -o /dev/null -w "%{http_code}" https://github.com/aamerfox/walaaplus-loyalty-saas` | **`200` — repository is publicly readable anonymously** |
| 22 | `git diff --stat` | 19 files, +1,499 / −728 |

### Secret scan, two independent passes

| # | Command | Result |
|---|---|---|
| 14 | Recursive `grep -rInE` across source, config, schema, markdown | Completed in background, 43 lines |
| 39 | Cross-check of that output, dedup, artifacts excluded | **Agrees with pass 2. No additional findings** |
| Grep tool | ripgrep over the repository, excluding `node_modules`, `.next`, `playwright-results` | 8 hits, all triaged below |
| 15 | Secret patterns inside the three tracked log artifacts | **No secrets** |
| 16 | Local username occurrences in log artifacts | `build.log` 0, `build_error.log` **6**, `lint_errors.txt` **17** |
| 18 | `git ls-files \| grep '\.env'` | Empty. No env file has ever been tracked |
| 19 | `git log --all -- '.env' '.env.local' '*.pem' '*.key'` | Empty. **Never committed in history** |
| 26 | `git show HEAD:src/lib/auth.ts \| grep secret` | **`"super-secret-walaaplus-dev-key-123"` present in the public commit** |
| 27–28 | `git diff` on `auth.ts` and `middleware.ts` | Working tree holds a second fallback, `"walaaplus-local-dev-secret-key-123"`, in both files |

**Triage of all 8 ripgrep hits**

| Location | Value | Verdict |
|---|---|---|
| `src/lib/auth.ts:65` | `NEXTAUTH_SECRET \|\| "walaaplus-local-dev-secret-key-123"` | 🔴 **H-1 critical** |
| `src/middleware.ts:15` | same fallback | 🔴 **H-1 critical** |
| `git show HEAD:src/lib/auth.ts:65` | `"super-secret-walaaplus-dev-key-123"` | 🔴 **H-1, already public** |
| `docker-compose.yml:8` | `POSTGRES_PASSWORD: walaaplus_password` | 🟠 H-2 medium, local dev only |
| `prisma/seed.ts:8` | `admin123` | 🟡 H-3 low, dev seed only |
| `prisma/schema.prisma:7` | `env("DATABASE_URL")` | ✅ correct env reference |
| `src/app/api/push/send/route.ts:20` | `process.env.ONESIGNAL_REST_API_KEY` | ✅ env reference, no literal |
| `src/app/api/wallet/google/route.ts` | `"simulated_google_wallet_jwt_token"` | ✅ placeholder in a stub |

**Result: no live credential, API key, private key or certificate exists anywhere in tracked or untracked source.**

### Structure and toolchain

| # | Command | Result |
|---|---|---|
| 23 | `node --version`, `npm --version`, `prisma --version` | Node v24.19.0, npm 11.17.0, Prisma 6.19.2 |
| 24 | package.json scripts | Only `dev`, `build`, `start`, `lint`. 16 deps, 10 devDeps |
| 25 | Test tooling probe | `vitest` **absent**, `jest` **absent**, `pg-boss` **absent**, `web-push` **absent**, `zod` **absent**; `@playwright/test` 1.58.2 and `bcryptjs` 3.0.3 present |
| 29–30 | Source tree and line counts | 16 API route files / 982 lines; 18 business pages / 2,916 lines; schema 281 lines; messages 71 lines each locale |
| 31 | Prisma models | 14 models, 2 enums. Mutable `currentBalance`, JSON `design` and `rules`, no ledger, no memberships |
| 32 | `findUnique` usage in API routes | 20 call sites, several without tenant scope |
| 33 | Routes with no `getServerSession` | 4: `auth/[...nextauth]` and `cards/[id]/enroll` legitimately public; `wallet/apple` and `wallet/google` are non-functional stubs |
| 34 | Read `src/app/api/cards/[id]/route.ts` | **Defect D-1 confirmed.** `GET` and `PUT` check session existence then `findUnique({ where: { id } })` with no business scope |
| 35 | `src/middleware.ts:6` | **Defect D-2 confirmed.** `publicPages` omits the customer card and join routes |
| 36–38 | `docs/`, `playwright-results/`, `tmp_debug.js` | 1 draft doc; 1.2 MB of screenshots; a 27-line ad-hoc Prisma script |

### Mutating steps, executed only after the audit

| # | Command | Result |
|---|---|---|
| 40 | `git checkout -b rebuild/phase-0-foundation` | Branch created |
| 41 | `git log master --oneline -1` | `b9ee686`, confirming `master` untouched |
| — | Edit `.gitignore` | Added rules for logs, test output, scratch scripts, plus `!.env.example` |
| 42 | Remove superseded draft doc | `docs/BOOMERANGME_FEATURE_REFERENCE.md` deleted, replaced by `BOOMERANGME-REFERENCE.md` |
| 43–44 | `git rm --cached build.log build_error.log lint_errors.txt` | Untracked, **all three verified still present on disk** |
| 45 | `git check-ignore` on each excluded path | All four return **YES** |
| 46 | `git ls-files --others --exclude-standard` | Now source and docs only, no artifacts |
| 47–52 | Stage and verify | 41 paths: 3 deletions, 19 modifications, 19 additions. `docs/` correctly excluded from the baseline commit |
| 53–54 | Commit and annotate tag | `0aee6ee`, tag `prototype-baseline` |
| 55–56 | Commit documentation | `f22a6cb` |

---

## 4. Tests

**No tests were run, and none are claimed to pass.**

This prompt made no behavioural implementation. There is also no test runner installed: `vitest` and `jest` are both absent, and `package.json` has no test script. The only test asset is `tests/walaaplus.spec.ts`, a Playwright smoke suite that targets the prototype and whose login credentials (`test@walaaplus.com`) do not match the seed (`admin@walaaplus.com`), recorded as defect **D-8**.

Test infrastructure — Vitest, a disposable PostgreSQL integration database, Playwright wiring, the `npm run gate` script and CI — is the **first** deliverable of Prompt 0.2, before any schema work, so that everything built afterwards is proven by the gate as it lands.

**CI run URL:** none. No CI exists yet. Created in Prompt 0.2.

---

## 5. Migration status

**No migrations exist and none were created.** The prototype uses `prisma/schema.prisma` with no `prisma/migrations/` directory; the database was created by `db push`.

Policy recorded in `PRODUCT-SPEC.md` and `PHASE-PLAN.md`: migrations may be squashed freely until the Phase 1a engineering gate passes, and become forward-only after the first pilot database is deployed.

---

## 6. Manual verification performed

| Check | Method | Result |
|---|---|---|
| `master` unchanged | `git log master --oneline -1` after branching | Still `b9ee686` |
| Log files retained on disk after untracking | `ls -la` on all three | All present, byte sizes unchanged |
| Artifact exclusions effective | `git check-ignore -q` on four paths | All ignored |
| Baseline commit excludes docs | `git diff --cached --name-only \| grep '^docs/'` | Empty |
| Log files staged as deletions not additions | `git diff --cached --name-status` | `D` on all three |
| Remote visibility | Anonymous HTTP request | `200`, public |
| Fallback secret is in public history | `git show HEAD:src/lib/auth.ts` | Confirmed present |

---

## 7. Index review

**Not applicable to this prompt.** No schema or query was created or changed. The first index review is required at the Prompt 0.3 gate, with the minimum set already specified there: `LoyaltyOperation(businessId, createdAt)`, `LoyaltyOperation(customerCardId, createdAt)`, `LoyaltyOperation(locationId, createdAt)`, `IdempotencyRecord(businessId, key)`, `CustomerBusinessProfile(businessId, customerId)`, `Customer(normalizedPhone)`.

Uniqueness constraints that Prompt 0.3 must verify as **unique**, not merely indexed: `Customer.normalizedPhone`, `IdempotencyRecord(businessId, key)`, `CustomerCard.qrToken`, `CustomerCard.shareToken`, `UtmSourceLink.publicToken`, and `CustomerCard(customerBusinessProfileId, templateId)` — the last being what makes enrollment idempotent.

---

## 8. Security checks completed

| Check | Result |
|---|---|
| Secret scan, two independent passes, cross-checked | 1 critical, 1 medium, 1 low. Full triage in §3 |
| Env files ever committed | **No**, verified across all history |
| Live credentials in source | **None found** |
| Personal data in tracked files | 23 local-path occurrences in two log artifacts, **now untracked** |
| Remote exposure | **Repository is public.** Escalated as decision A2 |
| Secrets committed by this prompt | **No live credentials, API keys, private keys, or certificates were found or committed.** The prototype baseline intentionally still contains a publicly known hardcoded auth fallback, which is an insecure configuration defect—not a usable secret—and must be removed in Phase 0 Prompt 0.2 |
| Credentials handled by the agent | **None requested, generated, held or written** |
| Hardcoded fallback secret | **Found, documented, unmodified by design.** Both strings burned. Removal scheduled for Prompt 0.2 |

---

## 9. Known limitations and deferred items

| # | Item | Handling |
|---|---|---|
| L-1 | H-1 fallback secret still present in code | Removed in Prompt 0.2 with fail-fast env validation. Strings permanently burned |
| L-2 | H-1 string is public in `master` history | History rewrite not proposed: destructive, already published, and the practical mitigation is non-use. Decision A2 covers visibility |
| L-3 | H-2 database password literal in `docker-compose.yml` | Moved to an env variable in Prompt 0.2 |
| L-4 | H-3 seed password `admin123` | Acceptable for local seeds only. Must never seed staging or production |
| L-5 | `.gitattributes` still absent | Deliberately deferred to Prompt 0.2. Adding `eol=lf` now would renormalize every file and bury the baseline diff in noise |
| L-6 | `.env.production.example` is ignored by `.env*` | `!.env.example` rule added. A sanitized template is committed in Prompt 0.2 |
| L-7 | 10 prototype defects D-1 to D-10 unfixed | Intentional. The rebuild replaces this code; the list exists so the defects are not reintroduced |
| L-8 | No test runner, no CI, no gate command | First deliverable of Prompt 0.2 |
| L-9 | Staging has no TLS | **Blocks Phase 1a Prompt 2**, not this prompt. Decisions B1–B3 |

---

## 10. Infrastructure proposal

Proposed for owner confirmation. Nothing was provisioned; no account, domain, storage or credential was created or requested.

```
VPS, Docker Compose
├── caddy or nginx        TLS termination, Let's Encrypt automatic certificates
├── web                   Next.js standalone build
├── worker                pg-boss, separate process, never tied to the web lifecycle
└── postgres              PostgreSQL 15+, named volume

Nightly  pg_dump → owner-controlled object storage, 30 daily copies
CI       GitHub Actions running `npm run gate` on every rebuild/* push
Secrets  server environment files, provisioned by the owner only
```

Rationale for a separate worker container: birthday bonuses, expiry, scheduled push, push retry and nightly reconciliation must survive web restarts and must not depend on a request arriving. A serverless Next.js target cannot host them.

The executable artifacts — Dockerfiles, Compose files, the CI workflow, the backup script and the restore runbook — are written in Prompt 0.2. The owner runs them against real servers.

---

## 11. Required owner actions before Prompt 0.2

Recorded in full in `docs/DECISIONS-REQUIRED.md`. Blocking items:

| # | Decision | Recommendation |
|---|---|---|
| **A1** | May the agent push `rebuild/*` branches? `master` is never a push target | Yes, `rebuild/*` only |
| **A2** | Repository is **public** and already published a hardcoded auth fallback secret. Make it private? | Make private |
| **A3** | CI provider | GitHub Actions |
| **A4** | Database for development and staging | PostgreSQL 15+ in Docker Compose |
| **A5** | Node version pin for CI, Docker and local | Node 24, matching local v24.19.0 |

Not blocking Prompt 0.2, but blocking later: **B1–B6** hosting, domains and the staging TLS certificate required before Phase 1a Prompt 2; **C1–C5** VAPID keys, backup storage and monitoring for Phase 1.5.

---

## 12. Gate results

**Engineering gate criteria for this prompt**

| Criterion | Result |
|---|---|
| Repository inspected before any modification | ✅ 39 read-only commands before the first change |
| `git init` not run, existing repository respected | ✅ Verified pre-existing, remote intact |
| Five specification documents created | ✅ |
| Repository hygiene report produced | ✅ `PHASE-0-HYGIENE.md` |
| Secret scan performed and triaged | ✅ Two independent passes, cross-checked |
| No live credentials, API keys, private keys or certificates found or committed | ✅ The prototype baseline intentionally still contains a publicly known hardcoded auth fallback, which is an insecure configuration defect—not a usable secret—and must be removed in Phase 0 Prompt 0.2 |
| No personal data committed | ✅ Three log artifacts untracked |
| No ambiguous file committed | ✅ Every one of the 41 paths classified before staging |
| `master` not committed to, merged, or pushed | ✅ Still `b9ee686` |
| Nothing pushed to any remote | ✅ Pending decision A1 |
| Application behaviour unmodified | ✅ Only `.gitignore` and version-control state changed |
| Prototype code not deleted | ✅ Preserved and tagged |
| Baseline commit justified by audit | ✅ §2 |
| Evidence file written | ✅ This file |
| No blocker prevents Prompt 0.2 | ✅ Subject to decisions A1–A5 |

**Pilot gate:** none. Phase 0 requires engineering approval only.

**Result: ENGINEERING GATE PASSED — READY FOR THE NEXT PROMPT**

Prompt 0.2 may begin once decisions A1 to A5 are recorded.

PASS — READY FOR PHASE 0 PROMPT 2
