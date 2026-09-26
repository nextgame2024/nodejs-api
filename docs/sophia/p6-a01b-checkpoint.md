# P6-A01B checkpoint — Conversations workspace and controlled exports

Completed 26 September 2026.

## Delivered

- The lazy-loaded `/sophia-admin/conversations` workspace is now available to principals with `conversations.read_metadata`.
- The UI provides date, agent/release, channel, outcome and escalation filters; stable pagination; normalized chronological metadata; escalation-inbox linkage; and permissioned operator notes.
- Content is loaded only when the principal has `conversations.read_content`; the API continues to require recent MFA. Angular interpolation renders untrusted timeline/content values as text rather than executable markup.
- Transcript and audio states are shown honestly. The page has no playback control and does not reconstruct a transcript from events, tools or provider logs.
- `conversations.export` creates a bounded JSON manifest for one conversation, capped at 5,000 timeline items and expiring after 24 hours. A content manifest additionally requires `conversations.read_content` for creation and download.
- Export manifests store tenant, session, scope, bound, cutoff and access evidence only. The document is rendered on authorised access from current retention/privacy state, receives a SHA-256 digest and is not persisted as a second sensitive-content copy.

## Database and Neon verification

- Migration `026_conversation_exports.sql` was applied to the configured Neon database.
- Export manifests use forced RLS, immutable identity/access-count constraints and Runtime delete revocation.
- A rollback-only `sophia_runtime_app` probe proved tenant isolation, metadata/content separation, denial of content export without content permission, metadata export withholding, content export rendering, SHA-256 evidence, forced RLS and absence of any stored document/content/payload column.

## Verification

- Sophia Runtime portability-Core and production typechecks, build, contract drift check and 79 suites/292 tests passed.
- Focused Angular tests passed 15/15; the complete Sophia Runtime/Admin browser suite passed 76/76.
- Frontend TypeScript compilation and production build passed. Existing bundle/font/CommonJS/missing stylesheet warnings remain unchanged release concerns.
- Boundary scan passed for 187 new-product files; protected real-estate characterization passed 8 suites/38 tests.
- No provider, email, payment, subscription or production conversation content was invoked or retained by verification.

## Remaining limits

- Full transcript and raw-audio persistence remain disabled; there is no retained playback asset.
- The fixed Operations Member template intentionally has conversation metadata and annotation only. No role was silently granted content/export; those permissions require a separately approved grant model and recent-MFA identity.
- A future high-volume background export would require an approved private object store, worker lifecycle and deletion/retention integration. This task does not label render-on-access manifests asynchronous.

P6-A01 is complete with limits. Next ready task: P6-A03 — build the business-neutral Analytics dashboard.
