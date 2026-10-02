# P6-A06C3B0C4B implementation checkpoint

Date: 2026-10-02 (Australia/Brisbane)

Status: in progress. The fresh draft-renewal invoice adjustment was attached and finalized in Stripe sandbox. Exact reconciliation exposed and locally corrected one canonical Stripe invoice-line field assumption; redeployment and deterministic read-back recovery are pending.

## Deployed sandbox preparation

- Render is live on revision `8eee034b3182` with the fixed-base mappings, Meter-backed mappings and `active-overage-minutes` event-name binding configured.
- The demo tenant's legacy AUD 1 assignment ended at the exact existing provider-period boundary `2026-09-26T08:31:49Z`.
- Sophia Voice is its sole active assignment from that boundary, using the published AUD 750 monthly base, 2,000 included active minutes and AUD 0.10 whole-minute overage rate.
- The existing sandbox Customer remains bound to its historical non-clocked subscription. It will not be overwritten or repurposed for accelerated proof.
- Synthetic tenant `5b45d778-4fb0-458e-a337-b115c3169927` is reserved for the isolated proof and has Sophia Voice as its sole active assignment. It has no Stripe binding until the deployed harness `prepare` stage runs.

## Test-clock correction

Stripe test clocks attach only to newly created Customers. C4B therefore uses a separate synthetic sandbox tenant, Customer and Voice subscription. The operator harness may pass a bounded simulated provider time to the ledger finalizer, but only through the sandbox-specific method and for at most two monthly intervals. Normal API reconciliation and every live path continue to use database `now()`.

The original proof attempted to stage the aggregate event before renewal-invoice finalization. Real test-clock behavior showed that advancing past the provider boundary created and paid the renewal invoice before Sophia could finalise the exact period ledger and submit the aggregate. The harness therefore proved that the proposed ordering cannot be relied upon.

The compiled production-image harness is `npm run billing:c4b-sandbox -- prepare|close|finalize|status`. It refuses live mode and non-test keys, requires the reserved C4B tenant and Sophia Voice assignment, and requires an explicit confirmation environment value. The public API cannot supply the simulated cutoff.

The first deployed `prepare` attempt created the isolated test clock and Customer and attached a Stripe-generated test PaymentMethod, then stopped before subscription creation because it used the reusable test alias rather than the returned attached ID as the Customer default. The resumable harness now discovers/reuses that attached card and persists its concrete ID before continuing. No subscription, Meter event, invoice or charge resulted from the stopped attempt.

The resumed `prepare` created the intended Voice subscription and one synthetic positive-overage interval, then exposed a pooled-database role assumption defect during reconciliation. Neon grants were correct and the exact query passed under an explicit `sophia_runtime_app` transaction. Plan 2.1.53 therefore moves least-privilege role assumption into every transaction with `SET LOCAL ROLE`; connection-session role state is no longer trusted across the pooled endpoint. The stopped attempt created no Meter event.

After transaction-local role assumption was deployed, reconciliation exposed a second least-privilege mismatch: immutable provider-period selection used `FOR UPDATE`, which requires table `UPDATE` privilege. Plan 2.1.54 removes that redundant row lock instead of broadening the runtime grant. The existing tenant/provider advisory transaction lock serializes finalization, and unique period-ledger constraints plus digest comparison remain the idempotence fence.

The next resumed `prepare` reached the outbox dispatcher and exposed the same privilege class in a different concurrency boundary: the claim joined the mutable outbox to its immutable usage ledger and used an unqualified `FOR UPDATE SKIP LOCKED`. PostgreSQL therefore attempted to lock both tables and required an invalid ledger `UPDATE` grant. Plan 2.1.55 narrows the clause to `FOR UPDATE OF o SKIP LOCKED`; concurrent workers still fence the mutable outbox claim, while the immutable ledger remains `SELECT, INSERT` only. The exact corrected joined query succeeds under `sophia_runtime_app` in a rollback-only Neon transaction.

