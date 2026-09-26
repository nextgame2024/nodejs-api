# Sophia realtime P1 checkpoint

Checkpoint date: 2026-09-23 (Australia/Brisbane)

## Delivered locally

- New realtime activation excludes student tools, prompts, transports and Angular kiosk imports. The retained student HTTP client now lives only inside the quarantined student folder. Legacy Express student routes, tables, data and workers remain preserved.
- Public session creation resolves `essential`, `professional` and `premium` through server policy. Browser customer/store/user/provider fields no longer establish authority.
- Each session receives a random, expiring bearer credential stored only as a hash. Session get/tool/confirm/close operations verify it.
- Tool execution records accepted, executing and terminal states, provider-call identity, correlation, policy decision, elapsed time and redacted payloads. Stale interrupted calls become `unknown` for reconciliation.
- Real-estate booking and resend reviews are durable, expiring, tenant/session-bound and payload-bound. Confirmation is a separate authenticated route, and the browser requires an explicit on-screen confirmation action; a model-generated `confirmed` field or an unrelated utterance cannot authorize the write. Stable command IDs drive Business Manager idempotency.
- Inspection email resend commands have durable Business Manager receipts. Completed commands return the stored receipt; ambiguous provider outcomes are not automatically repeated.
- Server-owned active-session and tool-rate budgets are enabled. Arbitrary research and mock inventory tools are absent from the public product catalogue. Raw audio and complete transcripts are not persisted by this implementation.
- Root API/worker runtime metadata and Docker base now target Node 22.23.2. Nest already targets Node 22.

## Database changes applied

- `004_tool_call_lifecycle.sql`: additive tool lifecycle/correlation columns, state constraint and deduplication indexes.
- `005_action_reviews.sql`: durable action review table and indexes.
- `bm_inspection_email_commands`: durable resend command/receipt table created through the Business Manager schema function.

The runtime migrations were applied to configured database `nodejs-api-db`. A rollback-only transaction verified lifecycle inserts and constraints; no synthetic rows were retained.

A read-only legacy-delivery inventory found nine student consultation deliveries, all in `sent` state and none outstanding. The legacy worker and its tables remain untouched.

## Data-flow and admission boundary

The browser receives an opaque, short-lived session credential. Nest stores its hash in private session metadata. Nest sends permitted business commands to Business Manager using the existing service credential and fixed company binding. Business Manager remains authoritative for property, availability, booking and delivery receipts. Provider/browser events propose tool calls but cannot select a tenant or bypass the authenticated review-confirmation route.

Routine tool audit payloads redact email, token, secret, password, authorization, audio and transcript keys. Active review payloads retain only the fields needed to bind confirmation and are cleared when invalidated or expired. No new audio recording or transcript store was introduced.

## Deployment and remaining gates

Nothing was deployed. Backend runtime and Angular changes must be released together because older clients do not send the new session bearer token. Existing active sessions created before deployment will need to restart.

The Node 22 Docker image was not built in this environment, although Node 22 tests and native Sharp/ffmpeg smoke checks passed. Render runtime settings must be verified during release. Privileged Admin identity/MFA remains future Admin work; P1 protects the public runtime but does not make the sixteen Admin modules complete.

The final Angular type check passed. A fresh headless-browser test rerun was blocked in this workstation by multiple stale Angular builders that remained stuck at `Building...`; the immediately preceding 10-test Sophia run passed before the final confirmation-button/CSS edit. Browser E2E and live provider failure injection remain release gates.

P2-01 is the next specification task after review of this coordinated-release boundary.
