# P5-04 checkpoint — configurable orchestrated voice

Status: complete with activation limits
Recorded: 2026-09-25 (Australia/Brisbane)
Plan: 2.1.22

## Delivered

- Provider-neutral transcription, synthesis and sole playable-audio sink contracts.
- A real `openai-transcription-v1` adapter that memory-bounds a client-delimited
  signed PCM16/24 kHz/mono turn, creates a WAV upload and returns canonical final
  transcript text.
- A real `openai-synthesis-v1` adapter using streamed raw PCM, with configured
  model/voice, byte limits and sample alignment independent of HTTP chunking.
- An isolated composition that runs transcription → generic reasoning and secured
  tools → synthesis → exactly one `AudioOutputSink`.
- Pre-connection capability and exact-codec checks, bounded speakable text,
  application turn epochs, provider cancellation, sink queue flushing and late-event
  suppression.
- Contract evidence that changing only the reasoning adapter between Claude and
  Gemini preserves the `catalog.search` → `booking.prepare` workflow.

## Plan correction

OpenAI file transcription is a completed-turn API, not an ongoing microphone
stream. This first composition therefore provides final-only, bounded-turn speech
input and does not claim live partial-transcript latency. Audio explicitly traverses
Sophia Runtime and OpenAI. Interruption can discard queued/unplayed audio but cannot
retract speech already heard.

The current LiveAvatar and Simli server `sendAudioChunk` implementations are no-ops
for browser-owned SDK sessions. Their generic registrations no longer claim
speech-output compatibility, and neither can be selected as an `AudioOutputSink`
until real injection, codec and interruption behavior is implemented and tested.

Current OpenAI documentation records no abuse-monitoring or application-state
retention for `/v1/audio/transcriptions`; `/v1/audio/speech` records 30-day abuse
monitoring and no application-state retention. Both are ZDR-eligible. This must be
revalidated for the deployment account and region. Users must be told the voice is
AI-generated.

Official references:

- https://developers.openai.com/api/docs/guides/speech-to-text
- https://developers.openai.com/api/docs/guides/text-to-speech
- https://developers.openai.com/api/docs/guides/your-data
- https://developers.openai.com/api/docs/guides/voice-server-controls

## Verification

- `npm run typecheck` — pass.
- `npm run build` — pass.
- `npm run contracts:check` — pass.
- `npm test` — 59 suites and 239 tests passed.
- `npm run test:p0:boundaries` — 148 new-product source files passed.
- `npm run test:p0:real-estate` — 8 suites and 38 tests passed.

## Activation limits

No live provider request was made. The pipeline intentionally has no public browser
route and no concrete kiosk media sink. Activation requires the managed kiosk
credential/media broker, approved data handling and regional routing, AI-voice
disclosure, a real direct or avatar sink contract, and an explicitly authorised live
smoke test. Raw audio is not persisted by this implementation.

Next ready task: P5-05 — add Gemini native Live as a separately verified realtime
adapter.
