# Owner Decisions Required

These decisions cannot be made by the development agent. They involve accounts, money, credentials, legal exposure, or authority the agent does not hold.

The agent may propose defaults and write runbooks. **The agent must never request, generate, hold, paste, or commit live credentials.**

Status key: ⬜ open · ✅ decided · ⏸ deferred to a later phase

---

## A. Blocking Phase 0, Prompt 0.2

These must be answered before infrastructure, CI or deployment work proceeds.

| # | Decision | Recommended default | Status |
|---|---|---|---|
| A1 | **Rebuild-branch push permission.** May the agent push to `rebuild/*` branches on the existing GitHub remote? `master` is never pushed to under any circumstance. | Yes, `rebuild/*` only; `master` changes only through a pull request the owner merges | ⬜ |
| A2 | **Repository visibility.** The remote `github.com/aamerfox/walaaplus-loyalty-saas` is **currently public** (verified anonymous HTTP 200). Should it become private before the rebuild? | Make private. A public repo published a hardcoded auth fallback secret, see [PHASE-0-HYGIENE.md](PHASE-0-HYGIENE.md) finding H-1 | ⬜ |
| A3 | **CI provider.** | GitHub Actions, since the remote is already GitHub | ⬜ |
| A4 | **Database for development and staging.** | PostgreSQL 15+ in Docker Compose for local and staging; managed Postgres optional later | ⬜ |
| A5 | **Node version pin.** Local is Node v24.19.0, npm 11.17.0. CI and production must match. | Pin Node 24 LTS in `.nvmrc`, CI and Dockerfile | ⬜ |

---

## B. Blocking Phase 1a, Prompt 2

Service workers, installability and web push **refuse to run without TLS**, except on `localhost`. Staging cannot verify the PWA card without a real certificate.

**B1, B2, B3 and B7 are answered.** Staging is live over HTTPS and the Phase 1a Prompt 2 real-device checks passed against it on 2026-09-12. B7 was decided on 2026-09-12 and is implemented. B4 to B6 remain open.

| # | Decision | Recommended default | Status |
|---|---|---|---|
| B1 | **Hosting.** Where do the Next.js standalone container, the pg-boss worker container and PostgreSQL run? | One VPS running Docker Compose, in or near the target region | ✅ An OCI host, co-hosted with existing services; see [STAGING-RUNBOOK.md §13](STAGING-RUNBOOK.md) |
| B2 | **Staging domain.** | A subdomain of a domain the owner controls, for example `staging.walaaplus.<tld>` | ✅ Supplied by the owner and serving |
| B3 | **HTTPS certificate for staging.** ~~Hard prerequisite for Phase 1a Prompt 2 verification.~~ | Caddy or nginx with Let's Encrypt automatic certificates | ✅ The host's existing Caddy, over ACME. The Prompt 2 manual gate it blocked is complete |
| B4 | **Production domain.** | Decided before the café pilot goes live | ⬜ |
| B5 | **Secrets provisioning.** Who creates the `.env` values on each server, and where are they stored? | Owner provisions server environment files directly; agent supplies variable names and generation commands only | ⬜ |
| B6 | **Production deployment authority.** | Owner only. Agent never deploys to production | ⬜ |
| B7 | **Phone-ownership verification at enrolment.** Public self-service enrolment had to issue a live card to a new number and reveal nothing for an existing one; those two outcomes are distinguishable by whoever receives the result, for any implementation, unless the submitter can be shown to own the number. Options were costed in `docs/evidence/phase-1a-prompt-3.md` §12.4. | **✅ Decided 2026-09-12 — Option 3: public self-service enrolment is withdrawn.** Cards are issued by authenticated staff at the counter, and a lost link is restored the same way. No SMS or WhatsApp verification is added: D2/D4 stay deferred. **Public enrolment must not be re-enabled until proof of phone ownership exists and has been independently audited.** Implementation and evidence: [phase-1a-b7-option-3.md](evidence/phase-1a-b7-option-3.md) | ✅ |

