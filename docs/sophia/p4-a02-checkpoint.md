# P4-A02 checkpoint — Organisations, Users and Permissions

Date: 2026-09-25 (Australia/Brisbane)

Status: complete with platform-identity, MFA and browser-E2E limits

## Outcome

Sophia Admin now has three protected, lazy routes backed by the existing Admin
APIs:

- **Organisations** edits the authenticated tenant's name, branding, timezone
  and locale using optimistic revision checks. It shows admission state and the
  real suspend/resume controls without deleting historical or committed
  business records.
- **Users** lists tenant memberships and invitations, exposes fixed-role and
  membership-status controls, issues only dry-run single-use invitations, shows
  the returned token once, and supports invitation revocation.
- **Permissions** renders the server role-permission matrix, MFA-sensitive
  grants and server-computed effective grants for each membership.

All routes derive `tenantId` from the cached server principal. There is no
browser organisation selector, arbitrary tenant URL builder, custom role
authoring, permission elevation control, platform role assignment or implicit
support impersonation. Self-change, stale revision, cross-tenant access,
permission enforcement and final-owner protections remain authoritative on the
backend, with allowed and denied lifecycle activity recorded through the Admin
audit service.

The membership API now returns effective permissions computed from the fixed
server role and deny overrides without exposing the override document. The
permission registry also returns the complete permission set, privileged-MFA
set and separate platform-only permissions, so Angular does not recreate the
authorization policy.

## Plan correction

Plan version 2.1.14 records two repository constraints:

1. Business Manager identity resolves exactly one company-bound organisation.
   No platform principal, organisation enumeration/provisioning API or context
   exchange exists, so tenant Admin cannot honestly implement a platform
   organisation list or switcher.
2. Business Manager's current `/user` response includes user, company, status
   and email but no `mfaVerifiedAt`. The server correctly requires recent MFA
   for role assignment and organisation suspension. Angular therefore renders
   those real controls fail-closed until the identity service supplies verified
   step-up evidence; no timestamp is inferred and no guard is weakened.

The repository has Karma component tests but no authenticated multi-account
browser E2E harness. Component/service contract tests and backend two-tenant and
role-policy tests are recorded accurately; they are not described as E2E.

## Verification

- Frontend Angular typecheck — passed under Node 20.19.1.
- `npm run test:sophia` — 47 tests passed in Chrome Headless 154, including
  server-bound tenant rendering, fail-closed MFA controls, one-time dry-run
  invitation handling, non-inferred organisation settings,
  platform-permission separation and effective grants.
- Frontend production build — passed with the existing bundle, Manrope,
  HeyGen CommonJS and missing PrimeIcons warnings.
- Sophia Runtime typecheck — passed.
- Sophia Runtime full test suite — 51 suites and 202 tests passed.
- Targeted Admin authorization/lifecycle run — 3 suites and 20 tests passed,
  including second-tenant rejection, operations-role denial, recent-MFA owner
  authorization, stale revisions, invitation safety and final-owner protection.
- `npm run test:p0:boundaries` — 126 new-product source files passed.
- `npm run test:p0:real-estate` — 8 suites and 38 regression tests passed.

No production data, live invitation delivery, email, provider, migration,
organisation suspension or membership mutation was invoked.

## Next ready task

P4-A03 — implement Agents, Agent versions and Instructions screens.
