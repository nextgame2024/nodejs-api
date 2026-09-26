# Sophia realtime P2-A01 checkpoint

Checkpoint date: 2026-09-23 (Australia/Brisbane)

## Delivered locally

- Confirmed Business Manager remains the identity authority. Sophia Admin stores only an external identity reference and tenant membership; it does not duplicate users, passwords, reset tokens or MFA secrets.
- Added a Business Manager identity bridge that revalidates the existing bearer/Token credential through the authenticated `/api/user` endpoint and requires an active company-bound identity.
- Added the complete named Admin permission registry and six fixed MVP role templates. Domain authorization checks permissions, not Business Manager user `type`, navigation visibility or the existing hardcoded super-admin identifier.
- Added tenant-bound principal resolution through `customers.external_company_id` plus an active Admin membership. Ambiguous/missing membership and tenant mismatch fail closed.
- Added a reusable Admin guard/decorator foundation, direct cross-tenant denial, denial auditing and redacted audit metadata.
- Added recent-MFA gates for privileged permissions. The current Business Manager identity response has no verified MFA timestamp, so those operations remain unavailable rather than silently bypassing MFA.
- Added additive migration `007_admin_authorization_foundation.sql` for external-identity membership references and Admin audit events. Invitation and membership lifecycle operations remain P2-A02.
- Added versioned Admin principal/permission/role contracts and a protected `GET /api/admin/v1/context` endpoint.
- Changed the Nest global prefix from `/api/runtime` to `/api` while moving existing runtime controller prefixes to `runtime/*`. The effective public runtime URLs remain `/api/runtime/*`; this permits the separate `/api/admin/v1` control-plane boundary.

## Security boundary

- Public runtime session credentials cannot authenticate through the Business Manager identity bridge.
- Cookie-only requests are rejected; the verified application uses an Authorization header, so no cookie-authenticated CSRF surface was introduced.
- Browser-supplied tenant IDs do not select authority. Route tenant IDs must equal the resolved membership tenant.
- Permission elevation overrides are disabled. Stored deny overrides may reduce a fixed role; an `allow` override fails closed.
- `platform.support.access` is not included in any tenant role. A future support workflow must be explicit, time-bound, MFA-backed and audited.

## Verification

- Focused Admin tests — pass, 4 suites and 11 tests.
- Full `backend/sophia-runtime: npm test` under Node 22.23.2 — pass, 21 suites and 88 tests.
- Runtime typecheck and build — pass.
- `backend: npm run test:p0:boundaries` — pass, 26 new-product files scanned.
- Protected real-estate regression — pass, 7 suites and 30 tests.
- P2 contract drift/tests — pass, 15 tests.
- Local route smoke: unauthenticated `/api/admin/v1/context` returned 401. `/api/runtime/healthz` remained registered and returned 500 only because the smoke used an intentionally unreachable dummy database.

No live Business Manager identity, provider, email, billing or subscription operation was invoked. At the original checkpoint migration 007 was not applied. With explicit user authorization on 2026-09-23, migrations 006–009 were subsequently applied transactionally to the configured Neon database.

## Remaining limitations and next task

- Existing Business Manager auth has no verified MFA evidence. Privileged Sophia Admin operations remain fail-closed until that identity capability is implemented and verified.
- No Admin membership rows are seeded automatically. P2-A02 owns safe organisation/member lifecycle, and the current control-plane context remains inaccessible until an authorised migration/onboarding step creates membership data.
- P2-03 is next in roadmap order: scoped multi-tenant connector authority and tenant-isolation enforcement.