---

## C. Blocking Phase 1.5

| # | Decision | Recommended default | Status |
|---|---|---|---|
| C1 | **VAPID key pair for web push.** The private key is a real secret. The agent supplies the generation command and the variable names; the **owner generates and stores the keys** for staging and production separately. | `npx web-push generate-vapid-keys`; store as `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` | ⬜ |
| C2 | **Backup destination.** Where do nightly database dumps go, and who owns restore? | Object storage the owner controls, with a documented and rehearsed restore drill | ⬜ |
| C3 | **Backup retention and restore ownership.** | 30 daily dumps; owner performs the restore drill in staging with the agent's runbook | ⬜ |
| C4 | **Error and uptime monitoring.** | Self-hosted or free-tier service; owner creates the account | ⬜ |
| C5 | **Minimum daily scanner volume** that defines a valid pilot day, per merchant. | Owner sets a number, for example 10 scans per operating day | ⬜ |

---

## D. Phase 2 and later, product decisions

| # | Decision | Status |
|---|---|---|
| D1 | **Cashback and discount pull-forward.** Build in Phase 2 only on confirmed pharmacy or retail demand. If built there, Phase 4 Prompt 1 becomes an audit only. | ⏸ |
| D2 | **SMS provider for Syria.** Required before automated card delivery, OTP restore or SMS campaigns. Phase 2 Prompt 2 built the drafts; nothing can leave the system until this is answered. Twilio may not serve the market. | ⏸ |
| D3 | **Email provider.** Required for password reset in the MVP and campaigns later. | ⬜ needed for password reset |
| D4 | **WhatsApp Business API access.** | ⏸ |
| D5 | **Archiving a program.** Phase 1b Prompt 3 built pause and resume, and deliberately left `ARCHIVED` unreachable from the product: what should happen to the cards pinned to an archived program's versions — keep earning, freeze at their balance, or be redeemable only — is a merchant-facing decision, not an implementation detail. Nothing is blocked by it today; pausing covers every case a pilot merchant has. | ⬜ |
| D6 | **Per-actor counter limits.** Prompt 3 bounds one staff account to 60 enrolments and 300 counter writes an hour (finding M-11). They are code constants, because a configurable limit needs environment-template changes that prompt could not make. If a real merchant's busiest hour approaches either number, the owner decides the new figure and whether it becomes per-business configuration. | ⬜ |
| D7 | **Customer export.** Phase 2 Prompt 1 built the customer record and deliberately did not build an export: a downloadable customer list needs a retention period, a named authorization bar, an audit contract and a decision about what may leave the system at all. The owner decides those before it is built; nothing is blocked until a merchant asks for one. | ⬜ |
| D8 | **Re-consent of the unknown records.** Every enrolment taken before the consent version was recorded reads as `UNKNOWN` and may not be contacted — the count is on each customer's record and in every audience preview. The owner decides whether staff go back and ask those customers again, and what wording they are asked with. Nothing is blocked; the product simply will not treat the gap as a yes. | ⬜ |
| D9 | **Consent retention and erasure.** Nothing in this build deletes a consent record, by design: an editable consent history is not evidence. A retention period, and what happens to the history when a customer asks to be erased, are owner decisions with legal weight and are deliberately not guessed here. | ⬜ |
| D10 | **Per-channel consent.** The record says "marketing", not "SMS but not email". Splitting it is cheap to add and impossible to backfill honestly, so it waits until a channel exists to consent to — blocked behind D2/D3/D4. | ⏸ |
| D11 | **What a sign-off commits to, once delivery exists.** Prompt 3 answered half of this: review and approval are now distinct, an approval names one exact revision and one declared channel, and it is append-only. What is still open is what approval will MEAN when a message can actually leave the system — whether an approved campaign may be dispatched without a second confirmation at the moment of sending, and how long an approval stays valid before it must be taken again. | ⬜ |
| D12 | **A second approver.** Approval today needs one person holding `EDIT_PUSHES` with access to every branch. A mandatory second approver is deliberately not built: a pilot merchant is one person, and requiring two would mean requiring them to create a second account to approve their own campaign. The owner decides when a business has staff who are not its owner, and whether the bar should rise then. | ⬜ |
| D13 | **Audience snapshot retention.** An approval freezes a list of internal profile references — no contact data, but still a record that a named group of customers was approved as a marketing audience on a date. Nothing deletes one, and no retention period is invented here. The owner decides how long a snapshot is kept, and what happens to one when a customer asks to be erased. Related to D9. | ⬜ |
| D14 | **The snapshot ceiling.** Approval refuses an audience larger than 50,000 customers, on the grounds that a person cannot meaningfully approve a message to more people than that in one decision. It is a code constant. If a real merchant's list approaches it, the owner decides the new figure — and whether the right answer is a larger number or a different review process. | ⬜ |
| D15 | **Referral attribution and reward policy.** Phase 3A Prompt 1 built the sharing and none of the crediting: who is rewarded for an invitation, on what evidence, when, and within what limits. It is deliberately unbuilt because the obvious implementations are all wrong — a link click is not proof of a referral, a QR scan is not proof of a person, and the public link enrols nobody, so there is no moment that honestly says "this person joined because of that person". The owner decides the policy; until then no string in the product may promise a reward for sharing. | ⬜ |
| D16 | **Wallet device-token retention.** Keeping a pass up to date on a phone means registering the device: Apple stores a device library identifier and a push token per pass, Google a save/delete callback. Both are a new category of customer data, and neither has a retention rule. Needed before pass updates, not before the link. Related to D9 and D13. | ⬜ |
| D17 | **Location relevance on a wallet pass.** Both platforms can surface a pass when a customer is near a branch. Neither sends the location anywhere — the common misreading — but it is still a location-triggered behaviour the customer did not ask for, and the product's only consent scope is MARKETING. The owner decides whether a lock-screen appearance is marketing, and on what basis. Branch coordinates are not stored today either. | ⬜ |
| D18 | **Wallet notifications.** A Google pass message and an Apple pass update can both raise a notification. That makes them a messaging channel, and this product has a consent contract governing those. Using them without routing through it would be a side door around it. The owner decides whether they count as marketing. Note also that **an accepted API call is not a delivered notification** — neither platform reports whether one was shown or read. | ⬜ |
| D19 | **One card, one person or one household.** Google Wallet's `multipleDevicesAndHoldersAllowedStatus` decides whether a loyalty object may be saved by more than one person. Left unset rather than guessed: it is a product question about what a card IS, not a platform setting. | ⬜ |

---

## E. Phase 5, commercial and legal

None of these may be started by the agent without an explicit written decision.

| # | Decision | Status |
|---|---|---|
| E1 | **Payment provider.** Stripe does not operate in Syria. Agency billing needs an alternative or a foreign entity. | ⏸ |
| E2 | **Supported countries and currencies** for the agency market. | ⏸ |
| E3 | **Legal entity, tax and invoicing responsibility.** | ⏸ |
| E4 | **Subscription model and pricing** for merchants and agencies. | ⏸ |
| E5 | **Refund policy.** | ⏸ |
| E6 | **Apple Developer account** for Wallet passes, $99 per year, plus obtainability from the region. | ⏸ |
| E7 | **GoHighLevel Marketplace publication.** Private app first; public listing needs explicit owner approval. | ⏸ |

---

## F. Standing rules

1. The agent never handles live credentials. It writes variable names, generation commands and runbooks.
2. The agent never pushes to `master`, never force-pushes, never rewrites published history.
3. The agent never deploys to production.
4. Every evidence file records which steps the agent performed and which the owner performed.
5. Any decision above that becomes blocking mid-phase halts that prompt with `ENGINEERING GATE NOT PASSED — BLOCKED BY: <decision id>`.
