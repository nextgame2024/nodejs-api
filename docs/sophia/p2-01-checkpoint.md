# Sophia realtime P2-01 checkpoint

Checkpoint date: 2026-09-23 (Australia/Brisbane)

## Delivered locally

- Added strict, provider-neutral v2 runtime schemas for session creation/plans/descriptors, provider capability manifests, tool definitions/invocations/results, canonical events and one-time connection bootstrap envelopes.
- Added deterministic JSON Schema and TypeScript generation from the runtime-owned schema source. The backend and Angular artifacts carry contract version `2.0.0` and the same SHA-256 schema digest.
- Added drift checks callable from both repositories. No repository CI configuration exists, so these commands are the enforceable local/release gates until CI is added.
- Added an explicit v1 compatibility translator. It drops browser-provided tenant/company/provider authority, uses server context for the device binding and isolates native session credentials in the one-time creation envelope.
- The safe session-status translation accepts only the normalized descriptor and cannot reproduce session access tokens, provider client secrets or avatar session tokens.
- Updated the Sophia boundary scanner to cover the actual `src/platform` and `src/compatibility` roots.

## Activation boundary

No `/api/runtime/v2` session endpoint was activated in P2-01. The existing v1 endpoint and real-estate demo behavior remain unchanged. P2-06 owns canary exposure after profiles, tenant bindings, provider resolution and cleanup are implemented. The v2 creation schema already rejects all specified vendor/company authority fields.

The existing `ConversationService` still has concrete provider composition branches. This is expected current-state debt assigned to P2-04, not evidence that the new contracts depend on those providers. New platform contracts import no provider SDK or business-pack implementation.

## Verification

- `backend/sophia-runtime: npm run contracts:check` — pass.
- `backend: npm run test:p2:contracts` — pass, 1 suite and 15 tests.
- `backend/sophia-runtime: npm test` under Node 22.23.2 — pass, 14 suites and 68 tests.
- `backend/sophia-runtime: npm run typecheck` — pass.
- `backend/sophia-runtime: npm run build` — pass.
- `backend: npm run test:p0:boundaries` — pass, 8 files scanned.
- `backend: npm run test:p0:real-estate` under Node 22.23.2 — pass, 7 suites and 30 tests.
- `frontend: npm run contracts:check` under Node 20.19.1 — pass.
- `frontend: npx tsc -p tsconfig.app.json --noEmit` under Node 20.19.1 — pass.
- `frontend: npm run test:sophia` under Node 20.19.1 — pass, 10 tests in ChromeHeadless 153.

No live provider, email, billing, subscription, production migration or deployment operation was invoked.

## Remaining gates and next task

- No browser end-to-end provider sandbox test was run; the Angular mocked/headless test suite passed.
- No disposable PostgreSQL concurrency environment or live provider failure injection was used.
- P2-02 is next: model and publish immutable server-owned experience, business, provider and capability profiles while preserving `ai_configs` and the working v1 real-estate path.
