# P6-A06A checkpoint — Dormant Stripe sandbox lifecycle

Status: `complete_with_limits`
Date: 2026-09-26 (Australia/Brisbane)
Plan at checkpoint: 2.1.38 / `AMEND-2026-09-26-P6-A06A`
Current plan: 2.1.39 / `AMEND-2026-09-26-P6-A06B`

## Delivered

- Added a concrete Stripe adapter to Sophia Runtime using Stripe's hosted subscription Checkout and hosted customer portal boundaries. The adapter accepts test-mode keys only and rejects every live event.
- Isolated Sophia subscriptions from existing Business Manager Toolkit/video payments. Only `SOPHIA_BILLING_*` configuration is read; the adapter never falls back to legacy `STRIPE_*` credentials, products, metadata or webhooks.
- Made readiness fail closed until a dedicated test secret, webhook signing secret, recurring Price mapping, portal configuration and hosted return URLs are all present.
- Before Checkout, retrieves the mapped Stripe Price and requires an exact test-mode match to the approved plan currency, fixed base amount and month/year interval. The first lifecycle accepts only fixed recurring plans with no usage-overage lines and `not_applicable` tax mode; it cannot silently underbill usage or invent tax handling.
- Added provider idempotency keys for hosted POST operations, exact active-plan checks, bounded hosted Stripe URL validation and `billing.manage` plus recent-MFA enforcement for Checkout, portal and reconciliation.
- Added a forced-RLS Checkout reservation before provider I/O. Only one tenant request may be allocating, outcome-unknown or created; retry reuses the same provider idempotency identity, and a signed completion must match the issued opaque Session before customer binding.
- Enabled raw-body signature verification at `POST /api/billing/v1/webhooks/stripe`. No raw payload, card details, payment method or secret is persisted.
- Added tenant/customer routing, unique event replay protection, monotonic subscription/invoice observations, out-of-order event rejection and authoritative bounded provider reconciliation.
- Added database triggers making provider customer, subscription, invoice and webhook identities immutable. Received webhook evidence may be finalized once; observations must advance their timestamp and revision.
- Extended ADM-16 with explicit sandbox readiness, hosted-action controls, provider references and signed callback evidence. The UI states that sandbox evidence cannot activate live billing or mutate platform plan assignments.

## Plan correction

Repository inspection found a Stripe test credential only in the legacy Business Manager process for unrelated one-time Toolkit/video payments. Sophia had no dedicated recurring Price mapping, webhook secret, portal configuration or authenticated platform commercial operator. Reusing those objects would violate the product namespace and authority boundaries established in P6-A05.

P6-A06 is therefore split. P6-A06A delivers the concrete dormant adapter and lifecycle safety. P6-A06B remains the explicit provisioning and synthetic provider-sandbox end-to-end slice. The fixed-price restriction is deliberate: the current commercial read model can describe usage overages, but no approved Stripe metering/tax design exists, so Checkout fails closed for such plans.

Subsequent operator clarification confirmed that Stripe payments were already exercised with test credentials and that production credentials are available outside the repository. Plan 2.1.39 corrects the earlier wording: the Stripe account credential need not be dedicated to Sophia, but Sophia-specific recurring Products/Prices, metadata, environment-variable namespace, webhook destination/signing secret and portal configuration remain required. The earlier payment test is not recorded as Sophia recurring-subscription lifecycle evidence unless its Checkout subscription, callback, invoice, portal and reconciliation artifacts can be verified. Live activation is now an explicit later slice and is never implied by credential availability.

## Database evidence

- Applied additive migrations `031_billing_sandbox_lifecycle.sql` through `034_billing_checkout_reservations.sql` to the configured Neon database using the owner migration connection.
- The new customer-routing, webhook-evidence and Checkout-intent tables use forced tenant RLS. Runtime receives only the lifecycle grants required for provider observations; it still cannot publish plans or mutate tenant commercial assignments.
- A rollback-only `sophia_runtime_app` proof verified: issued Checkout-intent completion; signed-event service routing; initial customer mapping; duplicate event suppression; customer-to-tenant routing; stale invoice rejection; immutable opaque invoice identity; cross-tenant customer invisibility; and forced RLS.
- Every synthetic tenant, plan, assignment, provider customer, subscription, invoice and webhook event was rolled back.

## Verification

- Runtime: portability typecheck, production typecheck, build, generated-contract drift and all `95` suites / `332` tests passed under Node `22.23.2`.
- Frontend: TypeScript compilation, production Angular build and all `81` Sophia Runtime/Admin browser tests passed under Node `20.19.1`. Existing bundle/font/CommonJS/missing PrimeIcons warnings remain non-blocking release concerns.
- Boundaries: `214` new-product source files passed the quarantine scan; all `8` protected real-estate suites / `38` tests passed.
- Dependency installation reported zero known npm audit vulnerabilities for Sophia Runtime.

## Explicit limits and next slice

- No Stripe API request or provider object was created. The repository's available test key belongs to the existing unrelated payment process and was intentionally not reused.
- No Sophia-specific recurring Price mapping, portal configuration or webhook destination/signing secret is configured in this workspace. Provider sandbox Checkout, portal, callback delivery and reconciliation remain unrun here; an account-scoped test credential may be reused through `SOPHIA_BILLING_*` when approved.
- No production price, tax treatment, usage metering, plan assignment, entitlement mutation, customer billing balance or live charge was invented or activated.
- The current Business Manager identity still supplies no verified MFA timestamp, so hosted actions remain fail-closed until an approved step-up flow exists.
- P6-A06B is next: configure explicitly approved Sophia-specific Stripe sandbox resources, then run synthetic hosted Checkout, subscription, signed callback, invoice, portal and reconciliation evidence. P6-A06C is the separate live-mode configuration and activation gate.

## Provider references used

- Stripe Checkout subscription mode and hosted sessions: <https://docs.stripe.com/api/checkout/sessions/create>
- Stripe hosted customer portal sessions: <https://docs.stripe.com/api/customer_portal/sessions/create>
- Stripe request idempotency: <https://docs.stripe.com/api/idempotent_requests>
- Stripe subscription status semantics: <https://docs.stripe.com/api/subscriptions/object>
