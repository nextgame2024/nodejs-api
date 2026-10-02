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

Before that boundary, a cancellation request may be recorded but cannot end service or recurring billing earlier than the commitment end. After the boundary, the subscription continues month-to-month and may cancel at the end of the current billing period. The customer portal must use plan-aware cancellation controls; the current single global portal configuration is insufficient.

## Required implementation and evidence

- Add immutable commercial charge components and minimum-term facts without changing existing published plans.
- Publish one Founding plan version with copied Voice entitlements, 1,000 included minutes and the approved prices.
- Extend Checkout validation/mappings for the recurring AUD 190 Price, commencement AUD 950 one-time Price and AUD 0.10 overage Price.
- Add authorised production-acceptance evidence plus a durable, idempotent milestone invoice outbox and exact invoice-line reconciliation.
- Add plan-aware portal/cancellation behavior for pre-commitment and post-commitment states.
- Sandbox-prove initial AUD 1,140 invoicing, duplicate Checkout/webhook handling, one later AUD 950 milestone invoice, twelve monthly boundaries, overage isolation and cancellation timing.
- Keep all live Founding Prices, invoices, Checkout and charges disabled until the sandbox proof is complete and separate live authority is granted.
