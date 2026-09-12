# Evidence — Owner decision B7, option 3: staff-assisted enrolment

**Date:** 2026-09-12
**Performed by:** development agent (Claude Opus 5)
**Branch:** `rebuild/phase-0-foundation`
**Scope:** withdraw public self-service enrolment; add authenticated counter enrolment and card
restore. No other feature work.

---

## 1. Result

**Implemented.** Public self-service enrolment is withdrawn and cannot be reached by any route,
token or phone number. Cards are issued by authenticated staff at the counter, and a lost card link
is restored the same way.

**When this was written the Phase 1a engineering gate was NOT claimed to pass**, because
`docs/evidence/phase-1a-prompt-3.md` was BLOCKED on exactly this decision and had to be re-run.

> **Since resolved.** That gate was re-run at `bdd8731b53b4ed352e82573c79b41a6ebc7cc853` and
> **passed** — see `docs/evidence/phase-1a-prompt-3.md` §13, which is the authoritative result. The
> re-run found no Critical or High finding and changed no code; it recorded five new Medium and Low
> findings (M-10, M-11, L-15 to L-17). This document remains the implementation record for the
> change itself.

| Check | Result |
|---|---|
| `npm run gate` | **PASS 15/15 in 278.3 s** |
| `npm run test:e2e` | **12 passed (36.1 s)** |
| `npm audit`, full tree | **0 vulnerabilities** |
| `npm audit --omit=dev --audit-level=high` | **0 vulnerabilities** |
| Migration status | **up to date, none pending; no migration added** |
| `git diff --check` | **clean** |
| Real-device verification | **none performed, and none claimed** (§8) |

---

## 2. What the decision was

B7 asked how a public enrolment form can prove that whoever typed a phone number owns it. The form
has to issue a live card to a number with no card, and it must not hand an existing customer's card
to a stranger who types their number — and those two outcomes are distinguishable by whoever submits
the form, in any implementation. The form therefore reports whether a given number is a customer of
that business, to anyone, at scale.

`docs/evidence/phase-1a-prompt-3.md` §12.4 costed three options. **The owner authorized option 3 on
2026-09-12:** drop self-service issuance; staff hand the card over at the counter.

**No verification provider was added.** SMS OTP and WhatsApp (D2, D4) remain deferred, unauthorized
and unbuilt. **Public enrolment must not be re-enabled until proof of phone ownership exists and has
been independently audited.**

---

## 3. Public enrolment is withdrawn, without becoming an oracle

Removing a feature can leave the leak in place. A `404` for a dead token and a notice for a live one
still answer "is this link real"; an error that differs for an already-enrolled number still answers
"is this person a customer". Both were avoided by removing the *input*, not the output.

| Surface | Behaviour now | Why it cannot leak |
|---|---|---|
| `POST /api/enroll` | `410 ENROLLMENT_MOVED`, one constant body | `export async function POST(): Promise<NextResponse>` — the handler **takes no parameters**. There is no body, token or phone number in scope to branch on |
| `GET /api/enroll` | The same `410`, byte for byte | Probing the method reveals no difference |
| `/{locale}/join/{token}` | A static notice: ask a member of staff | The page **never reads the token**. No source lookup, no database call, so a real link and an invented one produce identical bytes, and neither performs a query that could differ in timing |
| Owner program screen | Guidance pointing at the Scanner | No link, no QR, no copy button. `publicEnrollmentUrl` is **deleted**, so nothing in the codebase can build such an address any more |

`src/server/program/enrollment-url.ts` was renamed to `public-urls.ts` and now exports only
`publicCardUrl`. The `direct` source's `publicToken` never leaves the server: the owner program API
returns no `enrollmentUrl` and no `enrollmentQrSvg`, and an integration test asserts that the
serialized response does not contain the token.

**Nothing was deleted.** Existing customer cards, card URLs, balances, programs, ledger rows, source
records and audit history are untouched. A customer holding their personal link still opens their
card; that is asserted in both an integration test and a browser test.

