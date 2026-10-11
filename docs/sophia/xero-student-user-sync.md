# Xero Student user sync

Business Manager → **Sync users** is a Chief Executive-only, company-scoped workflow. It reads the same local TRUST register scope as Payments and Control. It does not call Xero or change financial totals.

## Deployment

1. Apply `scripts/sql/bm_user_student_fields.sql` if it has not already been deployed.
2. Using the database owner connection, apply `scripts/sql/bm_xero_student_user_sync.sql` to the database containing `public.users` and `sophia_runtime`.
3. Deploy/restart the Business Manager API (`src/server.js`) and deploy the frontend. The API starts the resumable sync worker. No Runtime grants or RLS policies are widened.

From the backend directory, with an owner URL supplied securely in the shell environment:

```sh
psql "$OWNER_DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/sql/bm_xero_student_user_sync.sql
```

Do not substitute the normal restricted Runtime connection. The migration creates no Student accounts. It seeds the new navigation label for existing student-operations companies; future companies can be assigned the label through Navigation links. Server authorization still requires an active Chief Executive in the same company.

## Operation

- **Check records** scans and groups current imported contacts without creating users.
- **Sync ready users** applies eligible groups only when a Chief Executive starts a run. Xero refreshes do not start Student-user sync runs.
- **Review** supports correcting name/email, explicitly linking an existing active `STD-…` Student from the same company, excluding an organisation, and reopening excluded records through a correction.
- Pending records show their original names, emails, transaction count, and reason. Search/status filters are paginated; recent runs show progress and failures.
- Corrections are local import decisions, not edits to Xero. Existing accounts' passwords, names, email and status are never overwritten by sync.

The confirmed prefix rule removes repeated leading letter-plus-number codes (`S15`, `C90`, `M30`, `O10`, etc.) with optional hyphens/whitespace. It preserves accents and internal name content. Matching is case-insensitive and company-scoped. Pure-number prefixes and obvious organisation names require review.

Accounts receive Student type, Active status, the existing transactional `STD-N` identifier, no staff entitlement, and an individually salted hash of the agreed temporary password. No welcome email is sent. Creation audit records include import provenance and temporary-password metadata for the future first-login feature; that feature is not implemented here.

## Identity and restart behavior

`bm_xero_student_contact_links` preserves stable Xero contact → Student mappings. `bm_xero_student_sync_candidates` stores normalized groups and manual decisions. `bm_xero_student_identities` validates the user/company/tenant relationship and is referenced by nullable `student_operations_xero_invoices.student_id`. The existing candidate-review UUID continues to identify operational student records and is not repurposed.

Provider upserts do not include the new student ID column. Reconciliation fills links on new transactions, preserves existing links, and refuses conflicting identities. A refresh or sync does not delete Student users. A distinct normalized name sharing an email remains pending, even if that email is unused in `users`.

Runs, per-group checkpoints, identity links, account creation, and audits persist in PostgreSQL. Bounded batches commit accounts and links together. Per-company transaction-scoped advisory locks and unique constraints protect concurrent runs and work with pooled database URLs; retries preserve IDs and passwords. Worker crashes roll back the current batch, and the next process resumes unfinished manually requested work. Failed runs retain previously committed batches and can be retried from the page. A revoked/inactive initiating Chief Executive cannot continue provisioning.

The worker performs bounded batches of 20 groups. PostgreSQL timestamps stay in PostgreSQL when comparing synchronization checkpoints, avoiding sub-millisecond rounding that could cause repeated scheduling.

## Verification

Focused unit tests: `tests/bm.studentUserSync.test.js`.
Isolated PostgreSQL integration tests: `tests/bm.studentUserSyncSql.test.js`, enabled only through `LOCAL_STUDENT_SYNC_TEST_DATABASE_URL` pointing at a disposable local database. They create fixture tables; never use a shared/deployed database. Frontend tests cover loading, corrections and desktop/mobile light/dark geometry.

No production migration or account import is part of local implementation verification.

Local verification on 2026-10-11: 28 focused backend tests passed, including 8 PostgreSQL integration cases; 6 ChromeHeadless frontend tests passed, including 390px/1440px light/dark checks. Angular production build and application/spec TypeScript checks passed. The build reported existing bundle/font budgets, an `events` CommonJS dependency, and the missing primeicons stylesheet warning. Both repository diffs passed whitespace checks.

Manual-only change verification on 2026-10-11: 10 backend unit tests and 8 focused ChromeHeadless tests passed; frontend application/spec TypeScript checks and backend syntax checks passed. The isolated PostgreSQL regression was updated to assert that even a legacy `automatic=true` flag cannot enqueue a run after Xero refresh, but could not be executed locally because no PostgreSQL server or Docker daemon was available. No production data or migration was touched.
