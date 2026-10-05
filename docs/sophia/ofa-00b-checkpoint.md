# OFA-00B checkpoint — workspace authorization

Date: 5 October 2026
Decision: complete in source; stop before OFA-00C roles/privacy work

## Demonstrable outcome

The NestJS Runtime now exposes one read-only Open For Australia workspace
metadata endpoint:

`GET /business-packs/open-for-australia/v1/tenants/:tenantId/workspace`

Access requires all of the following:

- an active Business Manager bearer identity;
- an unambiguous active runtime customer mapped to that identity's company;
- an active, user-specific `open-for-australia` pack entitlement; and
- a route tenant matching the entitled runtime customer.

Missing authentication returns 401 semantics. Missing entitlement, ambiguous
company mapping and cross-tenant requests return 403 semantics. Successful,
denied-entitlement and cross-tenant access attempts create tenant-scoped audit
evidence. The endpoint only returns the versioned pack metadata and explicit
fail-closed readiness states; it does not expose student, payment or document
data.

## Schema and migration

Migration `060_business_pack_workspace_entitlements.sql` adds:

- `business_pack_entitlements`, with one revisioned pack entitlement per
  tenant/user/pack; and
- append-only `business_pack_access_audit_events`.

Both tables force tenant RLS. The runtime role can read entitlements but cannot
create or change them. Audit rows may be inserted and read but an immutable
trigger rejects updates and deletes.

The migration has not been applied to production and no user entitlement has
been granted. Deployment and production entitlement assignment are separate,
reviewed operations.

## Verification

Executed with Node `v22.23.2`:

- OFA pack, service, guard, controller and migration specs: 5 suites, 11 tests
  passed.
- Full Sophia Runtime suite: 142 suites, 516 tests passed.
- `npm run build` in `sophia-runtime`: passed.
- `npm run test:p0:boundaries`: passed, 250 source files scanned.
- `npm run test:p0:real-estate`: 8 suites, 38 tests passed.

The expected simulated provider errors in the full suite are asserted test
fixtures; they did not fail validation.

## Security and remaining risk

- Authorization fails closed and is tenant- and identity-bound.
- Entitlements cannot be self-issued by the runtime application role.
- Access audit evidence is append-only and subject to tenant RLS.
- The production migration and first entitlement must be applied through a
  privileged, audited operator path; no such mutation is included here.
- OFA-00C must define the Open For Australia CEO, Operations and Advisor
  permission/privacy contract before any personal-information schema is added.

## Next proposed checkpoint

OFA-00C defines the roles, field classifications, masking behavior, data-flow
inventory and retention/legal-hold targets. No student records or documents are
accepted until that contract passes its review gate.
