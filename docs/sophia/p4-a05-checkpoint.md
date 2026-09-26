# P4-A05 checkpoint — Workflows and Escalations

Date: 2026-09-25 (Australia/Brisbane)

Status: complete with current-owner retry, step-model and external-handoff limits

## Outcome

Sophia Admin now exposes two protected, lazy workspaces backed by the existing
tenant-scoped control-plane APIs:

- **Workflows** renders compiled template metadata, fixed authorization and
  constant-only configuration from the server schema. Operators can create a
  definition, create immutable draft versions and publish them for future agent
  releases. The run viewer reads aggregate authoritative status from the owner
  adapter and does not invent step records.
- **Escalations** renders the channel registry, allows destination/policy
  creation only against supported active channels, and provides an internal
  operations inbox with separate case, delivery and transfer states. Operators
  can inspect event evidence and perform optimistic assign/start/resolve
  transitions according to named permissions.

The current Business Manager workflow declares status support but no safe
manual retry contract, so the UI shows reconciliation guidance and no retry
button. If a future compiled template declares `owner-idempotent`, the existing
server command path and UI gate require an idempotency key and preserve unknown
outcomes without resubmission.

The escalation transition query was tightened so assigning a case cannot
regress an `in_progress` case back to `assigned`. Server optimistic revision
checks remain authoritative.

## Plan correction

Plan version 2.1.17 records that:

1. The current template schema is constant-only. Angular derives those declared
   values and refuses unsupported schema shapes instead of offering arbitrary
   JSON or tenant-defined executable configuration.
2. The workflow store exposes aggregate owner status but no durable step graph.
   The workspace explicitly states this and does not fabricate a timeline.
3. Manual retry is unavailable for the current owner. An enabled button would
   falsely imply safe idempotent execution.
4. Only `operations_inbox` has an executable adapter. Callback, notification
   and live transfer remain visible as unsupported and cannot be selected as
   active destinations.

## Verification

- Frontend Angular typecheck — passed under Node 20.19.1.
- `npm run test:sophia` — 62 tests passed in Chrome Headless 154. Coverage
  includes compiled configuration derivation, refusal of arbitrary JSON,
  aggregate status without fake steps, unsupported retry suppression, channel
  availability, separate case/delivery/transfer state and event evidence.
- Frontend production build — passed with the existing bundle-budget, Manrope,
  HeyGen CommonJS and missing PrimeIcons warnings. Workflow and Escalation
  markers are absent from the initial main bundle and present only in lazy
  chunks.
- Sophia Runtime typecheck, build and generated-contract drift check — passed.
- Focused Workflow/Escalation backend run — 2 suites and 5 tests passed.
- Sophia Runtime full suite — 51 suites and 206 tests passed.
- `npm run test:p0:boundaries` — 141 new-product source files passed.
- `npm run test:p0:real-estate` — 8 suites and 38 regression tests passed.
- Frontend/backend `git diff --check` and plan JSON validation — passed.

No live workflow-status probe, retry, connector operation, callback,
notification, transfer, provider session, email, booking, migration or
production-data operation was invoked.

## Limits

- The current workflow owner supports status lookup but explicitly does not
  support manual retry. Operators must reconcile through the authoritative
  owner rather than resubmit.
- No durable workflow-step records exist, so only aggregate owner status and
  returned owner detail can be displayed.
- Callback, notification and verified live transfer remain unavailable until a
  compiled executable adapter implements both request and evidence semantics.
- No authenticated multi-account browser E2E harness or live owner sandbox was
  available; component/service contracts are not described as live E2E proof.

## Next ready task

P4-04 — complete durable confirmation and shared-kiosk privacy UX.
