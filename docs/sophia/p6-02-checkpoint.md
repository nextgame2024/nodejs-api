# P6-02 checkpoint — operational and usage accountability

Status: complete with limits
Recorded: 2026-09-25 (Australia/Brisbane)
Plan: 2.1.26

## Delivered

- An additive tenant usage ledger keyed by a stable source-event identity with
  provider/adapter attribution, provider-independent dimensions and explicit
  `incomplete`, `estimated` or `measured` evidence.
- Idempotent replay handling: identical source evidence returns the existing row;
  reuse of that source identity with different evidence fails. Unknown final
  reasoning usage records an incomplete event and can reconcile forward under an
  optimistic revision.
- Optional provider-cost estimates require currency and cost-table version and are
  labelled `customerCharge: false`. No commercial price or customer charge was
  inferred.
- Database enforcement beyond the API: forced tenant RLS, composite session/tenant
  ownership, immutable source identity, forward-only evidence state, immutable
  measured rows, and revoked Runtime DELETE/TRUNCATE privilege.
- Permissioned operational APIs:
  - `GET /api/admin/v1/tenants/:tenantId/operations/status` for session, tool,
    workflow, queue, retry-capability, handoff and alert status.
  - `GET /api/admin/v1/tenants/:tenantId/operations/usage` for aggregate usage,
    evidence completeness and versioned provider-cost estimates.
- Threshold signals for queue age, orphan sessions, recent failures and denial
  spikes, without pretending they are the future ADM-14 dashboard.
- Explicit handoff semantics: internal inbox supported; callback request is not
  completion, notification acceptance is not verified delivery, and live transfer
  remains unsupported without connector-confirmed connection evidence.

## Plan correction

P6-02 originally implied generic manual retry and a budget-exhaustion alert. The
repository already has a safe compiled-owner/idempotency-gated workflow retry and
leased provider cleanup reconciliation, but sessions and arbitrary tool mutations
are not replay-safe. It also has no approved tenant budget, provider cost table,
commercial rate card or executable external handoff adapter.

Plan 2.1.26 therefore exposes retry capability rather than adding unsafe replay,
records provider usage without calling it billing, and reports budget status as
unavailable until P6-A05 defines an approved policy. P6-A03 still owns metric
definitions/dashboard aggregation and P6-A05 still owns plans, budgets, quotas and
billing views.

## Verification

- Runtime portability-Core and production TypeScript checks — pass.
- Runtime build and generated-contract drift check — pass.
- Full Runtime suite — 66 suites, 261 tests passed.
- Focused P6-02 suites — migration, usage ledger, operational status and reasoning
  instrumentation passed; the final usage-summary suite passed 2 tests after the
  sequential PostgreSQL client compatibility correction.
- Backend boundary check — 159 new-product source files passed.
- Protected real-estate regression — 8 suites, 38 tests passed.
- Exact operational status and usage queries executed read-only against configured
  Neon under `sophia_runtime_app`; response shapes passed and budget status was
  honestly `unavailable`.

## Database deployment evidence

- `019_operational_accountability.sql` applied successfully to configured Neon.
- `020_usage_ledger_hardening.sql` applied successfully to configured Neon.
- A rollback-only synthetic probe under `sophia_runtime_app` proved:
  - RLS and FORCE RLS are enabled;
  - one usage source inserts once and identical replay inserts zero rows;
  - a cross-tenant insert is denied;
  - measured-row update is denied;
  - Runtime deletion is denied.
- Both probes rolled back. No synthetic tenant, session or usage row remains.

## Limits

No provider call, connector business mutation, message, email, payment or
subscription operation was invoked. No approved cost table or tenant budget exists,
so the ledger currently captures usage evidence and incompleteness but does not
calculate provider cost by default. There is no generic retry endpoint, no external
handoff execution and no ADM-14/ADM-16 UI; those remain deliberately assigned to
their later tasks.

Next ready task: P6-A02 — build the Evaluations workspace and publication evidence checks.
