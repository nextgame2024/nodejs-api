# P6-A06B checkpoint — Stripe sandbox subscription lifecycle

Status: `complete_with_limits`
Date: 2026-09-26 (Australia/Brisbane)
Plan: 2.1.40 / `AMEND-2026-09-26-P6-A06B-EVIDENCE`

## Provider evidence

- Deployed backend commit `f33b943` after correcting the Stripe adapter's Nest factory registration. The public callback changed from an undeployed `404` to a verified `401` for an unsigned body, proving the signed webhook boundary is active.
- Verified the enabled Stripe destination is test-mode only, uses API version `2025-08-27.basil`, points to `https://sophia-runtime-api.onrender.com/api/billing/v1/webhooks/stripe`, and subscribes to the twelve declared Checkout, subscription and invoice events.
- Created a Sophia-specific recurring sandbox Product/Price for AUD 1.00 monthly and mapped it to immutable commercial plan version `0230244c-c439-4590-a365-2e1c29d546d7` for the demo tenant.
- Created the Checkout through `BillingLifecycleService`, which first persisted the tenant/plan/request reservation under `sophia_runtime_app`. Stripe returned a hosted `cs_test_` Session and no live charge capability.
- The completed hosted Checkout produced a signed `checkout.session.completed` callback. Sophia matched it to the issued Session, marked the intent completed and bound one sandbox `cus_` customer to the tenant.
- Authoritative reconciliation observed one active monthly subscription and one paid AUD 1.00 invoice, with a hosted invoice URL, and reported `liveEntitlementMutation=false`.
- Created a hosted Customer Portal session on `billing.stripe.com`; audit evidence records allowed `billing.checkout.created`, `billing.reconciled` and `billing.portal.created` operations in the sandbox namespace.

## Runtime correction

The first reconciliation transaction failed safely because the shared trigger installed by migration 032 referenced invoice-only fields while updating the subscription table. No partial observation was committed. Migration `035_billing_reference_trigger_routing.sql` replaces boolean table checks with nested table-specific branches, retains immutable identities and monotonic revisions, and is applied to Neon. Reconciliation passed after the repair.

## Verification and limits

- Focused trigger/lifecycle tests, TypeScript typecheck and production build passed after the correction.
- Existing duplicate, out-of-order, issued-intent, forced-RLS and cross-tenant proofs remain applicable; the live provider run added real hosted and callback evidence.
- Business Manager still does not provide recent MFA evidence. The proof used a bounded synthetic sandbox operator invocation of the same lifecycle service and did not weaken or bypass the deployed Admin guard.
- Sandbox subscription/invoice evidence does not publish entitlements or affect Business Manager production payments.
- Live Stripe mode remains disabled and is independently gated as P6-A06C.
