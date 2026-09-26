# P4-04 checkpoint — Durable confirmation and kiosk privacy

Status: complete with a declared provider limitation.

## Delivered

- Durable action reviews can be read and cancelled only through the session-and-tenant-scoped bearer boundary. Expired reviews are scrubbed before lookup.
- The reviewed booking payload now binds the displayed property address and time label as well as property/slot/time/name/email. The separate authenticated confirmation endpoint remains the only confirmation authority; local UI state cannot authorize a mutation.
- Cancelling a review, closing a session, disconnecting, expiry cleanup and shared-kiosk teardown clear review payloads, forms, presentation state, assistant text and volatile session credentials. Booking, command, tool-call and workflow status records remain authoritative.
- Local cleanup runs even if remote close fails. The kiosk never stores the session bearer in browser persistence, so a hard reload starts clean and cannot recover a prior visitor’s data.
- Native Realtime now continues with a receive-only WebRTC audio path if microphone permission fails. A bounded typed form sends a real user text turn and displays accessible assistant text without changing the session tool catalog or capability grants.
- Booking confirmation and delivery/report status remain separate: provider acceptance is still processing, preview means no delivery, and only verified delivery is labelled delivered.

## Plan correction

Plan 2.1.18 records that hard-reload credential recovery is unsafe on a shared kiosk. Current-review recovery is available only while the authenticated in-memory bearer still exists. It also keeps Tavus/Daily typed input fail-closed because the repository and provider documentation expose no verified typed-user-input contract; universal portable text belongs to P5's common reasoning pipeline.

## Verification

- Frontend TypeScript passed.
- 65 Sophia Runtime/Admin Chrome Headless tests passed.
- Frontend production build passed with the existing bundle/font/CommonJS/missing PrimeIcons warnings.
- Runtime typecheck, build and generated-contract drift check passed.
- 52 runtime suites and 208 tests passed.
- Boundary check passed across 141 new-product source files.
- 8 protected real-estate suites and 38 tests passed.

## Unrun/live evidence

- No live OpenAI microphone-denial browser session was opened.
- No live Tavus/Daily session was invoked; its typed-input fallback remains unavailable by design.
- No live booking, report or email side effect was invoked.

Next ready task: P5-01 — common reasoning pipeline and OpenAI reasoning adapter.
