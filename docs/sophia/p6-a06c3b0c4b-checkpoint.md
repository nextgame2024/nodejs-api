# P6-A06C3B0C4B implementation checkpoint

Date: 2026-09-28 (Australia/Brisbane)

Status: in progress. Provider integration and durable reconciliation are implemented; the real sandbox lifecycle proof is still pending.

## Delivered

- Active-minute Checkout now requires two plan-version mappings: one licensed fixed recurring Price for the monthly base charge and one Meter-backed recurring Price for whole overage minutes. Both are retrieved and checked against the immutable plan before Stripe Checkout is created.
- The aggregate Meter event is timestamped one second before the exact provider-period end. Stripe Meter summaries use an inclusive start and exclusive end, so the prior period-end timestamp was outside the period being reconciled.
- Reconciliation reads the exact full-period Meter summary and finalized `open` or `paid` invoice lines. It requires one summary and one line to match the immutable quantity, unit price, currency, metered Price, environment and period.
- Migration 047 adds tenant-isolated immutable reconciliation evidence. The outbox cannot advance from `provider_accepted` or `outcome_unknown` to `reconciled` until that evidence is inserted in the same transaction.
- A missing summary or invoice line remains `pending` because Stripe aggregation and invoice production are asynchronous. Any conflict remains `mismatch`; neither state claims billing correctness.
- The Checkout billing-context query now actually selects the rate card it validates and passes to the adapter.
- The existing recent-MFA billing reconciliation action finalizes eligible periods, dispatches at most one sandbox outbox item, and then attempts reconciliation. Its live path is read-only and explicitly refuses Meter dispatch pending a later live usage-billing activation decision.

## Evidence

- Migration `047_billing_meter_reconciliation_evidence.sql` was applied to Neon.
- The rollback-only Neon probe verified forced RLS for the outbox and reconciliation evidence, cross-tenant hiding, immutable evidence, least-privilege `SELECT, INSERT` access to evidence, fenced claims, stale-token denial and permanent quarantine of ambiguous submissions. All probe rows were rolled back.
- Runtime portability typecheck, typecheck, build and generated-contract drift check pass.
- Runtime tests: 113 suites, 398 tests.
- Backend boundary scan: 225 files. Protected real-estate characterization: 8 suites, 38 tests.

## Remaining C4B external proof

No Stripe request was made in this slice and no Meter event, Checkout, invoice or charge was created.

The deployed sandbox still needs the exact fixed-base Price mappings for Voice, Live and Premium, the three Meter-backed Price mappings, and the semantic `active-overage-minutes` Meter event-name binding. A tenant then needs an approved base-plus-metered sandbox subscription and one closed provider period with positive overage. Run dispatch once and repeat reconciliation until Stripe supplies the exact summary and finalized invoice line. Preserve the resulting redacted object identities as completion evidence.

Live mappings and live Meter events remain prohibited in C4B. Live Checkout remains disabled.
