# P5-06 checkpoint — business and provider portability

Status: complete
Recorded: 2026-09-25 (Australia/Brisbane)
Plan: 2.1.24

## Delivered

- A test-only synthetic capability laboratory with configurable knowledge, catalog,
  availability and booking ports.
- Two neutral tenant configurations with different wording, incompatible strict
  extension schemas, distinct grants, overlapping opaque resource IDs and one
  tenant without booking authority.
- Adversarial assertions for unknown business fields, unavailable capabilities,
  cross-tenant/cross-connector references and safe same-connector capability flow.
- One canonical read-tool harness exercised against both neutral fixture ports and
  the compiled Business Manager real-estate connector.
- A dedicated portability Core TypeScript configuration that compiles shared
  capability, orchestration, registry and tool contracts without importing a
  concrete provider adapter or the real-estate registration.
- Boundary enforcement that keeps the neutral fixture free of real-estate,
  student-agency and provider imports.

## Plan correction

The original `ResourceRef` used `capabilityBindingId`. Repository schema inspection
showed that a business profile has a different capability-binding row for catalog,
availability and booking. A catalog reference therefore could not pass the
real-estate connector's binding check when the next granted operation used its own
capability-binding ID.

Plan 2.1.24 changes resource provenance to `connectorBindingId`. The operation still
uses `CapabilityContext.capabilityBindingId` for the exact grant, schema, policy and
audit decision. A portable resource is consequently scoped by tenant, connector
binding and opaque ID, and cannot be reused against another tenant connector even
when its opaque ID is identical.

Provider portability remains based on the common `ReasoningProvider` contract,
canonical tool definitions and secured pipeline. The existing OpenAI Responses,
Anthropic Messages and Gemini Interactions suites use mocked vendor protocols and
assert common tool effects; identical prose and live-provider success are not
claimed.

## Verification

- Runtime `npm run typecheck:portability-core` — pass.
- Runtime `npm run typecheck`, `npm run build`, `npm run contracts:check` — pass.
- Runtime `npm test` — 61 suites and 247 tests passed.
- Focused portability/capability/knowledge/real-estate connector run — 4 suites and
  18 tests passed.
- Backend `npm run test:p0:boundaries` — 149 source files passed.
- Backend `npm run test:p0:real-estate` — 8 suites and 38 tests passed.

## Limits

The synthetic fixtures live only under `sophia-runtime/test`. They are not compiled
into the production build, registered as a business pack, exposed through a Core
controller or represented as production data. No live AI provider, external
connector, production database or tenant onboarding operation was invoked.

Next ready task: P6-01 — verify integrated Admin configuration onboarding and safe
publication.
