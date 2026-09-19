# Phase 4 — Consultation booking and confirmation

Implemented 19 September 2026. Backend, runtime and frontend changes are local;
services have not been deployed. Database schema and the explicitly labelled demo
calendar have been applied for company `81c2f065-aceb-4043-add5-b11271d21fb3`.

## Customer flow

Ask to talk with a student adviser → list consultation times → choose a time →
provide name/email → review editable details → explicitly confirm → book and queue
confirmation. The summary and official links are included only with consent.
Correcting an existing booking email requires a separate review and confirmation.
The UI distinguishes booking confirmation from email status. `sent` means provider
acceptance, not verified inbox delivery; `logged` means no email was delivered.

New tables are `bm_student_advisers`, `bm_student_consultation_slots`,
`bm_student_consultation_bookings`, and `bm_student_consultation_deliveries`.
Company-scoped foreign keys, slot row locks, capacity checks and idempotency protect
booking writes. Booking and delivery creation share one transaction. Student
bookings never create property reports or consume inspection slots.

The demo calendar replenishes weekdays at 10:00 and 14:00 Brisbane time for the
next fourteen days. Only active calendars explicitly marked `is_demo` replenish.
Booked, cancelled and closed slots are preserved. Real calendars need actual
agency availability and meeting details; they are never automatically replenished.
The slots endpoint returns at most twelve available times. After seeding it returned
twelve, starting 21 September 2026 at 10:00 Brisbane time. Demo labels appear in
availability, review, booking and email. No real adviser meeting is represented.

## Email operations

The API starts an independent consultation email worker on startup. The optional
`cron/weeklyGenerator.js` worker also processes the queue; an independent PostgreSQL
transaction-scoped advisory lock prevents overlapping cycles across those processes
(the Phase 5 correction pins the connection through pooled databases). It does not depend
on `cron/aiToolkitEmailCron.js` or that cron's daily schedule.

The worker polls every fifteen seconds, claims a delivery with a five-minute lease,
and retries failures up to three attempts. Expired leases recover on the next
cycle. Corrected recipients cannot be applied while a valid sending lease is held.
Provider timeouts are shorter than the lease. As with most external email delivery,
a crash after provider acceptance but before recording success can cause a duplicate
on retry; exactly-once provider delivery is not guaranteed.

Uses existing `EMAIL_PROVIDER` (`ses`, `smtp`, or `log`) and existing SES/SMTP
configuration. It sends appointment information only, with no property attachment.
No real emails were sent during implementation or automated verification.

## Verification

- Backend consultation unit tests: input validation, consent, HTML escaping,
  demo labels, provider result tracking, retries and worker lock contention.
- PostgreSQL integration tests use their own temporary schema and remove it after
  execution: repeatable schema/demo setup, company isolation, stale timestamps,
  simultaneous capacity-one requests, duplicate retry, atomic email creation,
  queue claiming, recipient correction and log-only status.
- Runtime typecheck and 17 focused tests passed, including existing property tools,
  student tools, matching reviews, confirmation and session isolation.
- Nine frontend browser tests passed, including on-screen email edits, consent
  changes, confirmation turns and student/property panel isolation.
- Existing backend student/property/startup regression subset: 16 tests passed.
- Frontend production build passed. Existing bundle/font budgets, HeyGen CommonJS
  and missing PrimeIcons stylesheet warnings remain.

## Phase 5 release check

Deploy backend, then runtime, then frontend. Verify the worker startup log and use
an explicitly consenting demo recipient for one end-to-end booking and inbox check.
Exercise corrected-email resend and switch between student, purchase and rental
flows in a live session. No deployment or inbox delivery is claimed by Phase 4.
Agency identity, actual adviser calendar and publication of reviewed FAQ drafts
still require agency details and content sign-off before a real customer rollout.
