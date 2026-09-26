# P4-A04 checkpoint — Knowledge, Tools and Connectors

Date: 2026-09-25 (Australia/Brisbane)

Status: complete with live-connector, profile-authoring and OAuth-lifecycle limits

## Outcome

Sophia Admin now exposes the complete P4-A04 workspace set through protected,
lazy routes:

- **Knowledge** retains the delivered managed-text and private-file lifecycle,
  approval/publication gates, granted snapshot preview and retirement controls.
  New component coverage proves private file intake remains disabled when
  readiness fails and unpublished revisions do not expose retrieval preview.
- **Tools** displays the compiled tool catalogue, safe input schemas, capability,
  scope, risk, confirmation, retry and idempotency policy. Its sandbox is
  synthetic-contract-only and explicitly has no external effects. Capability
  changes select tenant profile versions and active compatible connectors;
  only draft business-profile versions are editable.
- **Connectors** displays compiled registrations, approved scopes, tenant-bound
  account identity, binding state and health. Operators can verify/connect,
  test, reconnect and disconnect with optimistic revisions. A disconnect with
  unresolved command outcomes remains visibly `disconnecting` for
  reconciliation rather than being reported as completed.

The new capability-authoring dependency endpoint returns safe tenant profile
metadata and capability bindings. It does not return profile configuration,
provider settings, credential references or secret values. The tool registry
now includes the compiled input schema and execution policy already used by the
runtime; the Admin UI does not invent a separate policy catalogue.

## Plan correction

Plan version 2.1.16 records three repository constraints:

1. ADM-06 Knowledge was already delivered by P3-A01b1/P3-A01b2a, so this task
   preserves and regression-tests it instead of building a duplicate surface.
2. Capability bindings can change only on draft business-profile versions, but
   the published-only agent dependency catalogue could not safely drive this
   editor. A separate tenant-scoped, configuration-free selector was added.
3. The current compiled connector uses a server-owned runtime-scoped credential
   and the authenticated tenant's external company account. Browser secret
   entry or rotation would weaken this boundary, so Angular accepts neither.
   OAuth expiry/re-consent is not simulated for a connector that does not
   implement that lifecycle.

## Verification

- Frontend Angular typecheck — passed under Node 20.19.1.
- `npm run test:sophia` — 57 tests passed in Chrome Headless 154. Coverage
  includes unpublished Knowledge isolation, fail-closed file readiness, safe
  schema/policy display, synthetic no-effects tool testing, draft-only binding,
  tenant-account connector onboarding and absence of browser secret inputs.
- Frontend production build — passed with the existing bundle-budget, Manrope,
  HeyGen CommonJS and missing PrimeIcons warnings. Tools and Connectors markers
  are absent from the initial main bundle and present only in lazy chunks.
- Sophia Runtime typecheck, build and generated-contract drift check — passed.
- Focused Knowledge/Tools/Connectors backend run — 2 suites and 13 tests passed.
- Sophia Runtime full suite — 51 suites and 205 tests passed.
- `npm run test:p0:boundaries` — 137 new-product source files passed.
- `npm run test:p0:real-estate` — 8 suites and 38 regression tests passed.
- Frontend/backend `git diff --check` and plan JSON validation — passed.

No live connector probe, provider session, tool/business mutation, email,
booking, migration, secret rotation or production-data operation was invoked.

## Limits

- A tenant must already have a draft business-profile version before capability
  bindings can be edited. Business/profile creation and publication remain with
  their owning configuration control plane.
- The only current connector registration is runtime-scoped. OAuth expiry,
  callback, consent and refresh-token behavior require a future compiled
  connector contract and cannot be inferred from this one.
- Private knowledge file upload remains deployment-disabled until its documented
  storage, scanner and worker readiness gates pass.
- No authenticated multi-account browser E2E harness or live connector sandbox
  was available; component/service contracts and backend tests are not labeled
  as live E2E evidence.

## Next ready task

P4-A05 — implement Workflows and Escalations workspaces.
