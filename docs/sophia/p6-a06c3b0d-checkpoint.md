# P6-A06C3B0D Founding plan checkpoint

## Approved commercial definition

Sophia Essential Founding is a separate immutable commercial plan. It does not modify Sophia Voice or reuse a published Voice plan version.

| Component | Approved value |
| --- | ---: |
| Commencement implementation milestone | AUD 950 one time |
| Production-deployment implementation milestone | AUD 950 one time |
| Membership | AUD 190 per month |
| Minimum term | 12 monthly billing periods |
| Included usage | 1,000 active minutes per monthly period |
| Overage | AUD 0.10 per aggregate whole active minute |

The plan copies the existing Sophia Voice machine entitlements explicitly rather than inheriting mutable values. Its usage allowance is `60000` active seconds. Overage calculation aggregates exact active duration for the provider period, subtracts the allowance and applies one ceiling to the remaining duration in 60-second units.

## Payment lifecycle

The commencement milestone is a required one-time Price on the initial subscription Checkout invoice alongside the first AUD 190 monthly membership charge. The expected initial total is therefore AUD 1,140 before any future tax-policy change.

The production-deployment milestone is not placed on the initial invoice and is not inferred from a deployment webhook or subscription event. An authorised operator must record explicit deployment acceptance. That immutable evidence creates at most one digest-bound AUD 950 milestone invoice operation, with provider idempotency and exact finalized invoice-line reconciliation. No generic overage outbox row may be reused for this obligation.

Stripe can place one-time Prices on the initial subscription invoice and can create a later one-off invoice against the saved Customer payment method. Provider acceptance does not guarantee successful collection; invoice payment state and any dunning/suspension policy remain separate evidence.

## Commitment and cancellation

The billing anchor is the successful subscription commencement time. The monthly allowance and AUD 190 renewal follow that anniversary boundary. The minimum contractual term ends after the twelfth monthly billing period; the twelve monthly fees remain owed under the contract even if collection fails.

Before that boundary, the managed customer portal does not expose subscription cancellation. The implementation does not store a future cancellation request or run a local cancellation scheduler. After the boundary, the subscription continues month-to-month and the standard portal permits cancellation at the end of the current billing period.

## Required implementation and evidence

- Add immutable commercial charge components and minimum-term facts without changing existing published plans.
- Publish one Founding plan version with copied Voice entitlements, 1,000 included minutes and the approved prices.
- Extend Checkout validation/mappings for the recurring AUD 190 Price, commencement AUD 950 one-time Price and AUD 0.10 overage Price.
- Add authorised production-acceptance evidence plus a durable, idempotent milestone invoice outbox and exact invoice-line reconciliation.
- Add plan-aware portal/cancellation behavior for pre-commitment and post-commitment states.
- Sandbox-prove initial AUD 1,140 invoicing, duplicate Checkout/webhook handling, one later AUD 950 milestone invoice, twelve monthly boundaries, overage isolation and cancellation timing.
- Keep all live Founding Prices, invoices, Checkout and charges disabled until the sandbox proof is complete and separate live authority is granted.

## D1 implementation evidence

Migration `052_commercial_commitment_and_charge_components.sql` adds bounded immutable `minimum_commitment_months` and one-time plan charge components. Components can be authored only while their plan is draft and become immutable with the published plan. Runtime access is read-only.

Hosted Checkout now reads initial-only components from the active immutable plan, accepts a plan-specific active-second allowance, and validates nested plan/component Stripe Price mappings. Each initial Price must be active, in the correct provider environment, one-time, AUD, tax-exclusive and exactly match the immutable amount. Standard plans with no initial component retain only their recurring Checkout line.

Repository validation passed both Runtime typechecks, build and 121 suites/439 tests. Contract generation and 15 contract tests passed, the boundary scan passed 233 files, and protected real-estate passed 8 suites/38 tests.

Migrations 052, 053 and 054 remain unapplied. D2 provides immutable recent-MFA production-deployment acceptance, a dedicated digest-bound milestone invoice outbox, stable sandbox provider idempotency and exact finalized-line reconciliation. D3 anchors the commitment to the paid initial invoice and twelve contiguous provider periods, then selects distinct validated pre-term and post-term portal configurations. Live milestone submission/reconciliation and live Checkout remain disabled.

## D4 operational preparation

The publisher now supports plan-specific included seconds, minimum terms and immutable charge components. New plans are authored as draft, receive their components and become published in one owner transaction. Legacy catalog manifests remain unchanged when these fields are omitted. Migration 052 also replaces the old `included_active_seconds = 120000` ledger constraint with a non-negative immutable plan snapshot constraint; otherwise the approved 60,000-second Founding allowance could never be finalized.

The approved plan entry is [founding-plan-catalog-entry.json](./founding-plan-catalog-entry.json). Add that exact object to the previously approved commercial catalog input and run `npm run commercial:publish` with the owner connection only after migrations 052–054 have been applied.

`npm run billing:founding-provision` is an explicitly confirmed, test-key-only provisioner. It idempotently creates or validates the sandbox Product, recurring membership Price, commencement Price, deployment Price, one-time overage Price, Meter-evidence Price and cancellation-disabled portal configuration. It prints mapping entries for merging into Render; it never overwrites the existing standard mappings.

After those mappings are deployed, run [founding-sandbox-fixture.sql](./founding-sandbox-fixture.sql) once with the owner connection and use tenant `e9c17e94-35b0-4a2c-a114-932e0c59f9b2`. The compiled `billing:founding-sandbox` stages are `prepare`, `close`, `milestone`, `advance-commitment` and `status`. The harness is resumable and refuses live mode, non-test keys, another plan assignment or missing explicit object-creation confirmation.

No Founding plan record, Stripe Product/Price, invoice or charge has been created by repository preparation. D4 remains incomplete until the owner migrations, publication, sandbox provisioning, Render mapping deployment and full proof outputs are captured.
