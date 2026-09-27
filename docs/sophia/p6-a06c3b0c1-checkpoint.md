# P6-A06C3B0C1 checkpoint — provider-account rollout complete

Date: 2026-09-27 (Australia/Brisbane)

## Outcome

The billing provider-account boundary completed its expand/deploy/contract rollout.

- Backend commit `18d2d51` and frontend commit `9aedc33` were pushed.
- Public Runtime health reported revision `18d2d51419df` before the contract step.
- Migration 040 removed the five temporary `legacy-primary` database defaults and the three-argument unscoped customer resolver.
- The deployed Runtime remained healthy on revision `18d2d51419df` after the contract migration.
- A post-contract rollback-only lifecycle proof passed through `SET ROLE sophia_runtime_app`; all synthetic rows were rolled back.

All new writes now provide the account key explicitly. Customer routing, Checkout reservation, signed-webhook evidence, subscription/invoice observations, Stripe metadata and provider idempotency identities are scoped by provider, environment and account.

## Configuration

The deployed code intentionally defaults the existing account to `legacy-primary`, matching all migrated evidence. `SOPHIA_BILLING_PROVIDER_ACCOUNT_KEY=legacy-primary` should still be set explicitly in Render as operational hardening. It is not a secret. Do not choose a new value for the same Stripe account without an explicit backfill/account-migration procedure.

The seller-provider registry row remains unseeded until the exact seller legal identity and Stripe external account ID are approved. This does not block canonical active-second capture, but it does block final production resource publication.

## Safety

No live Stripe API mutation, Product, Price, meter, Customer, subscription, invoice, Checkout or charge occurred. Live Checkout remains disabled.

## Next ready slice

`P6-A06C3B0C2`: identify the authoritative billable session lifecycle, persist canonical measured active-second evidence and prove reconnect/retry paths cannot double count.
