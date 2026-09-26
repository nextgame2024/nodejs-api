# P6-03B checkpoint — Verified privacy execution

Completed 25 September 2026.

## Delivered

- Verified subject access and deletion requests execute only after tenant/session ownership checks, identity verification, closed-session state and provider-cleanup checks.
- Runtime deletion removes session metadata, tool inputs/outputs, event payloads, review payloads, provider snapshots, raw errors and escalation subject content. It retains de-identified session rows, schema-limited metering, status/timing, command receipts and immutable audit evidence.
- Access requests return a bounded in-response snapshot with a SHA-256 digest. No second durable personal-data export is created.
- Each Runtime or external-owner target records immutable status, method, evidence reference, digest and result counts. A request remains blocked until every target is completed or verifiably not applicable.
- Business Manager has a dedicated owner adapter for command-linked booking, delivery and email-command data. It de-identifies contact fields and provider message identifiers atomically while retaining committed booking/workflow evidence.
- The Business Manager adapter requires the exact `bm:real-estate:privacy:write` scope. The legacy broad service token is not sufficient.
- The property-report PDF/cache is property-version data shared across deliveries, not a visitor-personal document. Privacy execution removes the subject-linked booking/delivery data without deleting this shared report.
- Retention runs accept only an approved persisted Runtime policy. They derive the cutoff from its recorded duration, exclude active holds, require durable subject binding and safe provider cleanup, and remain blocked when coverage is incomplete.
- Provider targets complete automatically only for an approved `not_stored` assessment. Backup/provider deletion otherwise requires external-owner evidence. Pre-session/automatic provider fallback remains disabled until equivalent data policies can be verified.

## Database and Neon verification

- Migration `024_privacy_execution.sql` was applied to the configured Neon database.
- Subject bindings, request events and retention-run evidence have forced RLS. Request events and retention runs are append-only; verified target evidence and privacy lifecycle deletion are database-protected.
- A rollback-only Runtime-role proof created a synthetic closed session with personal markers, executed the actual privacy service, recorded backup evidence, completed all six targets and verified no synthetic marker remained.
- The same rollback-only proof added an active hold and ran an approved 30-day synthetic retention policy: `heldCount=1`, `processedCount=0`. All synthetic rows were rolled back.

## Verification

- Sophia Runtime: portability-Core and production typechecks, build, contract drift check and 75 suites/282 tests passed.
- Business Manager release: 19 suites/78 tests passed; 4 SQL-gated suites/12 tests remained skipped by the existing environment gate.
- Boundary scan: 180 new-product files passed.
- Protected real-estate characterization: 8 suites/38 tests passed.
- No live provider deletion, backup operation, email, payment, production retention run or retained synthetic record was created.

## Plan refinement and remaining deployment gates

Plan 2.1.30 replaces the unsafe “delete generated personal documents” assumption with ownership-correct booking/delivery de-identification because the current PDF is a shared property cache. It also preserves immutable schema-limited operational evidence and blocks retention where subject binding or provider cleanup is incomplete.

No tenant retention duration or legal review was approved by this implementation. Live provider/backup evidence and deployment of an exact-scope Business Manager privacy credential remain production gates.

Next ready task: P6-A01 — build the permissioned Conversations and escalation operations console.
