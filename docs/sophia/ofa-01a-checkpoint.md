# OFA-01A checkpoint — Students read slice

Date: 5 October 2026
Decision: complete in source; stop before OFA-01B student writes

## Demonstrable outcome

Business Manager now has a read-only route at:

`/manager/open-for-australia/students`

`Students` is also a configurable Business Manager menu label. It remains
company-scoped like the existing Business Manager modules and only appears when
the label is active for that company; the runtime entitlement remains the
independent server-side authorization boundary.

The screen discovers the runtime tenant from the authenticated Business Manager
identity, then loads the tenant-scoped student register. It provides bounded
search, status, college and advisor-assignment filters, loading,
empty and access-denied states. It deliberately has no create, edit, import or
upload action.

The identity-derived API routes are:

- `GET /api/business-packs/open-for-australia/v1/workspace`
- `GET /api/business-packs/open-for-australia/v1/workspace/students`

The earlier tenant-addressed workspace endpoint remains available for explicit
cross-tenant denial tests. The browser does not select or guess an internal
runtime tenant UUID.

## Authorization and privacy behavior

- Every request still requires an active Business Manager identity and active
  Open For Australia entitlement.
- CEO and Operations roles may list all tenant students.
- Advisor results are unconditionally restricted to rows assigned to that
  identity; a caller-supplied advisor filter cannot override the restriction.
- The API returns only registered list fields. Passport, date of birth,
  health/character, visa, payment amount and bank-reference fields are absent.
- The advisor identity itself is not returned to the browser; the list exposes
  only an assigned/unassigned boolean.
- Unknown output fields are excluded by the policy projection.

## Schema and migration

Migration `062_open_for_australia_students.sql` defines the first tenant-scoped
student read model with forced RLS, bounded stages/statuses, tenant-reference
uniqueness and list indexes. The runtime role receives `SELECT` only.

The migration contains no fixture or customer data. Migration 062 has not been
applied to production at this review gate. Migrations 060 and 061 were applied
and verified before this checkpoint; no Open For Australia entitlement exists
in production yet.

## Verification

Backend, Node `v22.23.2`:

- Full Sophia Runtime suite: 147 suites, 532 tests passed.
- Runtime build: passed.
- Source-boundary gate: passed, 256 source files scanned.
- Real-estate regression: 8 suites, 38 tests passed.

Frontend:

- TypeScript application typecheck: passed.
- Focused Angular service/component/navigation tests: 6 passed in
  ChromeHeadless.
- Angular production build: passed using the repository's established Node 20
  frontend toolchain.

The build retains existing non-blocking warnings for the initial bundle budget,
Manrope CSS budget, the HeyGen `events` CommonJS dependency and the missing
PrimeIcons stylesheet reference.

## Exercise after deployment

Until migration 062 is applied and a reviewed entitlement is assigned, the
production page must remain inaccessible. After those operations, an entitled
account can open the route and should see the empty synthetic register state.
Test fixtures should be introduced only in a non-production tenant.

## Next proposed checkpoint

OFA-01B adds the workspace profile and student-operations dashboard shell before
student writes. Student create/edit operations move to OFA-01E and remain blocked
until the privacy notice and real-data onboarding gate are approved.
