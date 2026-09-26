# P6-A03A checkpoint — Analytics registry and canonical aggregation

Completed 26 September 2026.

## Delivered

- `GET /admin/v1/tenants/:tenantId/analytics` now requires `analytics.read` and returns a tenant-scoped, bounded analytics dashboard.
- The provider-neutral core registry versions operational conversation, tool, workflow and escalation metrics and documents their denominators and canonical sources.
- Business packs may add only declarative `source_confirmed` count metrics tied to canonical tools owned by that pack. Registration rejects duplicate metric keys and references to tools outside the pack.
- The real-estate pack declares confirmed inspection-booking and confirmation-resend outcomes without making either metric a Core requirement.
- Aggregation runs on demand over canonical records, segments by organisation-local date, agent, immutable release and channel, and supports a maximum 366-day range. No premature analytics table or migration was added.
- Tool attempts use invocation identity. Pack outcomes use command identity with invocation/tool-call fallback, so retries or duplicated observations do not inflate a confirmed business command.
- Session closure remains an operational lifecycle observation, not a conversion. Specialised outcomes require the canonical tool's recorded success outcome.
- The response reports latest source freshness, measured/estimated/incomplete usage coverage and unattributed usage. Invalid or absent organisation timezone falls back to UTC with a visible warning.
- Provider estimates remain grouped by source currency, cost-table version and measurement status. No currency conversion, customer charge, revenue, savings or causal impact is inferred.

## Database and Neon verification

- This slice needs no migration: it reads the existing forced-RLS canonical session, tool, workflow, escalation and provider-usage records.
- A rollback-only probe ran as `sophia_runtime_app` against the configured Neon schema. It verified UTC fallback for an invalid timezone, one started conversation, one attempted tool command, one pack-declared source-confirmed outcome, a separated USD estimate with `customerCharge=false`, and on-demand aggregation. All synthetic records were rolled back.

## Verification

- Runtime production typecheck, build and generated-contract drift check passed.
- All 81 Runtime suites/296 tests passed, including registry isolation, range bounds, timezone fallback, permission metadata and source-confirmed metric behavior.
- The architecture boundary scan passed across 192 new-product files.
- The protected real-estate characterization passed 8 suites/38 tests.

## Plan refinement and remaining limits

Plan 2.1.33 records the evidence-driven split of P6-A03. Persistent aggregates are deferred until measured volume or latency requires them; a write model now would add reconciliation and deletion obligations without evidence. Pack declarations contain no SQL or executable aggregation logic.

P6-A03 remains in progress. P6-A03B must add bounded expiring analytics exports and the business-neutral Angular Analytics workspace. It must preserve the source/coverage/currency distinctions established here.

Next ready task: P6-A03B — analytics exports and Angular workspace.
