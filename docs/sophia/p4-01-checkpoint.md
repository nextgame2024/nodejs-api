# P4-01 checkpoint — Angular session facade

Date: 2026-09-25 (Australia/Brisbane)

Status: complete with deployment limits

## Outcome

The public kiosk now consumes one `SophiaSessionFacade` for session creation,
connection, interruption, close/disconnect, heartbeat, inactivity handling,
media routing, runtime tool transport, errors and normalized session/event state.
The page no longer imports or injects a concrete provider client or runtime
session service and does not branch on provider IDs during startup or finish.

The experience selector now uses the stable public IDs `essential`,
`professional` and `premium`. Provider-specific response fields remain contained
inside the facade as bounded v1 compatibility until browser transport adapters
are normalized in P4-02.

The real-estate presentation and explicit booking-review behavior remain in the
kiosk page for the later renderer extraction. Runtime tool inputs and outputs
cross the facade through callbacks, preserving the existing property, gallery,
inspection, booking and agency-knowledge UI behavior.

## Security and plan correction

Repository inspection proved that `POST /api/runtime/v2/bootstrap` requires
`X-Sophia-Installation-Key`, while the Runtime README explicitly prohibits
placing that installation key in a public browser bundle. No managed kiosk
credential broker exists in the repository yet.

Plan version 2.1.10 therefore records that Angular must remain on the bounded v1
lifecycle, where authority is server-resolved, until an installation backend or
managed kiosk broker can exchange the installation secret for a short-lived,
one-time bootstrap token. No customer, device, store, provider, paid-plan or
installation-key authority was added to the kiosk.

## Verification

- `npx tsc -p tsconfig.app.json --noEmit` — passed under Node 20.19.1.
- `npm run test:sophia -- --no-progress` — 18 tests passed in Chrome Headless,
  including stable experience-ID and normalized interruption facade tests.
- `GOOGLE_MAPS_API_KEY=dummy npm run build` — passed under Node 20.19.1. Existing
  bundle/font/CommonJS/missing PrimeIcons stylesheet warnings remain.
- Static inspection found no provider/client/session-service imports, provider
  plan map, or vendor branch in the kiosk page/template.

No live provider session, email, booking, payment, subscription or deployment
operation was invoked. Browser E2E against provider sandboxes remains a release
gate rather than evidence claimed by this task.

## Next ready task

P4-02 — normalize browser transports and media ownership behind an adapter
registry. Direct v2 browser activation remains gated on the managed credential
broker recorded in plan amendment `AMEND-2026-09-25-P4-01`.
