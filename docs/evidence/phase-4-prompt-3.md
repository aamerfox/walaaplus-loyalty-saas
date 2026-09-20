# Phase 4 Prompt 3 — isolated-worktree evidence

## 0. Provenance

| Item | Result |
|---|---|
| Absolute worktree | `C:/Users/aamer/Desktop/projects/loyality card/loyalty-platform/.freebuff/worktrees/f52cc4f1-bc5f-45e5-b19c-e97cbe18979b` |
| Git top-level | Same as absolute worktree |
| Baseline SHA | `59ae457acd6739071250fed895f63eb28de64498` |
| State | Detached HEAD; all Prompt 3 changes remained uncommitted |
| Test database | Disposable isolated Compose database; integration/gate runs used host port `5437` because `5435` was occupied by the separate main-checkout container |
| Migrations | Migrations 1–22 applied on every rebuilt disposable database; no migration file was changed |
| Runtime grants | Applied with the migrator role before each integration run and by the gate |
| Main checkout | Never used for any test, Playwright, gate, migration, Docker, or build command in this evidence pass |

## 1. Prompt 3 implementation proof

`NewProgramForm.tsx` contains shared parser call sites:

- `inputToMinor` and `percentToBasisPoints` imported from `@/lib/money-input`.
- Threshold parsing at lines 103 and 176.
- Rate parsing at lines 105 and 177.
- `minorToInput` is used for display conversion.
- The forbidden expression `Math.round(Number(tier.rate) * 100)` is absent.

Modified/untracked Prompt 3 files and SHA-256 recorded before the final gate/checks and unchanged afterward:

```text
80d00211cfe14f8619ba94696498270e74e9a5c6618fad8d855ac9ad01990e3e  docs/DECISIONS-REQUIRED.md
f636b006a8960d918b5dbddf719518dad2dd3507dc1cdfa8f49cd4ad131b9cd1  messages/ar.json
ef175de51fd4c27bf6ad991227726d7e8020f2ae252e5ee2a73084f18b5d8080  messages/en.json
6eb4a388408e97fed60200129e1d63926663446d8827457df1a22cf8abb66def  src/app/[locale]/business/programs/new/NewProgramForm.tsx
88c3f34efac1099cba920ee8d37ba595a038a1f9ea7919a922962e3885282513  src/app/[locale]/business/programs/new/page.tsx
92bedd9d4002896a3077807d0f46d6269c2b0ac7d0213699b60d2f13302eccb2  src/server/monetary/draft.ts
9d27f16b734bcff893c3c7ac4fb0714b5c98555e5445be3068c3fb9502fa1ee0  src/server/monetary/rules.ts
243cd73ad150b4d87fe5048a976f34608377898b7002e0b80d18d8c5024f5971  src/server/program/program-detail.ts
e9e7abd978fbf016f6cc7f74182b1b18721a2e902f3f02b32a600cbc270e386a  tests/e2e/money-ui.spec.ts
```

## 2. Independent fresh-database integration suites

### Run 1

- Disposed/recreated the isolated test DB.
- Applied migrations 1–22 and runtime-role grants.
- `80` test files passed; `1,325` tests passed.
- Vitest duration: `809.46s`.
- Wall duration: `821s`.
- Exit: `0`.
- Race proofs passed:
  - overlapping sequence writers: `7,444ms`;
  - concurrent redemption with one affordable result: `2,109ms`;
  - concurrent reversal: exactly one success, one compensating group, correct balances: `4,427ms`.

### Run 2

- Independently disposed/recreated the isolated test DB.
- Applied migrations 1–22 and runtime-role grants.
- `80` test files passed; `1,325` tests passed.
- Vitest duration: `807.80s`.
- Wall duration: `819s`.
- Exit: `0`.
- Race proofs passed:
  - overlapping sequence writers: `7,467ms`;
  - concurrent redemption with one affordable result: `2,095ms`;
  - concurrent reversal: exactly one success, one compensating group, correct balances: `4,451ms`.

## 3. Activation-trigger red proof

- Disposable DB only; no repository migration or schema file changed.
- Temporarily disabled only `program_version_validate_money_activation`.
- Incomplete CASHBACK activation succeeded: `RED_PROOF_TRIGGER_REMOVED=INCOMPLETE_ACTIVATION_SUCCEEDED`.
- Trigger restoration succeeded: `RED_PROOF_TRIGGER_RESTORED=YES`.
- A fresh incomplete activation after restoration was refused with `needs at least one rate to be activated`.
- Exit: `0`; wall duration: `15s`.

## 4. Full Playwright

- Isolated run 1: `153 passed`, exit `0`, wall duration `344s`.
- Isolated run 2: `153 passed`, exit `0`, wall duration `324s`.
- Both runs included the full suite, not only the money subset.

## 5. Complete isolated gate

The first gate invocation stopped at `test db up` only because the unrelated main-checkout test container occupied host port `5435`; it did not execute against the main checkout. The complete retry used only this isolated worktree and disposable port `5437`.

- `npm run gate`: `16/16` steps passed.
- Wall duration: `712s`.
- Integration step inside gate: passed.
- Dependency audit: `0 vulnerabilities`.
- Lint, typecheck, Prisma validation, migrations, runtime grants, worker build, egress build, production build, migration-image dependency check, and web-image health: passed.
- Exit: `0`.

## 6. Final checks on the isolated worktree

- `npx eslint . --max-warnings=0`: passed.
- Typecheck: passed.
- Prisma validation: passed.
- Production dependency audit: `0 vulnerabilities`.
- Test database migration status: `Database schema is up to date!`; 22 migrations found/applied.
- Migration diff from `59ae457`: clean; migration files unchanged.
- `git diff --check`: passed.
- `git diff --check 59ae457..HEAD`: passed.
- Narrow capability URL scan: no `?card=`, `customerCardId` query parameter, `qrToken` query parameter, or `shareToken` query parameter in `src` or `tests`.
- Recorded Prompt 3 file hashes matched before and after every long run and final check.

## 7. Final worktree state

The isolated worktree remained at baseline SHA `59ae457acd6739071250fed895f63eb28de64498`, with only the nine modified Prompt 3 tracked files and this evidence file uncommitted. No commit, push, deploy, reset, cleanup, protected-roadmap edit, `.freebuff` metadata edit, or migration edit was performed.

**PROMPT 3 VERIFICATION PASSED IN THE EXACT ISOLATED WORKTREE — AWAITING REVIEW/COMMIT INSTRUCTION**