The corrected `prepare` then completed on the existing isolated Customer and subscription. Its observation found one active subscription and invoice, no eligible closed period, no ledger and no Meter event, which is the expected pre-close state. The first `close` advanced the test clock to the period-end target and then stopped before ledger creation because the open-activity guard bound an unused `$2` and referenced `$3`; PostgreSQL could not infer the unused parameter type. Plan 2.1.56 uses contiguous parameters and an explicit `timestamptz` cutoff. A rollback-only runtime-role proof passed, and Neon confirms that the stopped attempt left zero C4B ledgers and zero outbox events, so the same `close` stage can resume without duplicate provider submission.

The next `close` reached transactional ledger/outbox creation and exposed a schema assumption: the outbox required `event_timestamp <= created_at`, but the isolated Stripe test clock had advanced one provider month beyond database wall time. The transaction rolled back, leaving zero C4B ledgers and zero outbox events. Migration 048 replaces the anonymous rule with an environment-specific named constraint: live events remain non-future, while sandbox events are bounded to `created_at + 62 days`, matching the separate harness cutoff. The migration is applied to Neon; it does not permit simulated live events or expose a public clock override.

The corrected `close` finalized one immutable ledger with two whole overage minutes at AUD 0.10 and Stripe accepted exactly one Meter event. The outbox remains `provider_accepted` with attempt count one and no reconciliation evidence, so `close` must not be rerun. Its immediate reconciliation returned a local mismatch because the real provider period is `2026-09-28T08:51:05Z` through `2026-10-28T08:51:05Z`, while Stripe requires Meter-summary request bounds aligned to minutes. Plan 2.1.58 keeps the exact second boundaries for invoice-line matching but uses ceil-to-minute summary bounds. This includes the single aggregate event at period-end minus one second and excludes the preceding period's aggregate event.

After the aligned-summary fix, two finalize windows found the Meter summary but not a finalized invoice line matching the exact metered Price and provider period. The accepted event remains unchanged and is not redispatched. Plan 2.1.59 adds a gated read-only `diagnose` stage that emits bounded non-personal invoice, line, Price, quantity and period metadata so the remaining provider-state mismatch can be identified without another billing mutation.

The diagnostic completed the investigation. Stripe reports one exact aligned Meter summary with quantity `2`, so the event and Meter binding are correct. The renewal invoice is already `paid`; its approved metered Price line has quantity `0`, amount `0`, and ends at `2026-10-28T08:51:00Z`. The exact subscription period ends at `08:51:05Z`, and Sophia's single aggregate was timestamped at `08:51:04Z`. A closed invoice cannot be retroactively changed, and repeated reconciliation cannot turn this line into quantity two.

Plan 2.1.60 therefore invalidates the Meter-backed subscription line as the charging mechanism for Sophia's post-period aggregate-once rule. The existing outbox row remains honest `provider_accepted` evidence and must never be redispatched or marked reconciled. The corrected path will preserve the Meter summary as independent usage-delivery evidence, then add the immutable whole-minute quantity and unit rate idempotently to the matching draft renewal invoice using a separately approved one-time overage Price. That path needs a fresh isolated fixture, duplicate `invoice.created` proof, missed-draft-window recovery and exact finalized invoice-line evidence before any live usage charge is possible.

The operator approved sandbox one-time Price `price_1ULyegGcz4GrZOEBwDHdpzPW` for Sophia Voice at AUD 0.10, tax-exclusive. Plan 2.1.61 records a timing correction found during implementation: a signed `invoice.created` observation must not be acknowledged successfully until the exact immutable ledger exists and Stripe has authoritatively accepted the digest-bound invoice item. Duplicate signed deliveries re-enter adjustment processing even though provider observations remain deduplicated. This preserves deterministic idempotency and lets Stripe retry rather than silently finalizing an unadjusted draft.

Migration 049 was applied with the database owner connection, and a new isolated tenant `2a7f6a09-3f9d-4f7e-aeaf-925baa1120c5` completed `prepare` and `close`. Stripe accepted invoice item adjustment `a940cf44-2899-405e-9683-2557ca14a2d8` on draft renewal invoice `in_1ULzSOGcz4GrZOEBwnUz3FH4`; the immutable ledger contains two overage minutes and the independent Meter event was accepted. Finalization then produced a false local mismatch: API 2025-08-27.basil carries the invoice-item line's subscription under `parent.invoice_item_details.subscription`, while the compatibility top-level `line.subscription` can be null. Plan 2.1.62 corrects the canonical read-back field and permits the `reconciliation_failed` row to be revalidated without redispatch or a second invoice item.

