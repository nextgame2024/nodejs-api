# P3-05 checkpoint — report and delivery workflow hardening

P3-05 is complete with a verified-delivery integration limit. The existing Business Manager queues remain authoritative; no second Runtime worker or queue was introduced.

## Delivered

- Booking completion remains independent from asynchronous report generation and confirmation delivery.
- Report and email claims now receive a unique claim token and increasing generation. Renew, complete and fail operations require the current token, worker and an unexpired lease.
- The email worker now renews its lease while preparing and submitting a delivery.
- An expired email-sending lease becomes `outcome_unknown`, because the provider may have accepted the message before the worker crashed. It is not automatically requeued.
- Any error after provider submission begins is also `outcome_unknown`; preparation failures proven to occur before submission retain bounded retry behavior.
- Log mode records `previewed`/`fallback_previewed`, explicitly meaning no email was sent.
- SMTP/SES API acceptance records `provider_accepted`/`fallback_provider_accepted`, which maps to shared `processing`, not delivery success.
- `delivered`/`fallback_delivered` are reserved for future authoritative provider delivery evidence and are the only successful delivery states.
- Shared connector status output preserves detailed report and delivery milestones for accurate tool data and spoken summaries.
- The unsafe globally scoped Town Planner cache lookup was removed. Business Manager's existing report cache remains keyed by company, property/source version, report version and canonical inputs.
- The configured failure fallback is preserved: after initial report attempts are exhausted, a confirmation may be queued without the report while report recovery continues daily.

## Database evidence

The additive Business Manager startup schema hardening was applied to the configured Neon database. Read-only verification confirmed claim token/generation columns and provider/verified-delivery milestones. Two existing legacy `sent` rows were relabelled `provider_accepted`; no recipient-delivery evidence was fabricated.

The opt-in PostgreSQL regression suite passed: 4 suites, 11 tests passed and 1 explicitly gated live-provider test remained skipped.

## Verification

- Sophia Runtime typecheck/build: passed.
- Sophia Runtime: 48 suites, 193 tests passed.
- Protected real-estate workflow: 8 suites, 38 tests passed.
- Backend release suite: 17 suites, 72 tests passed; 12 SQL-gated tests skipped in the ordinary offline run.

## Remaining limit

No authenticated SES/SMTP delivery webhook or receipt integration exists in the repository. Provider acceptance therefore remains `processing`; the system does not claim verified recipient delivery. No live email or report generation was invoked by Codex.
