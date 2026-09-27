# P6-A06C3A checkpoint — dormant live-resource verification and safe Customer bootstrap

Date: 2026-09-27 (Australia/Brisbane)

## Outcome

- The Runtime now has a read-only verifier for mapped live recurring Prices,
  the live Customer Portal configuration, and the exact enabled live webhook
  destination/API version/event set.
- The verifier compares every mapped Price to the server-owned commercial plan
  currency, amount and interval, and rejects plans with usage dimensions, tax
  collection, missing configuration or non-published state.
- A recent-MFA operator with `billing.manage` may bind an already-existing live
  Stripe Customer while live Checkout is disabled. Before persistence, Stripe
  is read-only verified for live mode and exact `sophiaNamespace`,
  `sophiaEnvironment` and `sophiaTenantId` metadata. Cross-tenant or replacement
  bindings fail closed.
- That bootstrap action cannot create a Stripe Customer, Checkout, subscription,
  invoice or charge and cannot mutate a Sophia entitlement or plan assignment.
  The Admin UI labels this boundary and audits the binding without recording the
  provider Customer ID in audit metadata.

## Evidence correction

A locally generated Stripe signature verifies only that the configured secret
can validate a payload locally. It does not prove that the deployed Stripe
destination owns that secret. C3 therefore also requires a real signed live
`customer.updated` event, routed after the Customer binding and persisted by the
deployed Runtime within the preceding 24 hours. This event is delivery evidence
only; it does not mutate billing observations or entitlements.

## Verification

- Focused Runtime billing suites passed: 4 suites, 19 tests. The full Runtime
  suite passed: 100 suites, 351 tests. Production typecheck, build and generated
  contract drift check also passed.
- Frontend production TypeScript compilation, all 82 Sophia Runtime/Admin
  browser tests and the production build passed after the live Customer binding
  control was added. Existing bundle/font/CommonJS/PrimeIcons warnings remain.
- The backend boundary scan passed for 217 new-product files and all 8 protected
  real-estate suites/38 tests passed.
- After push, the public Runtime health endpoint returned HTTP 200 with deployed
  revision `d098d70c9944`.
- No live Stripe API call, Checkout, charge, subscription change, Render secret
  change or production plan assignment was performed in this slice.

## Remaining gates

- P6-A06C3B requires approved live Price/portal/webhook resources and injected
  live secrets. The destination must include the thirteen declared events.
- P6-A06C3C requires an approved verification tenant and live Customer, recent
  MFA, one real signed `customer.updated` delivery, and bounded read-only
  reconciliation. Live Checkout stays disabled.
- Production price amount and tax treatment must be explicitly approved; the
  AUD 1 sandbox amount is not production commercial approval.
- P6-A06C4 remains the separate explicit decision on real charge creation.
