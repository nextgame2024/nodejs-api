# Sophia realtime P2-06 checkpoint

Checkpoint date: 2026-09-24 (Australia/Brisbane)

## Delivered locally

- Added `/api/runtime/v2/bootstrap` behind both the fixed runtime tenant allowlist and a 32+ character installation credential. It validates the active tenant device and published experience before issuing a short-lived opaque grant. Grants are hashed at rest, request-bound and redeemable once.
- Added profile-driven v2 session creation. Before provider allocation, the resolver verifies the published profile digest and scope, exact published provider configurations, persisted provider bindings, runtime capability manifests, locale policy, tool catalog, active non-revoked agent release and referenced capability bindings.
- Lifecycle adapter selection now follows the published plan's native-realtime owner. A compatible profile can select the existing native or composite path without a Core experience/vendor switch.
- V2 sessions pin the bootstrap, experience-profile version, agent release, session plan and plan digest. Database constraints require those pins and triggers make the orchestration snapshot immutable.
- V2 responses expose normalized session and transport descriptors. Provider-native AI/avatar credentials occur only in the one-time connection-bootstrap envelope and are not persisted in the retrievable descriptor.
- Added v2 get, tool, action-review confirmation, heartbeat, disconnect and close routes. Tool execution continues through the P1 lifecycle, deduplication and explicit-review controls; tool/review use fails closed after release revocation.
- Added safe readiness output with disabled/not-ready/ready states and non-secret reason codes. No provider is contacted by readiness.
- Explicitly marked v1 inserts as `v1` and restricted v1 lookup to v1 rows, preventing cross-path session access during canary deployment.

## Database and canary state

Migration `013_v2_canary_orchestration.sql` was applied transactionally to the configured Neon PostgreSQL 17 database with explicit user authorization.

A rollback-only verification confirmed:

- the migration record is installed;
- `runtime_bootstrap_grants` has RLS and FORCE RLS;
- `current_user = sophia_runtime_app` and `BYPASSRLS=false`; and
- tenant-scoped bootstrap insert/read succeeds under that runtime role, with the synthetic row rolled back.

The v2 path is disabled by default. Activation requires `SOPHIA_V2_CANARY_TENANT_IDS`, a 32+ character `SOPHIA_V2_INSTALLATION_KEY`, and compatible published profile plus active agent-release records. No tenant was enabled and no live provider allocation was made during this task.

## Verification

- Runtime suite — pass, 36 suites and 139 tests.
- Runtime typecheck, generated-contract drift check and build — pass.
- Nest application context with the v2 module graph — initialized successfully against a deliberately unreachable database URL without opening a provider session.
- Backend boundary scan under Node 22.23.2 — pass, 49 new-product files.
- Protected real-estate characterization — pass, 7 suites and 30 tests.
- Provider-neutral contract suite — pass, 15 tests.
- Business Manager release suite — pass, 16 suites and 66 tests; 4 suites/12 SQL-gated tests skipped.
- Frontend application typecheck — pass under Node 20.19.1.
- Sophia ChromeHeadless suite — pass, 10 tests.

No live provider, email, payment or subscription operation was invoked.

## Remaining operational limits and next task

- Canary enablement still needs an explicit tenant-specific configuration and published data rollout; readiness reports the missing gates without exposing tenant IDs or credentials.
- A redeemed bootstrap grant is intentionally not reusable if subsequent composition validation fails; the installation must request a new grant after configuration is corrected.
- The deployment scheduler still needs to invoke provider cleanup reconciliation for each enabled tenant.
- A separately authenticated non-owner database login remains optional stronger hardening; runtime sessions already assume the non-`BYPASSRLS` role.

P3-01 is next in roadmap order: implement reusable provider-independent business capability ports and strict pack extension schemas.
