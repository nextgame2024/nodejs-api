# P6-01 checkpoint — integrated Admin configuration readiness

Status: complete with limits
Recorded: 2026-09-25 (Australia/Brisbane)
Plan: 2.1.25

## Delivered

- A tenant-scoped `GET /api/admin/v1/tenants/:tenantId/onboarding-readiness`
  endpoint that aggregates persisted evidence for organisation access,
  foundational profiles, approved instructions/knowledge, connector and capability
  bindings, workflow/escalation policy, active immutable agent releases, pinned v2
  sessions and Admin audit events.
- Permission masking per readiness step. Callers cannot infer counts for modules
  they cannot read, and `activationReady` is `null` unless every required read
  permission is present.
- A fixed-role repair found by the integrated journey: configuration/release/audit
  roles can read escalation policy dependencies, Configuration Editor can author
  those policies, and only Operations Member retains case assignment/resolution.
  Organisation Owner gains visibility but no escalation edit authority.
- An Admin overview integration gate that displays the persisted result, partial
  visibility and future module status. It explicitly states that foundational
  business/provider/experience profiles are pre-provisioned outside the current UI.
- Removal of the stale overview message that described Knowledge as the only
  available workspace after ADM-01 through ADM-11 had been delivered.
- Unit and browser tests for ready, incomplete, restricted and unknown-tenant
  states, tenant URL encoding, authentication and the greenfield-provisioning
  boundary.

## Plan correction

The original task required the Admin screens to onboard a synthetic organisation
from zero. The repository does not have a platform-operator provisioning/context
exchange surface, and its Agent screen deliberately selects existing published
business, provider and experience dependencies rather than authoring them. The
active browser path also cannot safely create a v2 session until a managed kiosk
broker exists.

Plan 2.1.25 therefore defines P6-01 as an integration gate for an existing
authorised tenant whose foundations are supplied by the owning operational control
plane. Runtime session evidence is reported separately and is not required to
declare a configuration publishable. ADM-12 through ADM-16 remain planned; neither
navigation nor aggregate audit rows count as those workspaces being delivered.

## Verification

- Runtime portability-Core and production TypeScript checks, build and generated
  contract drift check — pass.
- Full Runtime suite — 62 suites, 252 tests passed, including 5 readiness tests.
- Frontend TypeScript typecheck — pass.
- Full Sophia Runtime/Admin Angular suite — 71 tests passed in Chrome Headless.
- Frontend production build — pass with the existing bundle/font/CommonJS and
  missing PrimeIcons warnings.
- Backend boundary check — 153 new-product source files passed.
- Protected real-estate regression — 8 suites, 38 tests passed.
- The exact readiness aggregate executed successfully against the configured Neon
  schema inside `BEGIN READ ONLY`/`ROLLBACK` with effective role
  `sophia_runtime_app`; the role has `BYPASSRLS=false`. The existing tenant is not
  activation-ready, which is expected because its integrated configuration steps
  are not populated. No identifier or row content was recorded in this checkpoint.

## Limits

No organisation or foundational profiles were written to the configured Neon
database. No live provider was allocated, no connector business effect was invoked,
and no external notification was sent. Greenfield organisation provisioning,
foundational profile authoring and the managed v2 kiosk broker remain separate
work. Existing module-specific tests provide the safe publication, denial and
rollback evidence; this checkpoint does not relabel their mocked or offline checks
as a live end-to-end session.

Next ready task: P6-02 — add operational status, usage and handoff accountability.
