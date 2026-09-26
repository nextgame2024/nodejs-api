# P3-A03 checkpoint — workflow configuration and escalation lifecycle APIs

P3-A03 is complete with external-channel and current-owner retry limits. Runtime owns versioned configuration and case metadata; Business Manager retains authoritative report and delivery execution.

## Delivered

- Added a compiled workflow-template registry. The real-estate sale report template exposes a strict fixed-shape configuration and fixed booking-review authorization; tenant configuration cannot add tools or remove confirmation.
- Added tenant-scoped workflow definitions, immutable published versions, release validation and resolved workflow bindings in newly published agent manifests.
- Added durable workflow-run references that pin an immutable workflow version, capability binding and opaque owner reference. Status is read from the compiled owner adapter rather than a duplicate Runtime worker.
- Added idempotent manual-retry command records. A retry is callable only when a compiled template supplies an owner-side idempotent implementation; ambiguous submission becomes `outcome_unknown` and the same key is not submitted again.
- The current Business Manager report workflow declares status support but no safe manual retry, so retry is visibly rejected without a business mutation.
- Added escalation destination, policy-version, case, assignment, lifecycle-event and resolution APIs with optimistic revisions and separate case, delivery and transfer states.
- The internal operations inbox is supported. Callback, notification and live transfer remain visibly unsupported because no executable compiled handoff adapter exists.
- Agent publication now verifies referenced workflow and escalation policy versions are published and belong to the tenant.

## Repository-driven plan correction

The Business Manager report-job row is a shared tenant/version/input cache and is not a unique booking workflow execution. The per-booking confirmation-delivery row is now the execution reference and stores the Sophia workflow-version UUID supplied by a newly published v2 agent release. Existing releases continue to work but must be republished before new runs receive this pin. Plan 2.1.9 records this correction.

## Database evidence

- Runtime migration `018_workflow_and_escalation_control_plane.sql` was applied to configured Neon.
- Workflow, retry and escalation tables use forced tenant RLS.
- Rollback-only verification confirmed `sophia_runtime_app` is non-superuser and non-`BYPASSRLS`, sees only the selected tenant and cannot insert a cross-tenant workflow definition.
- The additive Business Manager `workflow_version_id` UUID column was applied and verified on the booking-specific delivery table.

## Verification

- Sophia Runtime typecheck/build: passed.
- Sophia Runtime: 51 suites, 198 tests passed.
- Protected real-estate workflow: 8 suites, 38 tests passed.
- Contract checks: 15 tests passed.
- Backend release suite: 17 suites, 72 tests passed; 12 SQL-gated tests skipped in the ordinary offline run.
- Configured Neon SQL release suite: 4 suites and 11 tests passed; 1 live-provider test skipped. The first run encountered the unrelated global student-consultation advisory lock; the immediate clean rerun passed.
- Boundary scan: 110 new-product source files passed.

## Remaining limits

- Existing agent releases do not gain workflow bindings by mutation; republish a validated release to activate version propagation for future executions.
- No external handoff channel or verified live-transfer connector exists. Operations cases are durable, but only the internal inbox is currently activatable.
- ADM-09/ADM-11 Angular workspaces remain P4-A05 after the shared P4 Admin shell work.
