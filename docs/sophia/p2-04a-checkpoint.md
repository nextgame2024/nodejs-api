# Sophia realtime P2-04a checkpoint

Checkpoint date: 2026-09-23 (Australia/Brisbane)

## Delivered locally

- Added an explicit dependency-injected provider capability registry with immutable registrations for the existing native realtime, composite realtime, avatar, speech and research adapters.
- Added provider-neutral manifests covering capabilities, pipeline modes, modalities, transport, interruption, audio formats, credential references, data-handling references and health policy.
- Added generic capability resolution so a registered mock adapter can be added without editing domain tools or shared orchestration.
- Added deterministic composition validation for unknown capabilities, adapter/mode incompatibility, duplicate bindings, missing capability owners, overlapping speech outputs and composite providers whose reasoning layer is not replaceable.
- Isolated `BusinessResearchService` as a registered research capability while preserving the existing `researchBusiness` tool behavior.

## Database-role hardening completed before this subphase

- Added and applied migration `010_least_privilege_runtime_role.sql`.
- Added a pool verification hook that assumes `sophia_runtime_app` before a connection reaches runtime code; migrations retain the owner connection.
- Verified on Neon that the runtime effective role has `BYPASSRLS=false`, cross-tenant reads return no rows and cross-tenant inserts fail. The verification transaction was rolled back.
- Operational details are recorded in `database-role-hardening.md` and the repository `AGENTS.md`.

## Verification

- Provider capability and database role focused tests — pass, 2 suites and 8 tests.
- Full runtime suite under Node 22.23.2 — pass, 27 suites and 108 tests.
- Runtime typecheck and build — pass.
- Protected real-estate suite — pass, 7 suites and 30 tests.
- P2 contract suite — pass, 15 tests.
- Boundary scan — pass, 37 new-product files.

No live provider, email, billing or subscription operation was invoked.

## Remaining P2-04 work

P2-04b must route session open/close through common lifecycle adapters and remove OpenAI/Tavus/concrete-provider branching from `ConversationService`. It must then rerun the Essential, Professional and Premium characterization tests against the shared lifecycle contract.
