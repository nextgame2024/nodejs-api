# P6-A06C3B0C4A checkpoint — durable meter-event outbox

Date: 2026-09-27 (Australia/Brisbane)

## Outcome

Migrations 044 and 045 are applied to Neon. The runtime now has a durable, tenant-isolated, provider-neutral boundary for submitting final whole-minute overage quantities, while the deployed dispatcher remains deliberately disabled.

- A positive finalised period ledger and its meter-event outbox row are persisted in one tenant transaction. This removes the ledger/job dual-write gap.
- A zero-overage period keeps its immutable ledger but creates no meaningless provider event.
- Each payload pins the immutable ledger and digest, account-scoped provider Customer, provider/environment/account scope, semantic Meter binding, period-end timestamp, whole-minute quantity and deterministic submission identifier.
- The worker boundary recalculates the ledger-bound payload digest before any provider call.
- Claims use `FOR UPDATE SKIP LOCKED`, expiring lease tokens, monotonic bounded attempts and fenced completion.
- A lease can be reclaimed only when it expired before submission started. A thrown or explicitly ambiguous post-submit result becomes `outcome_unknown` and cannot automatically return to `pending`.
- Definite pre-submit/provider rejections may use bounded exponential backoff; exhausted or non-retryable work becomes `terminal_failed`.
- The Usage/Billing read model exposes non-secret outbox state for operator visibility but not the external Customer reference.

## Plan correction

Plan 2.1.49 records that outbox creation must be atomic with ledger finalisation. It also records that deterministic identity does not by itself authorize blind retry after an ambiguous provider write, and that zero-overage periods must not emit a provider event.

## Database verification

- Migrations 044 and 045 applied successfully to Neon.
- A rollback-only proof under `sophia_runtime_app` confirmed forced RLS, cross-tenant hiding, `SELECT`/`INSERT`/`UPDATE` without `DELETE`/`TRUNCATE`, one fenced claim, stale-token rejection and denial of `outcome_unknown -> pending`.
- All synthetic proof records were rolled back.

## Test evidence

- Runtime portability-Core typecheck, production typecheck, build and generated-contract drift check passed.
- Runtime: 110 suites / 382 tests passed.
- Backend new-product boundary scan passed for 223 files.
- Protected real-estate regression: 8 suites / 38 tests passed.

## Safety and remaining gate

No Stripe API was called. No Meter, Price, meter event, invoice, Checkout Session or charge was created. The production dependency injection graph uses only `DisabledBillingMeterEventDispatcher`.

`P6-A06C3B0C4B` remains blocked until an approved Sophia sandbox Meter, metered Price mapping and published active-minute plan exist. Live Checkout remains disabled and requires the independent P6-A06C4 authority decision.
