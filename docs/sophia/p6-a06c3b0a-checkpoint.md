# P6-A06C3B0A — seller, GST and active-minute billing boundary

Date: 2026-09-27 (Australia/Brisbane)

## Approved commercial facts

- Current seller legal form: Australian sole trader operating under an ABN.
- GST registration is not assumed. The initial seller policy is `gst_registered=false`.
- Current customer scope is business-only. This is a versioned policy value, not a hard-coded product invariant.
- All three plans bill monthly in AUD and include 2,000 active minutes:

| Plan | Base price | Excess active minute |
| --- | ---: | ---: |
| Sophia Voice | AUD 750.00 | AUD 0.10 |
| Sophia Live | AUD 1,750.00 | AUD 0.50 |
| Sophia Premium | AUD 2,750.00 | AUD 0.75 |

While the effective seller policy is not GST registered, customer-facing prices, previews, Checkout and invoices must not calculate, collect or display GST or `+ GST`.

## Source check

The Australian Taxation Office says GST registration generally becomes compulsory at the GST turnover threshold and registered businesses collect GST on taxable sales. Registration status is therefore explicit seller authority, not something inferred from having an ABN or selling software. The ACCC permits GST-exclusive prices when displayed only to other businesses, but consumer displays require the total price. The implementation keeps registration and customer scope configurable so a later policy can choose the legally appropriate tax and display behaviour.

- ATO: <https://www.ato.gov.au/businesses-and-organisations/gst-excise-and-indirect-taxes/gst/registering-for-gst>
- ACCC: <https://www.accc.gov.au/business/pricing/price-displays>

This checkpoint records implementation boundaries, not legal or tax advice. Commercial launch still requires the operator/accountant to confirm actual registration and invoice obligations.

## Implemented foundation

- Migration 038 adds a stable seller identity, immutable legal-entity versions and immutable commercial-policy versions.
- Legal form can move from `sole_trader` to `company` through a new effective version without altering plan, assignment, subscription or usage records.
- Policy versions carry `business_only`, `consumer_only` or `mixed` customer scope.
- A non-GST policy is database-constrained to tax mode `none`, no tax rate/label and display mode `no_tax`.
- GST-registered policies can later use a reviewed fixed rate or provider automatic tax configuration.
- Plan tax category is separated from seller registration. The old plan-local tax fields remain a legacy compatibility field while seller-linked production plans resolve tax from effective seller policy.
- Subscription evidence can identify the stable seller; invoice evidence can pin the exact seller legal and commercial-policy versions used when issued.
- Runtime remains read-only for seller, policy and plan authority.

## Exact metering rule

Runtime usage remains precise in the `active-seconds` dimension. For each billing period:

```text
totalActiveSeconds = sum(all billable active-seconds observations)
includedSeconds = 120000
overageSeconds = max(0, totalActiveSeconds - includedSeconds)
billableOverageMinutes = ceil(overageSeconds / 60)
overageAmountMinor = billableOverageMinutes * planOverageRateMinor
```

The deterministic preview now exposes both precise overage seconds and billable whole-minute units. It no longer rounds the currency result, which could materially undercharge a partial excess minute.

## Still required before plan publication

- Exact sole-trader legal name and ABN for the first legal-entity version. Do not put these values in source control; configure them through an authorised database/administrative operation.
- Final machine entitlement values not established by the marketing card, including any per-plan concurrent-session or tool-rate ceilings.
- A provider-account identity boundary so a later move to a new Stripe account cannot make opaque Customer/Subscription/Invoice identifiers ambiguous.
- Stripe base plus metered-overage design and sandbox lifecycle evidence. The current adapter deliberately rejects usage-priced plans, so no live Products or Prices should be created from the previous single-Price mapping contract.
- Live Checkout remains disabled. No live Stripe request or charge is authorised by this checkpoint.

