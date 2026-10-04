# P6-A06C4 — live charge activation gate

Date: 2026-10-04 (Australia/Brisbane)

Status: blocked; live Checkout remains disabled.

## Owner-attestation follow-up

On 2026-10-04 the owner attested that the business is not GST-registered and
that its reasonable current and current-plus-next-11-month projected GST
turnover from all business activities is below AUD 75,000. Migration `056`
stores the structured claims, the attesting identity and a digest of the dated
statement as append-only evidence; it does not store the raw statement. The
attestation must be reviewed by 2026-11-03, or earlier if the facts change.

The screenshot-confirmed live Stripe account identifier was checked against the
authority store. There was exactly one coherent active seller policy, the live
provider key/account key had no collision, and the supplied live account was
not confused with the existing sandbox account. The immutable live
`stripe-sophia` / `legacy-primary` binding was then created in the same guarded
transaction as the attestation. Live Checkout Session, subscription and invoice
counts stayed at zero. No Stripe request was made and no collection switch was
changed.

The subsequent compiled activation audit passed `stored_tax_policy`,
`current_tax_attestation`, `recent_mfa`, `catalog_and_webhook` and
`checkout_disabled`. Its decision remains `keep_checkout_disabled`. Remaining
gates are:

- verify live overage collection immediately before activation while its switch
  remains off, then authorise it only for genuine obligations;
- verify live Founding milestone collection while its switch remains off, then
  authorise it only after production-deployment acceptance;
- replace the standard live Stripe key with a least-privilege restricted key,
  or document the minimum required permissions, and review an access policy for
  the deployment egress model; and
- complete genuine-customer tenant, plan, signed-terms, billing-contact and
  authorised-representative checks.

Runtime revision `3d560c2fb7b7` deployed successfully. The full Runtime suite
passed 135 suites / 501 tests, plus typecheck and production build.

## Decision

The first live payment will come from a genuine customer. No synthetic live
charge is needed. Stripe's testing guidance says test API keys and test payment
details must be used for integration testing and prohibits testing in live mode
with real payment-method details.

The no-charge activation audit found that the current system must not be enabled
merely by changing `SOPHIA_BILLING_LIVE_CHECKOUT_ENABLED`:

- recurring base and Founding commencement Checkout are implemented;
- live overage adjustment, missed-window recovery, Meter evidence and Founding
  production-deployment invoicing are implemented behind independent default-off
  collection switches and covered by environment-aware mocked regression tests,
  but have not been invoked against live Stripe;
- `billing.manage` correctly requires recent MFA. Business Manager TOTP
  enrollment is deployed and the genuine operator proof passed. A durable
  no-charge proof endpoint and evidence-aware activation audit are deployed;
- the live seller/provider account binding is absent from the authority store,
  even though the immutable seller policy and live Stripe resources exist;
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
- Live overage collection and live Founding milestone invoicing use independent
  default-off switches. Their provider writes validate the exact live mode,
  account, immutable plan/Price mapping and environment-specific idempotency
  identity. Turning a collection switch off does not prevent read-only exact
  reconciliation of an already submitted obligation.
- `npm run billing:audit-live-activation` is a compiled, read-only production
  command. It reads the effective seller policy and reports every gate; it makes
  no Stripe request and creates no Customer, Checkout Session, invoice or charge.
- The audit does not print a legal name, ABN value, API key or webhook secret.
- The audit uses the canonical `stripe-sophia` provider key and accepts only a
  successful `billing.manage` proof recorded within the prior twelve hours.
  Migration `055` exposes only the latest qualifying timestamp through a
  security-definer function, preserving tenant isolation on Admin audit rows.
- Live invoice-adjustment and commercial-milestone adapters are now wired for
  both Stripe environments. Their independent live switches still default off
  and remain the final submission authority.
- Business Manager now implements password-confirmed TOTP enrollment,
  code-confirmed activation, encrypted-at-rest secrets, monotonic anti-replay,
  bounded lockout and signed server-time step-up evidence. Sophia rejects
  future timestamps and retains its existing twelve-hour freshness limit.

## Required before the first genuine Checkout

1. Identify the genuine tenant, approved plan, signed commercial terms, billing
   contact and authorised customer representative.
2. Obtain current seller/accountant confirmation of GST registration and price
   display obligations; publish a new immutable policy/version if facts changed.
3. Record a fresh MFA-authenticated `billing.manage` proof within twelve hours
   of the eventual activation decision.
4. Publish the exact immutable live seller/provider-account binding for the
   canonical `stripe-sophia` account after verifying its external account
   identity; do not infer or fabricate that identifier.
5. Run the final production-readiness audit for the environment-safe live
   overage path; keep its switch off until the genuine tenant is approved.
6. Run the final production-readiness audit for the live Founding milestone
   path, if the first customer's plan is Founding; keep its switch off until the
   milestone is actually accepted by an authorised recent-MFA administrator.
7. Replace the standard Stripe key with a verified least-privilege restricted
   key where feasible, or document required permissions; apply IP restrictions
   if Render provides stable egress suitable for allowlisting.
8. Re-run `billing:verify-live` and `billing:audit-live-activation`, then obtain
   a fresh explicit authority decision before changing the activation flag.

The authenticated MFA proof contacted no Stripe API and created no Customer,
subscription, invoice, Checkout Session or charge. Checkout, live overage and
live milestone collection remained disabled.
