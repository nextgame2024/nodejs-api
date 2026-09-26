# P6-A04 checkpoint — Audit logs explorer and controlled exports

Completed 25 September 2026.

## Delivered

- ADM-15 is available at `/sophia-admin/audit-logs` with tenant-scoped filters for actor, event type, outcome, resource, correlation identifier and date range, stable cursor pagination and redacted detail.
- Existing audit metadata is recursively re-redacted at list, detail and export boundaries. New records are depth/size bounded and redact credential, authorization, prompt/content, transcript/audio and direct-contact fields.
- A global Admin interceptor records allowed and failed privileged requests with actor, route/target, required permission, outcome and correlation ID without persisting request bodies, query values or raw error messages. The authorization guard continues to record denied permission, MFA and cross-tenant attempts.
- Organisation Owner has `audit.export` behind the existing recent-MFA requirement. Read-only Auditor retains `audit.read` without export authority.
- JSON export manifests pin immutable filters and an `asOf` cutoff, reject results over the chosen limit or 5,000 rows, expire after 24 hours and render on authorised access with a SHA-256 digest. Access is itself audited.
- No approved retention duration or legal-hold policy exists. The UI/API reports policy unavailable and keeps automatic deletion disabled rather than inventing a schedule.

## Database and Neon verification

- Migration `022_audit_explorer_and_exports.sql` was applied to the configured Neon database.
- `admin_audit_events` and `admin_audit_export_jobs` have RLS enabled and forced.
- The Runtime role can select/insert audit events but cannot update/delete them. Export identities and filters are immutable and export jobs cannot be deleted.
- A rollback-only Runtime-role probe rejected cross-tenant insertion. A rollback-only owner probe confirmed the append-only event trigger also rejects mutation by the table owner.

## Verification

- Sophia Runtime: 71 suites, 271 tests passed; TypeScript build passed on Node 22.23.2.
- Angular: 73 Sophia Runtime/Admin tests passed in Chrome Headless 154; production build passed with the existing bundle/font/CommonJS/PrimeIcons warnings.
- Boundary scan: 174 new-product files passed.
- Protected real-estate characterization: 8 suites, 38 tests passed.
- No live provider, external connector, business effect, retained export object or commercial operation was invoked.

## Plan refinement

Plan 2.1.28 replaces unsupported retention and asynchronous-export assumptions with append-only tenant evidence, an honest unavailable retention state and bounded expiring export manifests rendered from a pinned immutable cutoff.

Next ready task: P6-03 — implement privacy operations and the production legal checklist.
