# P6-A05A checkpoint — Usage and commercial read model

Status: `complete_with_limits`
Date: 2026-09-26 (Australia/Brisbane)
Plan: 2.1.36 / `AMEND-2026-09-26-P6-A05A`

## Delivered

- Added the protected ADM-16 Angular Usage / Billing workspace. `usage.read` exposes measured/estimated provider evidence, dimensions, source coverage and provider-cost estimates. `billing.read` separately exposes commercial assignment, preview, subscription-reference and invoice-reference state.
- Reused the deduplicated provider-usage ledger as measurement evidence without relabelling provider estimates as customer charges, revenue or savings.
- Added versioned platform commercial definitions, tenant assignments and opaque external subscription/invoice references in migration 028. Tenant records use forced RLS; `sophia_runtime_app` receives `SELECT` only across the commercial model.
- Added immutable published-plan controls and deliberately exposed no tenant API for publishing rate cards or assigning entitlements. Migration 029 corrects the lifecycle contract so only a content-preserving `published → retired` transition is possible; retired records remain immutable.
- Added a provider-neutral `BillingProvider` contract with checkout, portal, signed-webhook and reconciliation boundaries. The only registration is fail-closed `DisabledBillingProvider`; no charge, invoice, subscription, portal or checkout operation can execute.
- Added a deterministic, no-side-effect commercial preview. Decimal usage is accumulated exactly, approved `ceil` overage rounding is applied once at the priced line, explicit tax is calculated in integer minor units, and monthly/yearly windows use documented calendar-UTC boundaries bounded by assignment dates.
- Kept existing Business Manager Toolkit, video-render and business invoice payment objects outside the Sophia subscription namespace.

## Plan correction

Repository inspection found no reusable Sophia subscription authority and no authenticated platform billing operator. P6-A05 is therefore split: this completed P6-A05A read model precedes P6-A05B downward-only tenant guardrails, estimate-only budget alerts and shared v1/v2 admission enforcement. Concrete provider sandbox lifecycle remains P6-A06. Plan 2.1.36 also records the lifecycle-only retirement correction found during final consistency review.

## Database evidence

- Applied additive migrations `028_commercial_read_model.sql` and `029_commercial_plan_retirement.sql` to the configured Neon database using its owner migration connection.
- A rollback-only synthetic probe switched to `sophia_runtime_app` and proved: configured assignment visibility; exact `10.5` usage preview with a `2` minor-unit overage and `113` total; disabled provider/no charge execution; subscription/invoice reference visibility; denial of Runtime assignment mutation; no non-SELECT Runtime grants; content-preserving retirement; published-price/content immutability; and forced RLS on all three tenant tables.
- Every synthetic customer, plan, assignment, usage event and billing reference was rolled back.

## Verification

- Runtime: portability typecheck, production typecheck, build, generated-contract drift and all `86` suites / `306` tests passed under Node `22.23.2`.
- Frontend: TypeScript compilation, production Angular build and all `80` Sophia Runtime/Admin browser tests passed under Node `20.19.1`. Existing bundle/font/CommonJS/missing PrimeIcons warnings remain non-blocking release concerns.
- Boundaries: `202` new-product source files passed the quarantine scan; all `8` protected real-estate suites / `38` tests passed.

## Explicit limits and next slice

- No approved production rate card, plan assignment, tax position, billing provider or provider sandbox lifecycle was invented or activated; the new production tables remain empty unless separately provisioned.
- Tenant administrators cannot publish platform rates, raise entitlements or self-assign a plan.
- Budgets and admission enforcement remain unavailable until P6-A05B. That slice may only let a tenant lower platform hard caps and configure estimate-only alerts; it must enforce the same authoritative limits in both v1 and v2 session admission.
- Live checkout, portal, signed provider callbacks, subscription lifecycle, invoice reconciliation and charge execution remain P6-A06 and require explicit sandbox/provider authorization.
