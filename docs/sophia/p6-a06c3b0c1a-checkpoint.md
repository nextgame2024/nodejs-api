# P6-A06C3B0C1A checkpoint — billing provider-account expand phase

Date: 2026-09-27 (Australia/Brisbane)

## Outcome

The additive provider-account scope is implemented and migration 039 is applied to Neon. Every opaque Stripe customer, Checkout, webhook, subscription and invoice identity is now keyed by provider, environment and a stable internal provider-account key. The deployed legacy writer remains compatible through the temporary `legacy-primary` defaults and retained three-argument customer resolver.

The Runtime writer is account-aware in local source: configuration validation, Stripe metadata, idempotency keys, customer binding, hosted actions, webhook routing, reconciliation and Admin reads all use the configured account key. Live Customer binding requires exact account metadata. The sandbox adapter accepts missing account metadata only for the legacy account so the completed sandbox lifecycle remains readable during rollout.

The Admin client also requires the active environment and account key to match before enabling portal or reconciliation actions; a historical Customer binding from a retired account is not treated as active.

No live Stripe API request, Product, Price, meter, Customer, subscription, invoice, Checkout or charge was created or changed. Live Checkout remains disabled.

## Plan correction

Stripe documents fixed fee plus overage as separate recurring prices. Stripe Price `transform_quantity` cannot be combined with tiered pricing, while meter events and summaries are asynchronous/eventually consistent. A single metered Price therefore cannot faithfully implement Sophia's required rule of aggregating seconds for the period, subtracting 120,000 included seconds, then rounding the remainder up once.

Plan 2.1.46 splits the remaining work into:

1. provider-account expand/deploy/contract rollout;
2. canonical active-second capture;
3. immutable monthly period finalisation with one aggregate ceiling; and
4. durable idempotent whole-overage-minute submission plus Stripe summary/invoice reconciliation.

Relevant provider documentation:

- https://docs.stripe.com/billing/subscriptions/metered-billing/thresholds
- https://docs.stripe.com/api/prices/create
- https://docs.stripe.com/api/billing/meter-event/create
- https://docs.stripe.com/api/billing/meter-event-summary/list

## Database evidence

- Applied `039_billing_provider_account_scope.sql` with the owner migration connection.
- A rollback-only proof switched to `sophia_runtime_app` and verified issued-intent completion, account-scoped customer routing, replay suppression, stale-invoice protection, immutable references, cross-tenant hiding and forced RLS.
- All synthetic rows were rolled back.
- The local environment does not contain the Render-only `sophia_runtime_login` password, so the proof used the owner connection followed by `SET ROLE sophia_runtime_app`; the earlier genuine-login deployment proof remains separate evidence.

## Rollout state

- C1A expand migration and account-aware writer: complete locally; migration applied.
- C1B deploy writer: ready after commit/push.
- C1C contract migration: intentionally deferred until the deployed revision is observed; it will remove the compatibility defaults and old resolver.
- The stable configured key must continue to identify the same Stripe account. Do not change it casually; an account migration requires an explicit new registry row and preserved historical scope.

## Deferred inputs

The seller-provider registry cannot be seeded yet because the exact seller legal name/ABN and the Stripe external account ID have not been recorded in the approved configuration. Production plan publication remains separately blocked on the exact seller identity and machine entitlement values.
