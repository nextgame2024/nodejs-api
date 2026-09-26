# Sophia realtime P2-02 checkpoint

Checkpoint date: 2026-09-23 (Australia/Brisbane)

## Delivered locally

- Added additive migration `006_versioned_configuration_profiles.sql` for business profiles/versions, provider configurations, capability bindings, experience profiles/versions and experience-to-provider bindings.
- Preserved `ai_configs`, legacy identifiers and the current v1 session path. No legacy table was renamed, rewritten or dropped.
- Published provider, business and experience versions are database-protected from mutation. Child capability/provider bindings also reject insert, update and delete after their parent version is published.
- Added a tenant-scoped publication service with row locking, optimistic revision checks, configuration digesting, published dependency checks and atomic active-version advancement.
- Added strict composition validation before publication: declared capability ownership, adapter/manifest matching, supported pipeline modes, composite reasoning restrictions, audio-owner binding and embedded-secret rejection.
- Long-lived credentials are represented only by `credentialRef`; settings containing API keys, access tokens, client secrets, passwords or authorisation values are rejected.
- Added provider-neutral fixtures representing the verified current Essential, Professional and Premium compositions. These are test/configuration data, not branches in Core.

## Repository discrepancy and migration decision

The preserved `ai_configs` demo row describes an older OpenAI + Simli configuration and is not read by the current session service. The actual code paths are Essential with native realtime, Professional with native realtime plus LiveAvatar, and Premium with Tavus composite realtime.

Because the legacy row is stale, P2-02 does not automatically publish it as current truth. The three observed compositions are validated fixtures, while database profile rows remain disabled/unpublished until the P2-04 adapter registry can supply tested manifests. This avoids activating an unsupported or misleading composition and preserves all legacy data.

## Verification

- Focused configuration/migration tests — pass, 3 suites and 9 tests.
- Full `backend/sophia-runtime: npm test` under Node 22.23.2 — pass, 17 suites and 77 tests.
- `backend/sophia-runtime: npm run typecheck` — pass.
- `backend/sophia-runtime: npm run build` — pass.
- `backend: npm run test:p0:boundaries` — pass, 13 files scanned.
- `backend: npm run test:p0:real-estate` — pass, 7 suites and 30 tests.
- `backend: npm run test:p2:contracts` — pass, contract drift check and 15 tests.

No live provider, email, billing or subscription operation was invoked. At the original checkpoint migration 006 was not applied. With explicit user authorization on 2026-09-23, migrations 006–009 were subsequently applied transactionally to the configured Neon database.

## Next task

P2-A01 is next in roadmap order: define the Sophia Admin control plane, identity bridge and permission contracts. P2-03 remains blocked on P2-02 only and can follow the Admin foundation in the declared sequence.
