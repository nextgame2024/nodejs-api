# P4-02 checkpoint — browser transports and media ownership

Date: 2026-09-25 (Australia/Brisbane)

Status: complete with deployment limits

## Outcome

The Angular runtime now resolves conversation transports and presentation
providers through exact, versioned browser adapter manifests. OpenAI WebRTC and
Daily/Tavus are session transport adapters; static presentation, Simli and
LiveAvatar are independently registered presentation adapters. The kiosk and
business UI remain provider-neutral and adding a registered adapter does not
require a page branch.

One `SophiaMediaOwner` now controls the three possible audible elements so a
session has exactly one speech owner. Interruption cancels OpenAI generation and
clears its output buffer, interrupts Tavus conversation output, clears queued
LiveAvatar PCM and interrupts its active SDK session. Repeated provider tool
events share one in-flight execution by provider call identity; interruption
does not reverse an already committed runtime command.

Ephemeral provider bootstrap values are passed directly from the create-session
response to the selected adapter. The facade retains only the sanitized session
record. Startup failure, normal close and route destruction disconnect provider
sessions, remove listeners, clear media elements and discard the locally held
session access credential. The obsolete aggregate avatar client was removed.

## Plan correction

Repository inspection found that the existing v2 `SessionDescriptor.adapterKey`
identifies the server lifecycle adapter. It is not sufficient to select browser
SDKs because a browser session may compose a separate conversation transport and
presentation adapter.

Plan version 2.1.11 therefore separates browser adapter keys from server
lifecycle keys. The current v1 response mapping is contained in one compatibility
translator. Before direct v2 activation, the managed kiosk broker must return an
explicit browser transport composition with a browser adapter key and media role
for each connection envelope. The frontend will not guess browser SDKs from the
server's primary adapter key.

## Verification

- `npx tsc -p tsconfig.app.json --noEmit` — passed under Node 20.19.1.
- `npm run test:sophia` — 28 tests passed in Chrome Headless 154, including
  exact/duplicate registry resolution, one audible owner, duplicate tool-event
  suppression, normalized interruption, expiry cleanup and media cleanup.
- `GOOGLE_MAPS_API_KEY=dummy npm run build` — passed under Node 20.19.1. Existing
  bundle/font/CommonJS/missing PrimeIcons stylesheet warnings remain.
- Static inspection found no concrete provider imports in the facade or kiosk
  and no remaining references to the removed aggregate avatar client.

No live OpenAI, Daily/Tavus, LiveAvatar or Simli browser session was opened.
Provider-sandbox browser E2E and the managed v2 credential-broker contract remain
deployment gates rather than evidence claimed by this task.

## Next ready task

P4-A01 — build the protected Sophia Admin Angular shell. P4-03 is also dependency
ready after this checkpoint, but the approved P4 task order places P4-A01 first.