## Delivered

- The currently deployed active-minute Checkout requires one licensed fixed recurring Price plus one Meter-backed recurring Price. The sandbox proof invalidated that second Price as the charging mechanism for a post-period aggregate; C4B3 must replace new Checkout composition with the fixed base only and validate a separate one-time overage Price before invoice adjustment.
- The aggregate Meter event is timestamped one second before the exact provider-period end. Stripe Meter summaries use an inclusive start and exclusive end, so the prior period-end timestamp was outside the period being reconciled.
- Reconciliation reads the exact full-period Meter summary and finalized `open` or `paid` invoice lines. It requires one summary and one line to match the immutable quantity, unit price, currency, metered Price, environment and period.
- Migration 047 adds tenant-isolated immutable reconciliation evidence. The outbox cannot advance from `provider_accepted` or `outcome_unknown` to `reconciled` until that evidence is inserted in the same transaction.
- A missing summary or invoice line remains `pending` because Stripe aggregation and invoice production are asynchronous. Any conflict remains `mismatch`; neither state claims billing correctness.
- The Checkout billing-context query now actually selects the rate card it validates and passes to the adapter.
- The existing recent-MFA billing reconciliation action finalizes eligible periods, dispatches at most one sandbox outbox item, and then attempts reconciliation. Its live path is read-only and explicitly refuses Meter dispatch pending a later live usage-billing activation decision.
- New Checkout composition contains only the licensed recurring base Price. It validates the separately mapped one-time overage Price but does not add the disproved recurring Meter-backed Price as a subscription item.
- Migration 049 adds the tenant-isolated digest-bound invoice-adjustment outbox, fenced retry/ambiguity states, missed-window state and immutable finalized-line reconciliation evidence.
- The Stripe sandbox adjustment adapter validates the exact draft invoice, Customer, subscription, provider period, one-time Price, currency, unit amount and non-GST tax behavior before one idempotent write. Live dispatch and reconciliation remain disabled.
- Finalized-line read-back requires exactly one adjustment line matching the adjustment and ledger metadata, Price, quantity, unit amount, total amount, currency and exact inclusive line period before the outbox becomes `reconciled`.
- Invoice-item line subscription identity is read from Stripe's canonical `parent.invoice_item_details.subscription`; a prior local `reconciliation_failed` result may be revalidated, but it is never eligible for dispatch.
- An exact finalized zero-overage ledger is a successful no-adjustment outcome and releases the draft invoice; only a genuinely missing ledger or an unresolved positive adjustment applies webhook retry backpressure.

## Evidence

- Migration `047_billing_meter_reconciliation_evidence.sql` was applied to Neon.
- The rollback-only Neon probe verified forced RLS for the outbox and reconciliation evidence, cross-tenant hiding, immutable evidence, least-privilege `SELECT, INSERT` access to evidence, fenced claims, stale-token denial and permanent quarantine of ambiguous submissions. All probe rows were rolled back.
- Runtime portability typecheck, typecheck, build and generated-contract drift check pass.
- Plan 2.1.61 Runtime tests: 117 suites, 420 tests. Plan 2.1.62 Runtime tests: 117 suites, 422 tests. Both Runtime typechecks, build and generated-contract drift check pass.
- Backend boundary scan: 231 files. Protected real-estate characterization: 8 suites, 38 tests.

## Remaining C4B external proof

The deployed mappings, migration 049, fresh Sophia Voice assignment, isolated subscription, immutable ledger, accepted Meter event and attached one-time invoice adjustment are complete. The older fixture's paid zero-quantity Meter line remains preserved as negative provider evidence and must not be rerun.

The remaining work is P6-A06C3B0C4B3 deployed proof: deploy plan 2.1.62, rerun only `finalize` on the fresh fixture to recover exact finalized-line evidence without resubmission, then prove real duplicate webhook behavior and missed-window recovery. The old negative fixture must not be reused.

Live mappings and live Meter events remain prohibited in C4B. Live Checkout remains disabled.