---

## 4. Counter enrolment

`src/server/customers/counter-enrollment.ts`, reached by `POST /api/scanner/enroll`.

- **Authorization.** `requireScannerContext` re-verifies an active membership of that business on
  every call, then `requirePermission(ctx, EDIT_CUSTOMERS)`. An anonymous caller is refused; a
  member of another business naming this one gets the same answer as for a business that does not
  exist.
- **The caller supplies nothing that decides anything.** The schema is a `z.strictObject` with four
  fields — `phone`, optional `firstName`, `lastName`, `marketingConsent` — plus an optional
  `businessId` that is verified rather than trusted. A body carrying `sourceToken`, `templateId`,
  `locationId`, `stampBalance` or `welcomeStamps` is **refused**, not ignored. Business, program,
  enrolment source and location are resolved server-side; Phase 1a's Main-only rule is unchanged,
  and `readJsonObject` still refuses a location under any nesting.
- **Consent** is an explicit tick at the counter. What is stored is the server's own timestamp plus
  `ENROLLMENT_CONSENT_VERSION` and the consent-text digest — the exact wording that was agreed to,
  not a boolean. The two consent strings moved, **unchanged**, from the `Join` namespace into their
  own `Consent` namespace, so the recorded version still describes the words the customer reads now
  that the screen showing them has moved. The digest is therefore identical and the version did not
  need to be bumped; `tests/unit/enrollment-consent.test.ts` proves it by hashing the strings at
  their new home.
- **One card, one welcome bonus.** The service delegates to `enrollCustomer`, whose
  `INSERT … ON CONFLICT DO NOTHING RETURNING` arbitration is what makes the bonus unique. A repeated
  staff enrolment creates no second customer, no second card and no second bonus; it returns the
  existing card to the authorized staff member and does not overwrite the stored name or consent.
- **A business with no loyalty card yet** gets a `404` telling staff to create the card first,
  rather than a half-enrolled customer.

---

## 5. Card restore

`revealCardLink`, reached by `POST /api/scanner/card-link`. It requires `VIEW_CUSTOMERS`, and the
card is looked up **filtered by `businessId`**, so another tenant's card id is "not found" rather
than "forbidden". It is never available publicly.

`POST` rather than `GET`, for two reasons: a card id in a query string lands in browser history on a
shared till device and in any proxy log switched on later, and this is not a read — it writes an
audit row.

---

## 6. What is never written down

Two audit actions were added, `CARD_ISSUED_AT_COUNTER` and `CARD_LINK_REVEALED`. `AuditLog.action`
is a plain `String` column, so **no migration was needed**.

| Record | Metadata |
|---|---|
| `CARD_ISSUED_AT_COUNTER` | `{ created, welcomeStampsGranted }` |
| `CARD_LINK_REVEALED` | `{}` |

Neither carries the card token, the card URL, the phone number or the customer's name, and neither
does any log line or error response on these paths. An audit log is read by more people, and kept
far longer, than the screen that legitimately shows a link; a reveal row containing the link would
be a second, quieter copy of the capability it was recording. Tests assert the absence of the
token, the URL and the substring `http` from the audit rows.

**`EDIT_CUSTOMERS` was added to the CASHIER role defaults.** With public enrolment gone, the cashier
is the only person who can hand a card over, and a merchant whose owner does not work every shift
would otherwise be unable to sign anyone up. Nothing else in Phase 1a guards that bit, so the grant
opens exactly one capability; the note beside `ROLE_DEFAULT_PERMISSIONS` says so, because the next
thing guarded by it must decide whether a cashier may do it. Owner-only actions are unchanged:
cashier creation still checks the **role**, and `EDIT_TEMPLATES`, `VIEW_DASHBOARD` and `EDIT_STAFF`
are still refused to a cashier.

---

## 7. Verification

### 7.1 Tests written for this change

`tests/integration/enrollment-withdrawn.test.ts` — 6 tests.

