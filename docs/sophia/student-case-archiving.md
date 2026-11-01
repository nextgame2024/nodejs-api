# Case archive and restore

The student's related-case card now offers Archive to case managers. Confirmation explains that the case remains visible in read-only mode and that Restore reverses the action. The invoice creation button reads `+ Create`.

Archive changes the case to Closed / Terminated. Terminated is shown as progress step 6 only while the case is archived. It is excluded from the ordinary stage selector, and the workflow resolver rejects attempts to assign it through normal create/update requests. Cases closed through Payments Complete retain the normal five steps.

The case row stores `archived_at` and an internal snapshot of its previous stage, stored lifecycle status and closed date. Restore reinstates those exact values and clears the archive metadata. Both actions increment the record version, require `cases.manage`, enforce tenant/case access and optimistic concurrency, reuse durable write-request idempotency and produce one activity event.

API:

- `POST /cases/:caseId/archive` with `{recordVersion}` and Idempotency-Key.
- `POST /cases/:caseId/restore` with the same contract.
- Case detail and list projections expose `archived`; related-case rows include recordVersion for confirmation.

User mutations use the shared case authorization/lock guard, which rejects writes to archived cases. Upload preflight also rejects before storage provisioning, and upload/contact/discovery claims hold the case lock. Archiving refuses document writes, invoice edits/removals and contact provisioning only while their processing leases are live. Invoice creation blocks archive during its two-minute active-send window; each queued invoice reauthorizes and locks the case and refreshes that window before execution. Expired leases, abandoned creation attempts and `review_required` receipts no longer block an idle case. Retry receipts remain intact; archiving does not mark uncertain provider operations successful or replay them. No provider mutation is triggered by archive or restore.

The archived page suppresses editing, document mutation/review and invoice mutation controls while preserving document viewing/downloading, invoice details, activity and creation of another case for the same student. Related non-archived cases remain editable. Restore uses the former Archive action, with an explicit Restore title and confirmation. Refreshing related cases replaces stale row values so the action changes immediately. Background evidence/provider facts can still synchronize; automatic offer college assignment does not alter archived case fields, and closed cases are excluded from automatic document workflow advancement.

Deploy **112_student_case_archiving.sql** through the normal owner migration runner before the API/frontend. It adds archive metadata and archive workflow/write-request constraints without backfilling existing cases or changing runtime grants/RLS. No production migration or deployment was performed locally.

Verification:

- 132 ChromeHeadless case-page/invoice-editor tests passed, including confirmation/cancel, read access, Terminated step 6, ordinary closed-case progress, restore and stable retry identity.
- Five workflow unit tests passed, including archive-only assignment of Terminated.
- The new PostgreSQL archive regression passes: role/tenant/version rejection, pending-write protection, idempotent archive/restore, readonly case/checklist/document/invoice mutations, readable retained records, workflow automation exclusion and editing after restore.
- The complete PostgreSQL case suite has 36 passing tests and four existing failures. An isolated copy of committed HEAD has the same four failures (35 passing tests): document expiry expectations, a shared primary-contact fixture collision, automatic engagement-review hold expectations, and the consequent cleanup-fixture failure. The archive regression accounts for the additional passing test; these baseline failures were not changed for this task.
- Backend/frontend compilation and `git diff --check` passed.

Follow-up: false pending changes on Archive (2026-11-01)

The previous predicate counted every unfinished historical document/edit receipt and every uncertain invoice export indefinitely. It now distinguishes live execution from retained retry history. No data cleanup or additional migration is needed for this fix; deploy the updated Runtime API. Migration 112 remains the original archive feature prerequisite.

Verified with nine mocked invoice creation tests (including bounded concurrency, retry keys, per-send renewal and archive fencing), the focused disposable PostgreSQL archive regression (live edit/send rejection, expired upload/edit/creating receipts and review-required history, archive/restore and read-only guards), Runtime TypeScript and diff checks. No live provider requests or production changes were made.
