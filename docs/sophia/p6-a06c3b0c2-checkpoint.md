# P6-A06C3B0C2 checkpoint — canonical connected activity

Date: 2026-09-27 (Australia/Brisbane)

## Outcome

Canonical customer-billable activity is now distinct from the operational provider-session lifetime.

- Migration 041 is applied to Neon and creates forced-RLS `session_activity_intervals` with immutable finalised evidence.
- A session records no billable activity while provider resources are merely being created.
- The frontend opens an authenticated, server-timestamped interval only after its browser media transports connect.
- Heartbeats advance one `last_confirmed_at` value with `GREATEST`; retries never increment a duration counter.
- Explicit disconnect or session close finalises the matching open interval before provider cleanup begins.
- Reconciliation expires an abandoned interval at its last authenticated confirmation, excluding disconnect grace and provider-cleanup delays.
- A connection identity is idempotent while open and cannot be reused after finalisation. A real reconnect uses a new identity, while the partial unique index prevents overlapping open intervals for one session.

The interval retains timestamp precision. No session or call is rounded. The next slice will intersect these intervals with the finalised monthly period, aggregate duration, subtract 120,000 included seconds and apply the whole-minute ceiling once.

## Plan correction

Plan 2.1.47 records that `sessions.started_at` through `sessions.ended_at` is not authoritative billable usage because it includes provider bootstrap, disconnect grace and cleanup retries. The canonical source is now authenticated connected-activity intervals. This is deliberately conservative on abrupt loss: activity ends at the last confirmed heartbeat rather than charging through the operational grace window.

## Verification

- Sophia Runtime typecheck passed.
- All 103 backend suites / 366 tests passed.
- Focused provider lifecycle suite passed 7 tests, including connection replay, heartbeat retry and disconnect finalisation.
- Frontend TypeScript checking passed.
- Focused Angular lifecycle suite passed 4 tests in ChromeHeadless.
- Neon records migration `041_session_activity_intervals.sql`; forced RLS reports `true:true`, and `sophia_runtime_app` has only the required `SELECT, INSERT, UPDATE` table privileges.

## Safety

No live Stripe resource, meter event, invoice, Checkout Session or charge was created. Live Checkout remains disabled. Migration 041 is additive and does not reinterpret historical operational session timestamps as customer usage.

## Next ready slice

`P6-A06C3B0C3`: create an immutable finalised monthly billing-period ledger by intersecting canonical activity intervals with the period, aggregating exact duration and applying the included allowance and ceiling once.
