# P5-05 checkpoint — Gemini native Live

Status: complete with activation limits
Recorded: 2026-09-25 (Australia/Brisbane)
Plan: 2.1.23

## Delivered

- A provider-neutral `NativeRealtimeProvider` boundary and concrete
  `GoogleGeminiLiveProvider`.
- Server-side one-use ephemeral token minting constrained to the approved model,
  server instructions, exact tool declarations, native audio, transcription,
  context compression and interruption policy.
- A `gemini-live-v1` capability manifest and v2-only lifecycle adapter; existing
  OpenAI realtime and real-estate experience routing is unchanged.
- A browser constrained-WebSocket adapter with trusted-host validation, microphone
  capture/resampling to signed PCM16 16 kHz mono, 24 kHz PCM Web Audio playback,
  all-part event processing and one audible owner.
- Provider-local tool aliases, duplicate suppression, cancellation handling and
  routing through the existing authenticated tenant-scoped dispatcher.
- Playback queue clearing for provider barge-in/interruption. Explicit review UI
  remains the only confirmation authority for prepared bookings and mutations.

## Plan corrections

The stable `gemini-3.8-live` model supports audio response and defaults functions to
`NON_BLOCKING`. Every Sophia declaration is therefore forced to `BLOCKING`; text-only
response parity and asynchronous mutation ordering are not claimed.

Live API and ephemeral tokens remain preview surfaces. Google documents periodic
WebSocket reset behavior and says SessionResumptionConfig can retain conversation
state, including audio/video, for up to 24 hours. This adapter omits resumption and
caps profile sessions at 540 seconds with a 600-second token. Longer sessions require
a separately reviewed field-mask/reconnection implementation and retention decision.

The browser receives only a one-use constrained token. Provider tool events remain
an untrusted browser bridge and cannot bypass session capabilities, policy,
idempotency or explicit review. The adapter remains unpublished and fails closed
without `GEMINI_API_KEY`.

Official references:

- https://ai.google.dev/gemini-api/docs/models/gemini-3.8-live
- https://ai.google.dev/gemini-api/docs/live-api/ephemeral-tokens
- https://ai.google.dev/api/live
- https://ai.google.dev/gemini-api/docs/live-api/capabilities
- https://ai.google.dev/gemini-api/docs/zdr

## Verification

- Runtime `npm run typecheck`, `npm run build`, `npm run contracts:check` — pass.
- Runtime `npm test` — 60 suites and 242 tests passed.
- Frontend TypeScript application check and production build — pass; existing bundle,
  CommonJS and stylesheet warnings remain.
- Frontend `npm run test:sophia` — 68 tests passed in Chrome Headless.
- Backend `npm run test:p0:boundaries` — 148 source files passed.
- Backend `npm run test:p0:real-estate` — 8 suites and 38 tests passed.

## Activation limits

No live Gemini token, WebSocket, audio, function-call or interruption request was
made. Production publication requires explicit profile configuration, preview-risk
approval, a paid-project/data-processing and regional review, abuse-monitoring
assessment, AI-voice disclosure, browser microphone/playback E2E, and an authorised
credentialed smoke test. Session resumption is intentionally unavailable. The
compiled Angular transport is not reachable through the active v1 kiosk facade;
selection also requires the P4 managed kiosk broker and v2 descriptor/bootstrap
translation.

Next ready task: P5-06 — prove business and provider portability without another
vertical.
