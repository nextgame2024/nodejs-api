# Open For Australia prerequisite — legacy student demo retirement

Date: 5 October 2026  
Outcome: source and configured-database retirement complete

## Changes

- Removed the legacy Express student-agency route, services, models and startup
  schema bootstraps.
- Removed consultation workers from the API and cron processes.
- Removed student-demo setup/import/release scripts, content and tests.
- Removed retired Nest student-agency tools.
- Removed retired Angular student guidance/consultation components and tests.
- Preserved the real-estate demo and updated its startup regression to assert only
  the retained inspection workflow.
- Permanently removed six `public.bm_student_*` tables and all 96 historical rows
  from the configured database without export or backup, under explicit owner
  instruction.

## Verification

Executed with repository-pinned Node `v22.23.2` unless stated otherwise:

- `npm run test:p0:boundaries` — passed, 241 source files scanned (the boundary
  command was also run under the shell's Node 20 before the pinned rerun set).
- `npm run test:p0:real-estate` — 8 suites, 38 tests passed.
- `npm run test:release` — 17 active suites, 66 tests passed; 2 suites/4 tests
  intentionally skipped by the existing configuration.
- `npm test` in `sophia-runtime` — 137 suites, 505 tests passed.
- `npm run build` in `sophia-runtime` — passed.
- `npx tsc -p tsconfig.app.json --noEmit` in the Angular app — passed.
- `GOOGLE_MAPS_API_KEY=dummy npm run build` in the Angular app — passed outside
  the restricted sandbox; existing bundle/CommonJS/stylesheet warnings remain.
- Pre-drop catalogue inspection found six matching tables, 96 rows and only
  internal foreign-key dependencies. The dependency-ordered SQL completed
  without `CASCADE`; the post-drop query returned zero matching tables.

No email, provider call, billing action or deployment was performed.
