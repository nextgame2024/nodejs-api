# Sophia realtime P3-02 checkpoint

Checkpoint date: 2026-09-24 (Australia/Brisbane)

## Delivered locally

- Replaced the split tool path with one dispatcher used by v1 aliases and v2 canonical tool IDs. The dispatcher revalidates the session access credential and loads tenant, session state, release revocation and immutable capability bindings server-side before execution.
- Added policy metadata to every active real-estate/research tool: canonical ID/version, required capability, risk and side-effect classes, confirmation policy, timeout, retry class and idempotency class.
- V2 provider provisioning now receives only canonical tools allowed by the session plan's capability bindings. Manually forged known tool names are independently rejected by the dispatcher.
- Added canonical alias resolution. `bookInspection` and `booking.commit`, for example, resolve to one policy; their durable review command ID is recorded before execution and a database uniqueness constraint prevents double commit.
- Explicit-review mutations are consumed in the dispatcher before execution. Existing tool-level review consumption remains as bounded direct-unit compatibility and reuses the same committed command ID rather than creating authority.
- Added per-tool deadlines and abort signals. Safe reads receive at most two attempts for transient failures. Writes receive one attempt; a timeout becomes `outcome_unknown` and must be reconciled under the same command rather than retried.
- Added JSON-safe output validation, response minimisation and canonical v2 `ToolResult` success/error shapes. V1 retains its existing response envelope while using the same enforcement and audit pipeline.
- Added audit coverage for denied, failed, timed-out, cancelled and unknown-outcome calls, including attempt count, canonical tool/version, binding, command, deadline and derived provenance.
- Added RLS/FORCE RLS to `tool_calls` and `action_reviews`; all runtime reads/writes now use tenant-local transactions.

## Evidence-driven plan amendment

The reference plan was updated from `2.1.0` to `2.1.1` because repository evidence invalidated three assumptions:

- `eventSource` arrives through the public session route and cannot establish verified provider provenance. The dispatcher records `untrusted-client-bridge` regardless of that hint. Stronger provenance requires a separately authenticated transport.
- The session contract has immutable capability bindings but no server-issued per-turn task grant. P3-02 therefore publishes the minimum session catalog; task-level narrowing is allowed later only from server-owned state, never model intent.
- Legacy and canonical names must be resolved before audit insertion so both share one durable command identity.

The amendment is recorded under `validatedAmendments` in the plan and in the revised P3-02 steps/acceptance criteria.

## Database

Migration `014_safe_tool_execution_pipeline.sql` was applied transactionally to the configured Neon PostgreSQL 17 database with explicit authorization.

A rollback-only verification confirmed:

- the migration record is installed;
- `tool_calls` and `action_reviews` both have RLS and FORCE RLS;
- `current_user = sophia_runtime_app` and `BYPASSRLS=false`;
- canonical `(session, tool, command)` uniqueness blocks legacy/canonical duplicate execution; and
- all synthetic rows were rolled back.

## Verification

- Full runtime suite under Node 22.23.2 — pass, 39 suites and 156 tests.
- Runtime typecheck, generated-contract drift check and build — pass.
- Nest application context — initialized successfully with the new dispatcher dependencies.
- Boundary scan — pass, 60 new-product source files.
- Protected real-estate characterization — pass, 7 suites and 30 tests.
- Provider-neutral contract suite — pass, 15 tests.
- Business Manager release suite — pass, 16 suites and 66 tests; 4 suites/12 SQL-gated tests skipped.

No live provider, email, payment or subscription operation was invoked.

## Remaining limits and next task

- A verified provider-sideband/webhook entry point does not yet exist. Public calls remain deliberately untrusted even when they include provider event IDs.
- Server-issued per-task grants do not yet exist; session capability bindings are the strict current upper bound.
- The shared P3-01 ports are enforced at the catalog/binding layer, but the current Business Manager real-estate implementation remains a legacy adapter until P3-03 maps it to those ports.
- Provider cancellation depends on individual adapters/HTTP clients honoring the supplied abort signal. Ignored aborts remain safely recorded as timeout or unknown outcome according to side-effect class.

P3-A01 is next in roadmap order: implement approved knowledge-source revision, publication, ingestion-status and retrieval-preview controls without importing the quarantined student implementation.
