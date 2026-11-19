# Consolidated messaging worker

Update the existing `sophia-messaging-worker`; no additional Render service is needed.
This runs inbound processing, answer generation and outbound dispatch in independent
bounded lanes. The existing reply-only command still works with inbound disabled.

## Build and command

For the backend repository root:

| Render setting | Value |
| --- | --- |
| Root directory | Leave empty |
| Docker build context | `.` |
| Dockerfile path | `./Dockerfile.messaging` |
| Docker command | Leave empty to use the image command |

Remove the old `npm run whatsapp:inbound-worker` command override. Alternatively,
set the override to `npm run whatsapp:messaging-worker`. The image builds and includes
the Sophia Runtime reasoning adapter and its production dependencies.

## Environment

Keep the existing backend `DATABASE_URL` and database SSL/pool settings on the worker.
Also copy `SOPHIA_RUNTIME_DATABASE_URL` from `sophia-runtime-api`: the runtime config
loader requires it. Preserve custom `SOPHIA_RUNTIME_SCHEMA` and
`SOPHIA_RUNTIME_ROLE` settings if that runtime uses them.

For the OpenAI profile, provide `OPENAI_API_KEY` and the same approved
`OPENAI_REASONING_MODEL` as the runtime deployment. Keep credentials server-side.

Set these on the **messaging worker**:

```dotenv
WHATSAPP_INBOUND_WORKER_ENABLED=true
WHATSAPP_REPLY_WORKER_ENABLED=true
WHATSAPP_GENERATION_ENABLED=true
WHATSAPP_AUTOMATION_ENABLED=true
WHATSAPP_OUTBOUND_ENABLED=true
WHATSAPP_VOICE_ENABLED=false
```

Set `WHATSAPP_GENERATION_ENABLED`, `WHATSAPP_AUTOMATION_ENABLED` and
`WHATSAPP_OUTBOUND_ENABLED` to `true` on **nodejs-api** too, so its eligibility
checks and manual reply endpoints agree with the worker. Do not start worker
processes on the API service.

Keep the same `WHATSAPP_INBOUND_PROFILES` JSON array on nodejs-api and the worker.
For the intended pilot profile, change `sendingEnabled` to `true` and ensure the
referenced secrets exist on both services:

- `WHATSAPP_SOPHIA_APP_SECRET`
- `WHATSAPP_SOPHIA_VERIFY_TOKEN`
- `WHATSAPP_SOPHIA_ACCESS_TOKEN` (valid Meta system-user access token)

Keep `appSecretEnv`, `verifyTokenEnv` and `accessTokenEnv` as environment-variable
names in the JSON. Keep the approved Graph version, reasoning adapter and credential
reference consistent with the deployed configuration. Do not substitute the real
mobile-app number or new IDs during this pilot.

## Verify after deployment

1. Confirm the worker starts `process-whatsapp-replies.mjs` without configuration
   or database errors. Confirm Company → WhatsApp no longer reports sending as
   unconfigured.
2. Keep the published agent selected and Automatic text replies saved. If the
   existing conversation is human-owned or shows Human requested, use its explicit
   Resume Sophia action before testing that contact.
3. From the authorised phone, send a fresh question to the current test number:
   “What services does Sophia AI offer?”
4. Check the incoming message, generated response and delivery status in the inbox,
   and verify the answer arrives on the phone and agrees with published knowledge.
5. Test an unsupported question and a human request; confirm appropriate handoff.
   Test appointments separately with configured advisor availability and explicit
   customer confirmation before treating booking as live.

If a reply fails, inspect the worker logs and conversation status before retrying.
After deploying the failure-diagnostics update, search for
`whatsapp_generation_failed` (job/profile and safe error category) and
`whatsapp_reply_tick_failed` (operation/profile and safe error category).
Categories distinguish provider rate limits, incomplete/invalid answers,
generation timeouts and common database permission/schema failures. Unknown
exceptions remain `operation_failed`; raw errors and customer content are not logged.
Do not reset uncertain deliveries to queued. To stop automated replies, disable
`WHATSAPP_AUTOMATION_ENABLED` on API and worker; disable outbound too if all sending
must stop. An already-dispatched request cannot be recalled.

## Remaining real-number work

This change does not implement Embedded Signup/WhatsApp Coexistence. Keeping the
existing WhatsApp Business mobile app active requires that separate onboarding
integration and its verified Meta configuration. Business verification and a saved
agent policy alone do not connect the real number.

## Local validation

- Runtime build passed.
- Inbound, outbound and worker orchestration: 15 tests passed across 3 suites.
- Real-estate regressions: 38 tests passed across 8 suites.
- Orchestration covers independent dispatch during pending generation, optional
  inbound processing and graceful shutdown.
- Docker build, Render deployment and live provider/message tests remain pending.
