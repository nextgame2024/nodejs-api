# P4-A01 checkpoint — protected Sophia Admin shell

Date: 2026-09-25 (Australia/Brisbane)

Status: complete with identity-bound context limit

## Outcome

`/sophia-admin` is now a protected, lazy-loaded Angular area with its own shell,
overview and child routes. The shell exposes all sixteen declared Admin modules
through one business- and provider-neutral registry. Only a workspace that is
both delivered and included in the current principal's permissions becomes a
link; undelivered or ungranted modules remain explicit disabled states. The
existing ADM-06 Knowledge workspace remains the first real module rather than a
mock placeholder.

The overview provides a permission/delivery table and reusable pagination. The
shell and shared primitives provide accessible loading, empty, error and
forbidden states, responsive navigation, a skip link and a suspended-
organisation notice. Module routes use declared permission data and a generic
guard, while direct backend endpoints retain the authoritative Admin guard.

Admin context caching is scoped to the current login credential. A credential
change creates a new context request, and sign-out explicitly clears the cached
principal and organisation before dispatching logout. No tenant selection,
provider credential or transcript is persisted by the shell.

## Plan correction

Repository inspection proved that the Business Manager identity bridge resolves
one company and `AdminAuthorizationService` requires one unambiguous active
membership in the Sophia organisation mapped to that company. The Admin context
API does not return an authorised organisation list or a tenant-context exchange
credential.

Plan version 2.1.12 therefore replaces the assumed browser tenant switcher with
a read-only, server-resolved organisation context control. Angular cannot choose
an arbitrary tenant ID. A future multi-organisation switch requires a backend-
authorised membership-list and scoped context-selection contract, cross-tenant
negative tests and request/state cancellation before the UI changes context.

## Verification

- `npx tsc -p tsconfig.app.json --noEmit` — passed under Node 20.19.1.
- `npm run test:sophia` — 34 tests passed in Chrome Headless 154, including
  route permissions, credential-aware cache invalidation, all-sixteen module
  coverage, neutrality and logout cleanup.
- Backend targeted authorization/organisation tests — 3 suites and 16 tests
  passed under Node 20.19.1.
- `npm run test:p0:boundaries` — passed with 119 new-product source files
  scanned; no student-agency import crossed into the Admin/core roots.
- `GOOGLE_MAPS_API_KEY=dummy npm run build` — passed. Admin shell/overview/
  Knowledge markers occur only in lazy chunks and are absent from the initial
  main chunk. Existing bundle/font/CommonJS/missing PrimeIcons warnings remain.

No live provider, email, booking, billing or deployment operation was invoked.
No multi-organisation switching is claimed or enabled.

## Next ready task

P4-03 — introduce shared presentation blocks and pack renderers.
