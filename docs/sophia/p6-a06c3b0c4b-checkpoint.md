# P6-A06C3B0C4B implementation checkpoint

Date: 2026-09-28 (Australia/Brisbane)

Status: in progress. Provider integration and durable reconciliation are implemented; the real sandbox lifecycle proof is still pending.

## Deployed sandbox preparation

- Render is live on revision `8eee034b3182` with the fixed-base mappings, Meter-backed mappings and `active-overage-minutes` event-name binding configured.
- The demo tenant's legacy AUD 1 assignment ended at the exact existing provider-period boundary `2026-09-26T08:31:49Z`.
- Sophia Voice is its sole active assignment from that boundary, using the published AUD 750 monthly base, 2,000 included active minutes and AUD 0.10 whole-minute overage rate.
- The existing sandbox Customer remains bound to its historical non-clocked subscription. It will not be overwritten or repurposed for accelerated proof.
- Synthetic tenant `5b45d778-4fb0-458e-a337-b115c3169927` is reserved for the isolated proof and has Sophia Voice as its sole active assignment. It has no Stripe binding until the deployed harness `prepare` stage runs.

## Test-clock correction

Stripe test clocks attach only to newly created Customers. C4B therefore uses a separate synthetic sandbox tenant, Customer and Voice subscription. The operator harness may pass a bounded simulated provider time to the ledger finalizer, but only through the sandbox-specific method and for at most two monthly intervals. Normal API reconciliation and every live path continue to use database `now()`.

The proof is staged so the aggregate event is accepted while the renewal invoice is still draft: observe the closed provider period, finalise the Sophia ledger, dispatch the Meter event, wait for its asynchronous summary, then advance/finalise the invoice and require the exact invoice line. This avoids claiming success from an event submitted after invoice finalization.

The compiled production-image harness is `npm run billing:c4b-sandbox -- prepare|close|finalize|status`. It refuses live mode and non-test keys, requires the reserved C4B tenant and Sophia Voice assignment, and requires an explicit confirmation environment value. The public API cannot supply the simulated cutoff.

The first deployed `prepare` attempt created the isolated test clock and Customer and attached a Stripe-generated test PaymentMethod, then stopped before subscription creation because it used the reusable test alias rather than the returned attached ID as the Customer default. The resumable harness now discovers/reuses that attached card and persists its concrete ID before continuing. No subscription, Meter event, invoice or charge resulted from the stopped attempt.

The resumed `prepare` created the intended Voice subscription and one synthetic positive-overage interval, then exposed a pooled-database role assumption defect during reconciliation. Neon grants were correct and the exact query passed under an explicit `sophia_runtime_app` transaction. Plan 2.1.53 therefore moves least-privilege role assumption into every transaction with `SET LOCAL ROLE`; connection-session role state is no longer trusted across the pooled endpoint. The stopped attempt created no Meter event.

After transaction-local role assumption was deployed, reconciliation exposed a second least-privilege mismatch: immutable provider-period selection used `FOR UPDATE`, which requires table `UPDATE` privilege. Plan 2.1.54 removes that redundant row lock instead of broadening the runtime grant. The existing tenant/provider advisory transaction lock serializes finalization, and unique period-ledger constraints plus digest comparison remain the idempotence fence.

The next resumed `prepare` reached the outbox dispatcher and exposed the same privilege class in a different concurrency boundary: the claim joined the mutable outbox to its immutable usage ledger and used an unqualified `FOR UPDATE SKIP LOCKED`. PostgreSQL therefore attempted to lock both tables and required an invalid ledger `UPDATE` grant. Plan 2.1.55 narrows the clause to `FOR UPDATE OF o SKIP LOCKED`; concurrent workers still fence the mutable outbox claim, while the immutable ledger remains `SELECT, INSERT` only. The exact corrected joined query succeeds under `sophia_runtime_app` in a rollback-only Neon transaction.

The corrected `prepare` then completed on the existing isolated Customer and subscription. Its observation found one active subscription and invoice, no eligible closed period, no ledger and no Meter event, which is the expected pre-close state. The first `close` advanced the test clock to the period-end target and then stopped before ledger creation because the open-activity guard bound an unused `$2` and referenced `$3`; PostgreSQL could not infer the unused parameter type. Plan 2.1.56 uses contiguous parameters and an explicit `timestamptz` cutoff. A rollback-only runtime-role proof passed, and Neon confirms that the stopped attempt left zero C4B ledgers and zero outbox events, so the same `close` stage can resume without duplicate provider submission.

The next `close` reached transactional ledger/outbox creation and exposed a schema assumption: the outbox required `event_timestamp <= created_at`, but the isolated Stripe test clock had advanced one provider month beyond database wall time. The transaction rolled back, leaving zero C4B ledgers and zero outbox events. Migration 048 replaces the anonymous rule with an environment-specific named constraint: live events remain non-future, while sandbox events are bounded to `created_at + 62 days`, matching the separate harness cutoff. The migration is applied to Neon; it does not permit simulated live events or expose a public clock override.

The corrected `close` finalized one immutable ledger with two whole overage minutes at AUD 0.10 and Stripe accepted exactly one Meter event. The outbox remains `provider_accepted` with attempt count one and no reconciliation evidence, so `close` must not be rerun. Its immediate reconciliation returned a local mismatch because the real provider period is `2026-09-28T08:51:05Z` through `2026-10-28T08:51:05Z`, while Stripe requires Meter-summary request bounds aligned to minutes. Plan 2.1.58 keeps the exact second boundaries for invoice-line matching but uses ceil-to-minute summary bounds. This includes the single aggregate event at period-end minus one second and excludes the preceding period's aggregate event.

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

The deployed mappings and Sophia Voice assignment are complete. The remaining work is to run the isolated test-clock harness, create its base-plus-metered Voice subscription and positive-overage fixture, dispatch once during the draft-invoice window, and repeat reconciliation until Stripe supplies the exact summary and finalized invoice line. Preserve the resulting redacted object identities as completion evidence.

Live mappings and live Meter events remain prohibited in C4B. Live Checkout remains disabled.
