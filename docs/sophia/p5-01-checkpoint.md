# P5-01 checkpoint — Common reasoning pipeline and OpenAI adapter

Status: complete with live-provider and browser-activation limits.

## Delivered

- A provider-neutral `ReasoningProvider` contract and bounded streamed orchestration loop handle canonical history, text deltas, tool calls/results, token usage, cancellation, terminal errors, tool-round limits and total call limits.
- Every model-requested operation goes through `ToolRegistryService.executeV2` with the session credential and server-provider provenance. The existing dispatcher remains authoritative for tenant binding, schema validation, action review, mutation safety, deduplication and audit.
- A concrete OpenAI Responses adapter maps SSE text, function calls, function outputs, usage and failures into canonical events. The configured model alias and provider details remain outside Core.
- OpenAI requests use `store: false`; encrypted reasoning/output continuation items live only inside the active adapter session and are cleared on close.
- Canonical dotted tool IDs are translated to collision-free OpenAI-safe names inside the adapter and translated back before execution. Canonical IDs do not change.
- Shared fixtures cover provider-neutral text, a catalog-to-real-estate-review workflow, tool results, usage, cancellation, provider failure, invalid arguments and opaque continuation isolation.
- The adapter manifest advertises reasoning and token usage only. It does not advertise speech input/output, native realtime or avatar capability.

## Plan correction

Plan 2.1.19 records that OpenAI function-name rules cannot directly carry Sophia's dotted canonical tool IDs, strict provider schema mode cannot represent every existing optional business field without changing semantics, and provider-side stored responses would create an unnecessary second transcript authority. Adapter-local aliases, non-strict provider declarations plus authoritative dispatcher validation, stateless encrypted continuation and sequential tool execution preserve the established boundaries. P5-01 is a server capability; it does not bypass the managed kiosk broker prerequisite by adding a public browser endpoint.

## Verification

- Focused reasoning, secured executor, tool dispatcher and provider registry run: 5 suites and 31 tests passed.
- Runtime typecheck, build and generated-contract drift check passed.
- Full Runtime suite: 55 suites and 216 tests passed.
- Boundary check passed across 146 new-product source files.
- 8 protected real-estate suites and 38 tests passed.

## Unrun/live evidence

- No live OpenAI Responses request was made; fetch/SSE behavior is covered with mocked contract fixtures.
- No published tenant provider binding was changed and no browser route was activated.
- No database migration, business mutation, email, report or provider provisioning was required.

Next ready task: P5-02 — implement and test the Anthropic Claude reasoning adapter against the same contract fixtures.
