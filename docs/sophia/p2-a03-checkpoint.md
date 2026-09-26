# Sophia realtime P2-A03 checkpoint

Checkpoint date: 2026-09-23 (Australia/Brisbane)

## Delivered locally

- Added tenant-owned agent identities and optimistic-concurrency drafts with strict, provider-neutral configuration references.
- Added tenant-owned instruction sets and immutable approved revisions. Tenant templates accept only declared scalar variables; arbitrary fields, capability grants and recording/privacy controls are rejected by the strict schema.
- Kept the platform safety policy fixed outside tenant-authored instructions and recorded its version in every release.
- Added deterministic publication checks for approved instructions, published business/experience profiles and enabled capability bindings. Unknown or cross-tenant references fail; future knowledge/workflow/escalation references remain explicitly blocked until their registries exist.
- Added draft validation, draft-versus-active-release diff, release history, publish, rollback and emergency-revocation APIs behind the Admin guard and named permissions.
- Added immutable aggregate release manifests with stable SHA-256 digests, release notes and author/timestamp metadata. Rollback repoints only the active release and never rewrites history.
- Added database-enforced tenant matching for agents, releases and session release references, row-level security for all authoring tables, and an immutable session release pin. Emergency revocation is stored separately and checked independently.
- Added read/create APIs needed by the later Admin workspace for agent drafts, release history and instruction revisions.

## Activation boundary

The existing v1 real-estate demo does not yet select an authored agent and was not switched to the v2 release path. Agent-backed session activation remains P2-06 work. Migration 009 supplies the tenant-matched immutable session pin and the runtime service supplies the independent revocation check that the activated path must call.

Knowledge, workflow and escalation registries are deliberately not fabricated in this task. A draft may carry their version references for forward compatibility, but publication blocks until the owning P3 modules can verify them.

## Verification

- Focused agent authoring/migration tests — pass, 2 suites and 8 tests.
- Full runtime suite under Node 22.23.2 — pass, 26 suites and 101 tests.
- Runtime typecheck and build — pass.
- Full Business Manager release suite — pass, 16 suites and 66 tests; 4 suites/12 SQL-gated tests skipped.
- Protected real-estate suite — pass, 7 suites and 30 tests.
- P2 contract suite — pass, 15 tests.
- Boundary scan — pass, 37 new-product files.

No live provider, email, billing, subscription or deployment operation was invoked. Migration 009 was subsequently applied to the configured Neon database with explicit user authorization.

## Remaining limitations and next task

- Migration 009 was applied transactionally to the configured Neon PostgreSQL 17 database with explicit user authorization. Foreign keys, RLS/FORCE RLS flags and immutable release/session/instruction triggers were verified; the trigger checks used a rollback-only transaction and retained no synthetic rows.
- Migration 010 provisioned the least-privilege `sophia_runtime_app` role. `DatabaseService` assumes it before a pooled connection is used, and rollback-only Neon verification proved cross-tenant reads are hidden and writes are rejected. Direct login credentials for that role remain an optional stronger production isolation step.
- Existing v1 sessions remain intentionally unpinned because they do not yet resolve an authored agent. P2-06 must resolve the active release, insert its ID with the session, and invoke the emergency-revocation check during execution.
- Evaluation/approval evidence can be added to the publication-check interface when P6-A02 supplies its registry.
- P2-04 is next in roadmap order: provider and experience adapter registry foundations.