| Test | Asserts |
|---|---|
| `POST /api/enroll` for a live token | `410`, and the constant body |
| The same call for an enrolled number, a new number, a dead token and an empty body | **Identical status and identical bytes** in all four |
| Handler arity | `enrollPost.length === 0` — a structural assertion that no input reaches the handler |
| `GET /api/enroll` | The same `410` |
| No writes | No customer, profile, card or operation is created by any of it |

`tests/integration/counter-enrollment.test.ts` — 16 tests: creation with the link and QR; the stored
consent version, digest and server timestamp; a repeat that creates no second card, no second bonus
and does not rename the profile; two concurrent enrolments of the same number; a cashier allowed; an
anonymous caller refused; a member of another business refused; strict-schema refusals for
`sourceToken`, `locationId`, `stampBalance`, `welcomeStamps` and `templateId`; audit metadata free
of the token, URL, phone and name; `404` when the business has no program; and, for restore, staff
allowed, cashier allowed, public refused, cross-tenant refused, and an audit row containing neither
token, URL nor `http`.

`tests/e2e/enrollment-enumeration.spec.ts` — a real `/join/` token and an invented one render
byte-identical text in a browser; `/api/enroll` returns identical bytes for an enrolled number, a
new number, a dead token and an empty body; and a customer who already holds a card link still opens
their card.

`tests/e2e/owner-bootstrap.spec.ts` — the browser journey, rewritten end to end: an owner with an
empty account signs in, creates the loyalty card, sees **no** enrolment link or QR on the program
screen (and no `/join/` anywhere in its HTML), goes to the Scanner, searches a phone number that
finds nobody, fills the counter-enrolment panel and ticks consent, gets the card link and QR on
screen with the card loaded and the welcome stamp applied; then searches the number again, reveals
the link a second time as a restore, confirms it is the same link and that the `CARD_LINK_REVEALED`
audit row does not contain the token; and finally opens that link in a separate browser context as
the customer.

`tests/e2e/cafe-journey.spec.ts` was migrated off the removed public flow; `tests/integration/`
`public-enrollment-route.test.ts` was deleted with the endpoint it tested; the cashier and
permissions tests were updated for the `EDIT_CUSTOMERS` grant.

### 7.2 Commands run

| Command | Result |
|---|---|
| `npm run gate` | **PASS — 15/15 steps in 278.3 s** |
| `npm run test:e2e` | **12 passed (36.1 s)** |
| unit / integration | **276 in 20 files** / **389 in 33 files** |
| `npm audit` (full tree) | **0 vulnerabilities** |
| `npm audit --omit=dev --audit-level=high` | **0 vulnerabilities** |
| `npm run db:migrate:status` | **5 migrations, schema up to date, none pending** |
| `git diff --check` | **clean** |

Every command was run locally on this branch, on 2026-09-12, against the Dockerised test database
the gate brings up. The gate includes the two container checks — the migrate image's dependencies
and the web image answering on its own loopback. No migration was added: both new audit actions are
values of an existing `String` column.

---

## 8. What is NOT claimed

- **The Phase 1a engineering gate was not passed by this document.** It was passed later, by the
  re-run recorded in `phase-1a-prompt-3.md` §13.
- **No device testing was performed *in this prompt*.** Staging had not been updated when this was
  written, and nothing here was opened on a phone. The owner deployed this commit and ran the
  manual counter-flow regression afterwards; those results are theirs and are recorded in
  `phase-1a-prompt-3.md` §13.9.
- **No deployment, no OCI contact, no Caddy, DNS or secret access.**
- **No real customer data.** Every test uses generated Syrian phone numbers and generated emails.
- **No SMS, OTP or external verification provider** was added, configured or contacted.
- **Phase 1B was not started.**

---

## 9. Delivery

- Committed on `rebuild/phase-0-foundation`.
- `master` untouched at `b9ee686`.
- Only `rebuild/phase-0-foundation` pushed, to the private deploy remote.
