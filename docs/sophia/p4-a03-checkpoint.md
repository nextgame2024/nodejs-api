# P4-A03 checkpoint — Agents, Agent versions and Instructions

Date: 2026-09-25 (Australia/Brisbane)

Status: complete with authenticated-browser and live-sandbox limits

## Outcome

Sophia Admin now exposes three protected, lazy workspaces backed by the
tenant-scoped Admin APIs:

- **Agents** lists and creates neutral agent drafts, edits immutable dependency
  references, validates composition, and previews composed instructions without
  starting a provider session or invoking a connector.
- **Agent versions** shows server publication checks, draft-versus-active
  differences and immutable release history. Publishing and rollback use the
  existing server lifecycle; draft edits never alter active sessions. Emergency
  revocation remains permission- and recent-MFA-gated.
- **Instructions** creates instruction sets and draft revisions, declares only
  scalar template variables, displays the fixed platform safety policy
  separately, and approves immutable revisions.

The backend now supplies a safe authoring-dependencies read model. It includes
only selectable published tenant resources and provider capability/limitation
summaries. The response does not expose provider credential references or raw
provider settings. Sections for which the principal lacks the corresponding
read permission are empty and explicitly reported as restricted.

Provider choice remains part of an immutable published experience profile. An
agent selects that profile rather than duplicating provider configuration or
claiming that every provider is interchangeable.

## Plan correction

Plan version 2.1.15 records that the existing draft write contract accepted
immutable IDs but did not expose a safe tenant authoring catalogue. Raw UUID
entry would not have met the no-code authoring requirement and would have made
invalid composition likely. The corrected task therefore adds the safe
dependency read model and selector-based UI.

The repository also has no approved metered agent-sandbox contract. The preview
is deliberately deterministic composition and publication validation with
`externalEffects=false` and `meteredSessionCreated=false`; it cannot contact a
provider, execute a tool, send a message, or create a booking.

## Verification

- Frontend Angular typecheck — passed under Node 20.19.1.
- `npm run test:sophia` — 52 tests passed in Chrome Headless 154, including
  generic and optional real-estate fixtures through the same authoring
  contract, server-check publication blocking, immutable instruction approval,
  safe provider summaries, and the no-effects preview.
- Frontend production build — passed with the existing bundle-budget, Manrope,
  HeyGen CommonJS and missing PrimeIcons warnings. New workspace markers are
  present only in lazy chunks and absent from the initial main bundle.
- Sophia Runtime typecheck, build and generated-contract drift check — passed.
- Sophia Runtime full test suite — 51 suites and 204 tests passed.
- `npm run test:p0:boundaries` — 132 new-product source files passed.
- `npm run test:p0:real-estate` — 8 suites and 38 regression tests passed.
- Frontend and backend `git diff --check` — passed.

No production data, live provider session, connector operation, email, booking,
migration or metered sandbox operation was invoked.

## Limits

- No authenticated multi-account browser E2E harness exists; component/service
  contract tests and backend authorization tests are not described as E2E.
- Authoring can select only resources that already exist and are published.
  Business/experience/provider-profile creation remains with its owning control
  plane and is not fabricated in this workspace.
- A live provider-backed evaluation sandbox remains a separate, explicitly
  metered and data-governed capability. This task supplies only the safe
  deterministic preview.

## Next ready task

P4-A04 — implement the remaining Tools and Connectors workspaces and reconcile
the already-delivered Knowledge workspace against that task's final scope.
