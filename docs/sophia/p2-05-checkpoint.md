# Sophia realtime P2-05 checkpoint

Checkpoint date: 2026-09-23 (Australia/Brisbane)

## Delivered locally

- Removed Tavus internet-search and tool create/update/attach operations from customer session creation. Premium admission now checks for an active tenant/environment catalog deployment before allocating a conversation.
- Added an explicit, confirmation-gated `providers:provision` operation. Catalogs have immutable version/digest identity, resumable operation leases, tenant/environment resource ownership and non-secret remote resource IDs. A provider persona cannot be claimed by two tenants in one environment.
- New catalog versions create their own tools instead of updating another active version's tool IDs. Partial provisioning records each allocated tool immediately; failed or abandoned versions can resume without touching another tenant's resources.
- Added durable provider session allocations with allocating/allocated/attached/cleanup/failed stages, non-secret provider snapshots, hard cleanup deadlines, attempt counters and worker leases.
- Added bounded open/close timeouts, late-open compensation, recoverable partial-start errors, all-resource native cleanup and idempotent provider close handling. Incomplete Tavus and avatar allocations retain enough information for reconciliation.
- Added claim-based idempotent session close. A close failure moves the session/allocation to `cleanup_pending`; the explicit `providers:reconcile` operation leases and retries orphan cleanup. Legacy active sessions are backfilled into allocation records when reconciliation runs.
- Added hard session expiry, heartbeat and disconnect-grace fields and APIs. The kiosk sends heartbeats while active and marks abrupt navigation disconnects for bounded cleanup.
- Added canonical tool-event provenance for browser/provider-sideband delivery. A stable provider event ID maps both observations to one deduplication key, with `sophia-runtime` as the single execution owner. Provider-sideband events without a stable ID fail validation.

## Database and operations

Migration `012_provider_operations.sql` was applied transactionally to the configured Neon PostgreSQL 17 database with explicit user authorization. It adds provider catalog ownership/deployments, session allocation leases, bounded session lifecycle fields and tool-event provenance/deduplication.

A rollback-only Neon verification through `DatabaseService` confirmed:

- `session_user = neondb_owner`, `current_user = sophia_runtime_app`, and `BYPASSRLS=false`;
- RLS and FORCE RLS on catalog deployments, provider resource ownership and session allocations;
- tenant-scoped catalog/allocation/session writes under the runtime role;
- a browser and provider-sideband event with the same canonical ID cannot both be inserted; and
- zero synthetic rows were retained.

The operational commands require the tenant UUID twice as an explicit confirmation. They were not invoked against Tavus during this task.

## Verification

- Focused provider operations, adapters, catalog, Tavus, conversation, tool ownership and migration tests — pass, 7 suites and 29 tests.
- Full runtime suite under Node 22.23.2 — pass, 33 suites and 133 tests.
- Runtime typecheck and build — pass.
- Nest dependency graph and heartbeat/disconnect routes initialized successfully; sandbox socket binding was denied only after initialization.
- Frontend application typecheck — pass under Node 20.19.1.
- Sophia ChromeHeadless suite — pass, 10 tests.
- Boundary scan — pass, 41 new-product source files.
- Protected real-estate suite — pass, 7 suites and 30 tests.
- Provider-neutral contract suite — pass, 15 tests.
- Business Manager release suite — pass, 16 suites and 66 tests; 4 suites/12 SQL-gated tests skipped.

No live provider, email, payment or subscription operation was invoked.

## Remaining operational limits and next task

- No Tavus catalog was provisioned live. Premium sessions now correctly fail closed until an operator runs the versioned provisioning command with approved provider credentials.
- The cleanup reconciler is implemented as a tenant-confirmed idempotent command but is not yet wired to a deployment scheduler. Production activation must schedule it for each enabled tenant.
- Tool deduplication depends on providers preserving a stable call/event ID. Provider-sideband delivery without one is rejected rather than risking duplicate business execution.
- The configured database session credential remains the owner while runtime queries assume `sophia_runtime_app`; a direct least-privilege login remains optional stronger production hardening.

P2-06 is next in roadmap order: expose release/profile-resolved v2 session orchestration behind a controlled canary boundary while preserving the v1 real-estate path.
