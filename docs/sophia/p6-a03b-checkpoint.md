# P6-A03B checkpoint — Analytics workspace and expiring snapshots

Completed 26 September 2026.

## Delivered

- The protected lazy `/sophia-admin/analytics` workspace is available to principals with `analytics.read`.
- Date, agent, immutable release and channel filters use the tenant-scoped backend. The page displays local timezone, aggregation time, latest source evidence, warnings and honest empty states.
- Metric cards show version, evidence class, definition and denominator. Session closure remains visibly a lifecycle observation; pack-specific outcomes remain source-confirmed extensions rather than Core assumptions.
- Local-date and attribution tables expose the evidence without adding a charting dependency. The browser limits the detailed rendered table to 250 rows while totals and daily groups use the complete bounded response; it states when detail is truncated.
- Usage coverage distinguishes measurement status and unattributed events. Provider estimates remain separated by currency, cost-table version and measurement status and are labelled neither customer charges nor revenue/savings/causal impact.
- `analytics.export` is now reachable only by Organisation Owner among fixed roles. Operations Member and Read-only Auditor keep `analytics.read` without export authority.
- Dashboard aggregation runs in a tenant-scoped repeatable-read, read-only transaction so its source queries share one database snapshot.
- Aggregate JSON snapshots are capped at 5,000 points and 5 MiB, SHA-256 digested, audited and available for 24 hours. They contain the registry, aggregate points, coverage and separated estimates, never raw conversation content, tool inputs/outputs, transcript or audio.
- Expiry is irreversible. When expiry is observed, the stored aggregate document is set to null while immutable filter, point-count, registry digest, document digest and access evidence remain.

## Plan correction

Plan 2.1.34 records why analytics exports cannot use the conversation/audit render-on-access pattern: session, workflow and escalation lifecycle states can change, so a later render could differ from the snapshot approved at creation. Persisting the bounded aggregate document temporarily preserves exact export evidence without creating a copy of raw conversation content.

The same amendment corrects the unreachable permission: `analytics.export` existed but no fixed role held it. Organisation Owner now receives `analytics.read` and `analytics.export`; the export remains separate from ordinary analytics readers. Recent MFA is not added because this document contains aggregate operational evidence only, unlike content and audit exports.

## Database and Neon verification

- Migration `027_analytics_exports.sql` was applied to the configured Neon database.
- The table uses forced RLS, immutable identity/digest fields, bounded document size, monotonic access counts, irreversible expiry and Runtime delete revocation.
- A rollback-only `sophia_runtime_app` probe created and downloaded a one-point snapshot, verified its SHA-256 digest, confirmed raw synthetic tool input was absent, scrubbed an expired aggregate document and confirmed forced RLS. All synthetic tenant/session/tool/usage/export rows were rolled back.

## Verification

- Runtime portability-Core and production typechecks, build, contract drift check and all 82 suites/299 tests passed.
- Frontend TypeScript compilation, all 78 Sophia Runtime/Admin browser tests and the production build passed. Existing bundle/font/CommonJS/PrimeIcons warnings remain unchanged.
- The architecture boundary scan passed across 194 new-product files.
- The protected real-estate characterization passed 8 suites/38 tests.

## Remaining limits

- Aggregation remains on demand. No observed scale or latency evidence currently justifies materialized views and their reconciliation/privacy lifecycle.
- Expired document scrubbing occurs when an export is listed or accessed; no background expiry scheduler is deployed.
- The workspace is browser-unit/build verified but not authenticated browser E2E tested against a populated production tenant.

P6-A03 is complete with limits. Next ready task: P6-A05 — Usage/Billing views, commercial model and quota controls.
