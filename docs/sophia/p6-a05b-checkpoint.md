# P6-A05B checkpoint — Usage guardrails and atomic admission

Status: `complete_with_limits`
Date: 2026-09-26 (Australia/Brisbane)
Plan: 2.1.37 / `AMEND-2026-09-26-P6-A05B`

## Delivered

- Added audited, optimistic tenant usage guardrails to ADM-16. An authorised tenant may lower the effective concurrent-session or tool-call-rate ceiling, or remove its override back to the existing platform/commercial ceiling; it cannot raise an entitlement or change a commercial assignment.
- Added calendar-UTC, single-currency provider-cost estimate alerts. They are explicitly not a customer charge, billing balance, invoice, entitlement change or admission decision. Missing and mixed-currency evidence remains visible rather than guessed.
- Centralised v1 and v2 session/tool admission in one Runtime service. Effective concurrent-session and per-minute tool limits are the minimum of configured platform hard caps, an active published or retired commercial entitlement, and an optional tenant guardrail. A known malformed commercial entitlement fails closed.
- Replaced duplicated count-then-act checks with transaction-scoped PostgreSQL advisory locks and minimal short-lived reservations. Concurrent session and tool requests cannot consume the same remaining slot, while a repeated provider event reuses its reservation instead of double-counting.
- Preserved the immutable v2 `maximumToolCalls` as a separate total-per-session ceiling. It is no longer treated as a per-minute limit that resets when the time window rolls over.
- Kept recent MFA enforcement on the server for every guardrail change and recorded each accepted update in the Admin audit ledger. UI visibility remains presentation-only and does not weaken direct API enforcement.

## Plan correction

Repository inspection found that v1 and v2 performed separate count-then-act admission checks, allowing concurrent requests to oversubscribe a final slot. It also found that the v2 session-total tool ceiling was being passed through the rate-limit path. Plan 2.1.37 records the shared atomic admission boundary, separates total and rate limits, and constrains provider-cost thresholds to non-enforcing estimate alerts.

## Database evidence

- Applied additive migration `030_tenant_usage_guardrails.sql` to the configured Neon database using the owner migration connection.
- The migration adds forced-RLS tenant guardrails and minimal tool-admission reservations. Runtime grants are limited to the operations required by the admission and Admin contracts; no tenant delete endpoint exists for guardrails.
- A rollback-only `sophia_runtime_app` probe proved: effective minimum selection; active estimate-alert calculation; audited optimistic updates; serialized concurrent-session denial; provider-event replay deduplication; distinct v2 session-total denial; cross-tenant guardrail invisibility; and forced RLS on both new tenant tables.
- Every synthetic organisation, assignment, session, allocation, usage event, guardrail, reservation and audit row was rolled back.

## Verification

- Runtime: portability typecheck, production typecheck, build, generated-contract drift and all `89` suites / `316` tests passed under Node `22.23.2`.
- Focused admission/guardrail verification: `9` suites / `42` tests passed.
- Frontend: TypeScript compilation, production Angular build and all `80` Sophia Runtime/Admin browser tests passed under Node `20.19.1`. Existing bundle/font/CommonJS/missing PrimeIcons warnings remain non-blocking release concerns.
- Boundaries: `208` new-product source files passed the quarantine scan; all `8` protected real-estate suites / `38` tests passed.

## Explicit limits and next task

- The current Business Manager identity exposes no verified `mfaVerifiedAt`. A Billing Administrator can see the controls when otherwise authorised, but every save remains fail-closed until an approved step-up flow supplies recent MFA; server enforcement was not weakened.
- An estimate alert does not implement budget exhaustion, a customer balance, charge prevention or collection. It remains informational and non-enforcing.
- No approved production rate card, plan assignment, tax position, billing provider or provider sandbox lifecycle was invented or activated.
- Live checkout, portal, signed callbacks, subscription lifecycle, invoice reconciliation and charge execution remain P6-A06 and require explicit sandbox/provider authority. P6-A06 is the next ready task.
