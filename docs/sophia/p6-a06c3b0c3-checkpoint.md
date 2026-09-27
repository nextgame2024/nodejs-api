# P6-A06C3B0C3 checkpoint — immutable provider-period ledger

Date: 2026-09-27 (Australia/Brisbane)

## Outcome

Migrations 042 and 043 are applied to Neon and provide the immutable final billing-quantity boundary plus assignment snapshot hardening.

- Every non-null provider subscription period is captured before the mutable subscription reference advances. The existing sandbox subscription period was backfilled.
- Finalisation uses provider-observed start/end boundaries rather than assuming a calendar-UTC month.
- Connected-activity intervals are intersected with the period at microsecond precision and summed before any allowance or rounding.
- Exactly 120,000 included seconds are subtracted once. Remaining microseconds receive one ceiling to whole 60-second billing units.
- A ledger pins the plan version, assignment revision/effective bounds, seller legal-entity version, seller commercial-policy version, currency, rate snapshot, plan digest and a deterministic ledger digest.
- Finalised ledgers reject update and deletion, use forced tenant RLS, and expose only `SELECT`/`INSERT` to the runtime role.
- Signed webhooks preserve period observations and return promptly. The recent-MFA reconciliation path invokes bounded eligible-period finalisation; replays return existing evidence rather than creating another allowance or quantity.
- The commercial read model now derives `active-seconds` only from canonical connected intervals; provider usage events cannot inject or duplicate that billable dimension. It also returns recent finalised ledgers.

## Fail-closed boundaries

Finalisation waits when an interval overlapping the ended period remains open. It also refuses a period that is not covered end-to-end by exactly one monthly commercial assignment and one seller policy. No proration, split allowance or mid-period tax treatment is invented.

The existing sandbox subscription has an observed current period, but it has not ended and its old fixed sandbox plan is not the approved seller-linked active-minute plan. Therefore no ledger was manufactured from it.

## Plan correction

Plan 2.1.48 replaces the calendar-month ledger assumption with provider-observed periods and records the missing proration decision. It also splits C4: the durable provider-neutral outbox can be implemented now, while actual Stripe sandbox meter submission remains blocked on an approved sandbox Meter/metered Price mapping and published active-minute plan.

## Verification

- Migrations 042 and 043 applied successfully to Neon.
- Both new tables report forced RLS as `true:true`.
- `sophia_runtime_app` can read captured periods but cannot insert them directly; it can read/insert ledgers but cannot update them.
- One existing subscription period was backfilled.
- Focused period-ledger, lifecycle integration and migration suites passed, including boundary intersection, a 60.000001-second overage becoming two whole minutes, open-interval denial, and ambiguous mid-period policy denial.

## Safety

No Stripe meter event, Product, Price, invoice, Checkout Session or charge was created. Live Checkout remains disabled.

## Next ready slice

`P6-A06C3B0C4A`: implement the durable provider-neutral meter-event outbox and retry/lease state machine without invoking Stripe.
