# P6-A06C3B preflight — production commercial definition required

Date: 2026-09-27 (Australia/Brisbane)

## Authoritative finding

A read-only Neon query found one commercial plan version:

- ID: `0230244c-c439-4590-a365-2e1c29d546d7`
- key/name: `sophia-sandbox-monthly` / `Sophia Sandbox Monthly`
- published and configured, AUD 1.00 monthly
- tax marked `not_applicable`, zero usage-billing dimensions
- one active tenant assignment

This record is valid evidence for the completed sandbox lifecycle. Its identity
and price are not production commercial approval. It must remain unchanged and
must not be mapped to a live Stripe Price merely because its technical shape is
compatible.

## Correction

Plan version 2.1.44 adds P6-A06C3B0 before live-resource creation. An authorised
commercial decision must provide a new immutable production plan key, display
name, amount, currency, monthly/annual interval, tax treatment and entitlements.
The initial adapter still supports only fixed recurring pricing, no usage lines,
and `tax_mode=not_applicable`.

The live-resource verifier now rejects any mapped commercial plan whose key or
display name is explicitly labelled `sandbox` or `test`, before making a Stripe
request.

## No external effects

- No commercial plan, assignment or entitlement was created or changed.
- No Stripe live API was called and no Product, Price, Customer, subscription,
  invoice, Checkout or charge was created.
- No Render environment variable changed.
- Live Checkout remains disabled.

## Verification

- The focused live-readiness suite passed 4 tests.
- The full Runtime suite passed 100 suites/352 tests; production typecheck,
  build and generated-contract drift check passed.
- The boundary scan passed for 217 new-product files and all 8 protected
  real-estate suites/38 tests passed.
- The public Runtime health endpoint returned HTTP 200 on deployed revision
  `0bf88ee4281a` after the safety correction was pushed.

## Next input

P6-A06C3B0 needs explicit approval of the production plan definition. Only then
can the immutable database plan and matching live Stripe resources be created
and verified under P6-A06C3B1.
