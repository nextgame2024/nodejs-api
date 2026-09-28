# P6-A06C3B0B checkpoint — approved commercial catalog

The versioned seller and commercial catalog is now published in the authorised Neon database. Source control contains only the idempotent, configuration-driven operator command; the seller's legal identity and registration value remain operational data rather than hardcoded application constants.

## Published policy

- Seller legal form: Australian sole trader with an ABN.
- Customer scope: business only.
- GST registration: false.
- Tax calculation: none; price display: no tax.
- A future GST registration or seller migration publishes new effective legal/policy versions. It does not rewrite plans, assignments, subscriptions, usage, or historical billing evidence.

## Published plan versions

| Plan | Monthly base | Included usage | Overage | Concurrent sessions | Aggregate tool calls/minute |
| --- | ---: | ---: | ---: | ---: | ---: |
| Sophia Voice v1 | AUD 750 | 2,000 active minutes | AUD 0.10/minute | 3 | 15 |
| Sophia Live v1 | AUD 1,750 | 2,000 active minutes | AUD 0.50/minute | 3 | 15 |
| Sophia Premium v1 | AUD 2,750 | 2,000 active minutes | AUD 0.75/minute | 3 | 15 |

All rate cards preserve active seconds, subtract 120,000 included seconds once per provider period, and round the aggregate positive remainder up once in 60-second units. No tenant assignment was created or changed.

Premium's future value of 10 concurrent sessions is not published. It can be introduced through a new immutable/configured plan version without changing Runtime code.

## Capacity and safety separation

- Commercial `concurrentSessions` remains independent from provider/platform capacity.
- Runtime session admission takes the minimum of commercial entitlement, optional tenant guardrail, platform cap, and provider-neutral lifecycle-adapter capacity.
- Provider occupancy is globally serialized and counted by lifecycle-adapter key; no vendor limit is stored in a plan.
- Commercial `toolCallsPerMinute` is an aggregate ceiling. Independent read/search, mutation, sensitive-action, and per-tool operational limits can only lower it.
- The included active-minute allowance is independent from concurrency and tool-call admission.

Migration 046 adds the provider-capacity count and tool admission dimensions. The Stripe Meter dispatcher resolves the semantic `active-overage-minutes` binding only through configuration and leaves ambiguous transport outcomes quarantined for reconciliation.

## Remaining C4B boundary

No Stripe Meter event was submitted by this checkpoint. The deployed service still needs the approved sandbox binding:

```bash
SOPHIA_BILLING_STRIPE_METER_BINDINGS={"active-overage-minutes":"sophia_active_overage_minutes"}
```

The sandbox subscription must contain the correct base and metered Price items and produce a closed provider period before a positive final ledger can be dispatched and reconciled. Live Checkout remains disabled.
