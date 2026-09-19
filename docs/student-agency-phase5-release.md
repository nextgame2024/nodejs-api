# Phase 5 — Combined demo and release validation

Validation date: 19 September 2026, Australia/Brisbane.

Status: automated validation and an actual consultation email rehearsal passed.
The user confirmed receipt in the inbox at `jlcm66@gmail.com`. Backend/runtime release `876b69f` has been published and verified live through the
runtime: both property searches and inspection slots, official GS comparison and
student consultation slots passed. Frontend release `83cadf2` is pushed; public
asset activation is still being checked. A production-path demo booking exposed a
pooled advisory-lock issue; the follow-up fix uses a transaction-scoped lock with
an explicit transaction and a new lock key, avoiding old orphaned session locks.
Final production delivery and live avatar rehearsal are still being checked.

## Verified evidence

| Check | Result |
|---|---|
| Backend unit/regression suite | 60 tests passed; includes purchase report jobs, inspection email workers, rental confirmation, student sources and consultations |
| PostgreSQL release suite | 11 tests passed; temporary-schema tests and EXPLAIN-only production query validation |
| Runtime suite | 50 tests passed; includes cross-domain review invalidation and independent sessions |
| Browser suite | 14 tests passed; cards, late responses, edited email, consent and confirmation turns |
| Real consultation email | One additional opt-in test passed; SES accepted, user confirmed inbox receipt |
| Runtime build | Passed |
| Frontend production build | Passed; existing budget/CommonJS/PrimeIcons warnings remain |

The live email used the actual authenticated Express consultation routes, PostgreSQL
booking/queue, recipient correction, queue claim and SES sender. Its calendar was
isolated from public demo appointments and removed after the test. The appointment
was explicitly labelled demo; no real adviser meeting was created. Reference in
the received email: `d8fb99ee-6f95-4ca0-9d13-4d9c7d48eab2`.

Live database preflight found three rental and three sale listings, each with five
available inspections, plus twelve student consultation times returned by the
separate demo calendar. Home Affairs GS, application/checklist and Department of
Education work sources were fetched successfully and saved as fresh snapshots.
The GS comparison returned `supported_comparison`. This does not establish that
all migration requirements or all recent changes have been verified.

Production-path demo booking: `2ae313fa-bf71-4df1-a8c5-9198226b7073`,
recipient `jlcm66@gmail.com`, 21 September 2026 at 10:00 Brisbane time.

Changes found during release review:

- Worker advisory locks now use an explicit transaction and transaction-scoped
  lock so transaction-mode connection pools cannot strand the lock on a different
  database backend. A new key bypasses old session locks without terminating
  database connections. SQL tests verify contention and release.

- Consultation email supports both the app's existing `SES_FROM`/`SES_REGION`
  configuration and the newer `SES_FROM_EMAIL`/`AWS_REGION` names, with newer
  settings taking precedence.
- SMTP results must accept the actual recipient before the queue records `sent`.
- Closing student guidance or returning to property photos/panels invalidates the
  pending student review in the runtime, matching the frontend.
- Release test commands separate backend JavaScript tests from the nested runtime
  TypeScript suite. The old unrestricted root Jest invocation discovers the wrong
  project and an empty legacy auth test; use the commands below.

## Repeatable release checks

From `backend`:

```sh
npm run test:release
npm run test:release:sql
node scripts/check-student-demo-release.mjs --company-id=81c2f065-aceb-4043-add5-b11271d21fb3
```

The SQL command requires the configured database. Tests create isolated fixtures,
remove them after execution and send no emails by default. The preflight script
refreshes only known demo calendars and official snapshots. It never books,
publishes FAQ drafts or processes queued emails. Add `--require-deployed` to fail
when the public student route is missing. A 401 checks route presence only, not
service-token correctness or deployed worker health.

From `backend/sophia-runtime`: `npm run build && npm test`.
From `frontend`, using Node 20.19.1 or the project's supported newer version:
`npm run test:sophia` and `GOOGLE_MAPS_API_KEY=dummy npm run build` for local build
validation. Use the actual configured Maps key for a production frontend build.

The live-email test is deliberately disabled in normal test runs. Run only with
recipient consent; each invocation sends one actual demo confirmation:

```sh
EMAIL_LIVE_TEST_RECIPIENT=jlcm66@gmail.com INSPECTION_SQL_TEST_DATABASE=1 \
NODE_OPTIONS="--experimental-vm-modules --import=dotenv/config" \
node node_modules/jest/bin/jest.js --runInBand tests/bm.studentConsultationSql.test.js
```

## Five-minute demo and live acceptance

1. Ask: “What documents do I need for an Australian student visa?” Expect official
   evidence with source links/check dates and relevant context questions.
2. Ask: “What changed from GTE to Genuine Student? How does that affect a new
   application and someone already studying?” Expect a supported comparison with
   dates; no inference that current students are universally exempt.
3. Ask: “Can I book a time to discuss my situation?” Choose a clearly labelled demo
   slot, enter name/email, review, optionally include a summary and confirm.
4. Check the booking time, demo label, recipient and separate delivery status.
   Correct the email through the review flow if needed; never claim receipt from
   queued status alone.
5. Switch to: “Show me rentals in Brisbane,” then “Now houses to buy.” Inspect the
   results, ask for inspection times and verify panels switch cleanly. Rental
   confirmation has no property report; purchase confirmation queues the report.
6. Ask an ambiguous question such as “What do I need for my application?” after a
   topic change. Sophia should clarify the application type when context is unclear.
7. Rehearse a missing historical comparison and an official-source outage. Show
   dated fallback or uncertainty and offer a consultation without invented rules.

Repeat the live conversational route on Essential, Professional and Premium before
presenting those plans as accepted. Automated shared-path and provider tests passed;
actual voice, camera, lip sync and provider-account availability still need a live
session. Agency name, services, actual adviser calendar and FAQ approval remain
separate onboarding requirements. The twenty seeded FAQ records remain drafts.

## Deployment sequence and fallback

1. Publish the verified backend changes to the backend release branch. Deploy
   `nodejs-api` first; confirm student routes and the `[STUDENT_CONSULTATION] Email
   worker started` log. The schema is additive and already prepared for the demo.
2. Deploy `sophia-runtime-api` from the same backend revision. Verify its existing
   Business Manager URL/token/company configuration. No new paid worker or daily
   cron is needed. The existing toolkit cron is unrelated to consultation delivery.
3. Publish/deploy the frontend only after backend/runtime readiness. Retain actual
   production build environment settings.
4. Run the deployed preflight and the live conversation matrix above. Check queue
   state and delivered email before the presentation. The local rehearsal does not
   prove that production email credentials or the deployed worker are configured.

If a service fails, restore its previous app revision and leave the additive tables
and records in place. Do not drop tables or reset calendars to roll back code.
Do not manually rerun a sent queue item to diagnose deployment: it can duplicate an
email. Inspect delivery status/error first, then use the confirmed resend flow.
