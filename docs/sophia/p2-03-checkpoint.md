# Sophia realtime P2-03 checkpoint

Checkpoint date: 2026-09-23 (Australia/Brisbane)

## Delivered locally

- Added additive `connector_bindings` storage linking one runtime tenant to an approved external account, credential reference and explicit scope grants. No long-lived credential value is stored in the row.
- Added tenant-scoped connector authority resolution. Tenant and company authority come from the active server-side binding; no browser/model `companyId` input is accepted.
- Added short-lived HS256 connector credentials containing issuer, audience, expiry, tenant, external company, connector binding, request identity and bounded scopes.
- Business Manager validates signature, algorithm/key identifier, issuer, audience, timing, UUID claims, configured binding identity and scope grants before assigning `req.user.companyId`.
- Real-estate Business Manager routes now distinguish read, booking-write and delivery-write scopes. The legacy fixed token retains its original broad `bm:real-estate` scope for the explicitly bound demo company.
- Ordinary Business Manager user JWTs are identified separately and continue through the existing authentication path.
- Added transaction-local PostgreSQL tenant context using `set_config(..., true)` on the same pooled connection, plus RLS and `WITH CHECK` for connector bindings.
- Updated P2-02 profile publication to use tenant-local transactions.

## Activation boundary

The current v1 real-estate client still uses the legacy fixed service token, preserving the demo. Scoped credentials are available through the new connector authority service for v2 connector activation. No v2 session or customer was switched to the new credential path in P2-03.

Business Manager validates active bindings from server-owned `SOPHIA_CONNECTOR_BINDINGS_JSON`; this is an initial deployment allowlist, not browser configuration. A future operational binding-distribution mechanism must update it atomically with the runtime binding before multi-tenant production activation.

## Verification

- Scoped credential/connector authority/database tenant tests — pass, 3 suites and 5 tests.
- Full runtime suite under Node 22.23.2 — pass, 24 suites and 93 tests.
- Runtime typecheck and build — pass.
- Business Manager scoped-authority tests — pass, 4 tests.
- Full Business Manager release suite — pass, 16 suites and 66 tests; 4 suites/12 SQL-gated tests skipped.
- Protected real-estate suite — pass, 7 suites and 30 tests.
- P2 contract suite — pass, 15 tests.
- Boundary scan — pass, 31 new-product files.

No provider, email, billing, subscription or deployment operation was invoked. At the original checkpoint no production migration was run; migrations 006–009 were subsequently applied to the configured Neon database with explicit user authorization on 2026-09-23.

## Remaining limitations and next task

- Migration 008 was subsequently applied to the configured Neon database with explicit user authorization on 2026-09-23. Its RLS and FORCE RLS catalog flags are present.
- Migration 010 subsequently provisioned `sophia_runtime_app`, and `DatabaseService` now assumes that non-`BYPASSRLS` effective role before pooled connections are used. Cross-tenant visibility and write denial were verified in a rollback-only Neon transaction. See `database-role-hardening.md`.
- The binding allowlist distribution/rotation process is not yet operationalised.
- P2-A03 is next in roadmap order: agent authoring, instruction versions and immutable release manifests.
