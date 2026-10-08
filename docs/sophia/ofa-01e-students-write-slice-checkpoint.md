# OFA-01E checkpoint — Students write slice

Date: 8 October 2026  
Decision: implemented in source; local UI review and migration/deployment remain pending

## Outcome

Chief Executive and Operations users in any `student_operations` workspace can
create and edit tenant-scoped student operational records. Advisors remain
read-only. The form is integrated into the existing Students page and uses the
Business Manager controls and local list/form loading boundaries.

The write contract validates bounded operational fields only. Passport, date of
birth, health/character, document and financial fields are not accepted by this
slice. Advisor choices are the intersection of active company users and active
Student Operations `advisor` entitlements.

Writes require an `Idempotency-Key`, reject duplicate student references and use
`record_version` optimistic concurrency. Successful frontend writes invalidate
the in-memory dashboard cache; ordinary navigation continues to reuse it.

Audit events are append-only and contain tenant, student, actor, event, record
version, correlation ID and changed field names. They do not duplicate student
field values. Idempotency records retain only student ID and record version, not
names or email addresses.

## Schema and API

- Migration `064_student_operations_student_writes.sql` adds record versions,
  tenant-isolated append-only audit events and tenant-isolated idempotency
  records.
- Migration `065_student_operations_write_least_privilege.sql` explicitly
  removes destructive privileges inherited by the runtime role.
- `GET /business-packs/student-operations/v1/workspace/advisors`
- `GET /business-packs/student-operations/v1/workspace/students/:studentId`
- `POST /business-packs/student-operations/v1/workspace/students`
- `PATCH /business-packs/student-operations/v1/workspace/students/:studentId`

Migrations 064 and 065 were applied to the configured production database after
deployment authorization on 8 October 2026. Read-only verification confirmed
the migration records, record-version column, forced RLS, append-only trigger,
empty student/audit/idempotency tables and the corrected runtime privileges. No
student records were created.

## Evidence run

- Sophia Runtime build: passed on Node 22.23.2.
- Focused Student Operations Runtime tests: 7 suites, 29 tests passed.
- Express real-estate regression: 8 suites, 38 tests passed.
- Angular application TypeScript check: passed.
- Angular spec TypeScript check: passed.
- Angular production bundling and Karma execution: blocked in this local macOS
  environment by a Node process abort (`malloc: Double free of object`) inside
  the Angular/esbuild build stage. The failure occurs before tests or application
  code execute; it must be rerun in the normal deployment/CI builder before the
  checkpoint is marked complete.

## Review gate

Do not deploy or run migration 064 until the owner has reviewed the local form.
After approval: resolve or bypass the local Angular builder crash in an approved
clean builder, run the UI specs, then commit, push, deploy and migrate as a
separate authorized step.
