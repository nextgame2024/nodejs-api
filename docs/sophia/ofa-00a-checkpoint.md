# OFA-00A checkpoint — fail-closed business-pack boundary

Date: 5 October 2026  
Decision: complete; stop before OFA-00B authorization work

## Demonstrable outcome

The NestJS Runtime now contains a versioned `open-for-australia` business-pack
contract. It declares exactly five planned workspace routes:

- Dashboard
- Students
- Student Case
- Payments & Controls
- Sophia Assistant

The contract is disabled by default and is intentionally absent from the active
runtime registry. Xero TRUST, Xero PTY, protected document storage and assistant
tools are all `not-configured`; financial execution is `disabled`. Tests reject
accidental route expansion or financial enablement.

No endpoint, table, UI route, customer record, external connector or production
feature was introduced at this checkpoint.

## Verification

Executed with Node `v22.23.2`:

- Open For Australia and real-estate pack specs: 2 suites, 6 tests passed.
- `npm run build` in `sophia-runtime`: passed.
- `npm run test:p0:boundaries`: passed, 243 source files scanned.
- `npm run test:p0:real-estate`: 8 suites, 38 tests passed.
- Backend and frontend `git diff --check`: passed.

Database retirement was independently rechecked against the configured Neon
database after this checkpoint: zero `bm_student_*` tables remain.

## Next proposed checkpoint

OFA-00B establishes workspace authorization only: authenticated tenant binding,
an explicit Open For Australia entitlement, fail-closed 401/403 behavior,
cross-tenant denial and audit evidence. It must not create student or payment
tables yet.
