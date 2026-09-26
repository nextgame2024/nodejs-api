# P6-A06C1/C2 checkpoint — least-privilege login and dormant Stripe live mode

Date: 2026-09-27 (Australia/Brisbane)

## Outcome

- The deployed Runtime now authenticates to Neon as the genuine non-owner
  `sophia_runtime_login` and assumes the existing `NOLOGIN`
  `sophia_runtime_app` capability role per pooled connection.
- The common Stripe adapter supports explicitly selected sandbox or live mode.
  Secret-key mode, Price `livemode`, signed-event `livemode`, metadata,
  idempotency identities, customer bindings, Checkout reservations,
  subscription observations, invoice observations and webhook evidence are
  environment-separated.
- Live Checkout has a separate
  `SOPHIA_BILLING_LIVE_CHECKOUT_ENABLED` activation flag. It defaults to
  `false`, is rejected outside `stripe_live`, and blocks before database or
  Stripe I/O when disabled. Configuring live resources therefore does not
  grant authority to create real charges.
- The Admin workspace renders the active environment, never enables portal or
  reconciliation from a customer binding in the other environment, and warns
  explicitly when live Checkout is disabled or enabled.

## Database rollout

- Migration `036_billing_provider_environment.sql` backfilled the existing
  subscription and invoice observations as `sandbox`, added immutable
  environment identity, and made provider object references globally unique
  within `(provider_key, provider_environment)` so one provider object cannot
  be attached to two tenants.
- Migration 036 deliberately retained a temporary sandbox default while the
  prior Runtime version could still receive webhooks.
- After deployed health reported backend revision `93ca56047235`, migration
  `037_billing_provider_environment_contract.sql` removed both defaults.
  Both columns are now non-null and require every writer to state its
  environment explicitly.
- Preflight found one subscription, one invoice and zero conflicting provider
  references. Both existing observations remain classified as sandbox.

## Verification

- Runtime typecheck, build and v2 contract check passed.
- Runtime full suite passed: 98 suites, 342 tests.
- The health revision follow-up passed its focused test and Runtime typecheck.
- Frontend typecheck and production build passed; the existing bundle-budget,
  CommonJS and missing PrimeIcons warnings remain unchanged.
- Frontend full Chrome suite passed: 81 tests.
- Neon records migrations 036 and 037; both new environment columns are
  `NOT NULL` with no default.
- Deployed `/api/runtime/healthz` returned HTTP 200 with revision
  `93ca56047235` after the environment-aware release.

## Remaining gates

P6-A06C3 still requires secret-manager-injected live Stripe credentials, live
recurring Price mappings, a live Customer Portal configuration, the live signed
webhook destination and read-only live reconciliation evidence. Live Checkout
must remain disabled during that work. P6-A06C4 remains the separate explicit
decision on whether real charge creation stays disabled or is activated.
