# P3-A02 checkpoint — approved tools and connectors APIs

P3-A02 is complete with deployment and UI limits. It adds the bounded Admin APIs for ADM-07 and ADM-08; the protected Angular screens remain assigned to P4-A04.

## Delivered

- Read-only compiled tool and connector catalogs. Catalogs expose capability policy, versions, scopes and health semantics without credential values.
- Synthetic-only tool sandbox policy checks. These never call a connector, provider, email service or business mutation.
- Tenant-scoped connector onboarding using compiled registrations, allowlisted scopes, a server-owned credential reference and a read-only external-account identity probe.
- Tenant-scoped list, health test, reconnect and disconnect operations with optimistic revisions and audit events.
- Capability binding administration for draft business-profile versions only. Arbitrary connector types, capabilities, policy versions, configuration JSON and code are rejected.
- Explicit `capability_bindings.connector_binding_id`. Agent readiness and v2 admission now require that an explicitly linked connector remains active.
- Reconciliation-preserving disconnect. A connector with accepted, executing or unknown command outcomes enters `disconnecting`; it cannot admit new sessions, and the dispatcher denies new mutations immediately while retaining safe reads for reconciliation. A later disconnect finalizes `revoked` after unresolved work reaches zero.
- Business Manager exposes an authenticated, read-scoped connector identity probe. The Runtime compares its company UUID with the requested external account before binding or reconnecting.

## Database

Migration `017_admin_tool_connector_lifecycle.sql` adds connector health/disconnect state, the capability-to-connector reference, optimistic capability revisions and tenant-RLS connector lifecycle events.

It was applied to the configured Neon database with the owner migration connection. Read-only verification confirmed:

- migration 017 is recorded;
- the expected columns exist;
- `connector_binding_events` has enabled and forced RLS;
- `sophia_runtime_app` has table privileges while remaining `NOLOGIN`, non-superuser and non-`BYPASSRLS`.

## Verification

- Sophia Runtime typecheck and build passed.
- Sophia Runtime: 48 suites, 192 tests passed.
- Protected real-estate suite: 7 suites, 32 tests passed.
- V2 contracts: 15 tests passed.
- Backend release suite: 16 suites, 66 tests passed; 12 SQL-gated tests skipped.
- Boundary scan: 102 source files passed.

## Limits and next boundary

- The current real-estate connector uses runtime-scoped tokens, so tenant credential rotation is intentionally reported unsupported. Rotation of the server signing secret is a deployment operation, not a tenant API that accepts secret material.
- No live Business Manager connector test was invoked by Codex. The API is implemented and unit-tested with synthetic accounts; an authorised administrator triggers the read-only probe during actual onboarding/test/reconnect.
- Operation-specific generated JSON Schemas do not yet exist. The API exposes the real compiled capability contract and extension manifest instead of inventing schema URLs. P4-A04 must add the Angular tools/connectors screens and may add generated schema artifacts if the UI needs field-level rendering.
