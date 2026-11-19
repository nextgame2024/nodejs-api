# Sophia Ai discovery and follow-up

The deployment-owned `sophia_ai` WhatsApp profile may opt into `qualificationEnabled: true` and `followUpEnabled: true`. Other company profiles remain unchanged. Apply migration 135 before activation. No real-number enrollment or template approval is implied by these features.

## Conversation and assessment

The reasoner receives up to 20 public conversation messages, bounded to 16,000 characters, plus current approved, granted knowledge. Internal notes and drafts are excluded. Discovery profiles may retrieve approved sources for short/no-keyword responses; tenant, release, source-status and grant checks remain enforced. Company claims still require valid citations and are rechecked before dispatch.

Sophia answers the immediate question and asks at most one relevant strategic question, remembering earlier answers. It may extract verbatim customer statements for business context, need, outcome, tools/process, workload, timeframe, decision process and follow-up preference. The worker rejects invented quotes, unknown fields, assistant evidence and foreign event IDs. Valid automatic answers update an internal assessment; manual drafts do not. Staff retain control of lead stage.

Discovery readiness is deterministic: need 30, outcome 25, business context 15, current process 10, timing 10, decision process 10. High >=70, medium >=40, otherwise early. This measures information available for a discovery meeting, not purchase likelihood, personal worth or service eligibility. Missing facts remain unknown and service fit requires advisor review. The inbox displays quotes, reasons, unknowns and next step.

## Bookings

Use the assigned advisor's published calendar, the existing availability/conflict boundary and exact customer confirmation. The model never chooses an appointment ID or creates a booking. Cancellation/rescheduling retain the same confirmation controls. `WHATSAPP_BOOKING_ENABLED=true` must be set on the messaging worker and API.

Owner-approved Sophia Ai hours: Monday–Friday 09:00–18:00, Saturday 09:00–12:00, Australia/Brisbane, 30-minute slots. Operational defaults: 60-minute lead time, 30-day booking horizon, no closed dates initially. Manage exceptions in the advisor calendar.

## Follow-up

Each new assessment creates a staff task (high priority: one day; otherwise three). Future facts preserve the task's due date/disposition. Authorized staff can complete, dismiss or schedule it for tomorrow/in a week, using revision checks and an audit event. Assigned-advisor/manager visibility and forced tenant RLS apply.

For automatic follow-up, Sophia explains the exact `FOLLOW UP` command. That customer command requests **one reminder in about two hours**, subject to eligibility. General agreement is not consent. A subsequent customer message or Business App reply cancels the pending reminder. STOP/opt-out, staff takeover, closed leads, completed/dismissed staff follow-up, a future confirmed appointment, changed/retired reply configuration or an expired 24-hour window prevent delivery. Staff closure cancels queued reminders. The same outbox handles sending, bounded retries and ambiguous-delivery reconciliation; a unique request prevents duplicate sends.

No automatic message is sent outside the 24-hour window. Approved-template follow-ups are not implemented here. These limits follow the [WhatsApp Business Messaging Policy](https://business.whatsapp.com/policy), checked 2026-11-19. Staff tasks remain available for reviewing the next permitted contact.

## Demo

1. Send a fresh business enquiry to the connected test number; use Resume Sophia if a staff member owns the thread.
2. Ask about Sophia's services, then explain a problem, desired outcome, tools and timeframe.
3. Show the assessment and its customer evidence in Leads & Conversations.
4. Request a date, select a returned slot and send the exact confirmation code; show the booked appointment. No appointment exists before confirmation.
5. Request `FOLLOW UP` to demonstrate consent/scheduling. Show the pending reminder; a new message cancels it. Do not accelerate production timers for a video.
6. Demonstrate staff takeover and follow-up completion.

Real-number Coexistence activation and Meta App Review remain separate from this flow.
