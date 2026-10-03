# P6-A06C4 — live charge activation gate

Date: 2026-10-03 (Australia/Brisbane)

Status: blocked; live Checkout remains disabled.

## Decision

The first live payment will come from a genuine customer. No synthetic live
charge is needed. Stripe's testing guidance says test API keys and test payment
details must be used for integration testing and prohibits testing in live mode
with real payment-method details.

The no-charge activation audit found that the current system must not be enabled
merely by changing `SOPHIA_BILLING_LIVE_CHECKOUT_ENABLED`:

- recurring base and Founding commencement Checkout are implemented, but the
  authoritative one-time overage adjustment remains sandbox-only;
- Founding production-deployment milestone invoicing remains sandbox-only;
- `billing.manage` correctly requires recent MFA, while the current Business
  Manager `/user` response supplies no verified `mfaVerifiedAt` evidence;
- the stored seller policy is intentionally business-only and non-GST, but the
  seller/accountant must reconfirm actual current and projected GST turnover
  before the first invoice; and
- the deployed standard `sk_live` key requires a least-privilege review.
  Stripe recommends restricted keys where possible and IP restrictions for live
  keys where deployment egress permits them.

The ATO says an Australian business generally must register when current or
projected GST turnover reaches AUD 75,000. The application must therefore never
infer continued non-registration from the historical catalog record.

Sources:

- Stripe testing: <https://docs.stripe.com/testing>
- Stripe API keys: <https://docs.stripe.com/keys>
- ATO GST registration: <https://www.ato.gov.au/businesses-and-organisations/gst-excise-and-indirect-taxes/gst/registering-for-gst>

This checkpoint is an implementation boundary, not tax or legal advice.

## Implemented safety boundary

- Runtime configuration now rejects `stripe_live` with live Checkout enabled
  until the incomplete gates are implemented and verified.
- `npm run billing:audit-live-activation` is a compiled, read-only production
  command. It reads the effective seller policy and reports every gate; it makes
  no Stripe request and creates no Customer, Checkout Session, invoice or charge.
- The audit does not print a legal name, ABN value, API key or webhook secret.

## Required before the first genuine Checkout

1. Identify the genuine tenant, approved plan, signed commercial terms, billing
   contact and authorised customer representative.
2. Obtain current seller/accountant confirmation of GST registration and price
   display obligations; publish a new immutable policy/version if facts changed.
3. Implement a trustworthy Business Manager MFA/step-up flow that supplies a
   recent server-verified timestamp to Sophia Admin.
4. Implement and sandbox/regression-prove environment-safe live overage invoice
   adjustment, including missed-window recovery and exact reconciliation.
5. Implement and prove live Founding milestone dispatch/reconciliation, if the
   first customer's plan is Founding.
6. Replace the standard Stripe key with a verified least-privilege restricted
   key where feasible, or document required permissions; apply IP restrictions
   if Render provides stable egress suitable for allowlisting.
7. Re-run `billing:verify-live` and `billing:audit-live-activation`, then obtain
   a fresh explicit authority decision before changing the activation flag.

No database migration, Stripe request, Customer, subscription, invoice, Checkout
Session or charge was created by this checkpoint.
