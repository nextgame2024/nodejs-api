# P5-02 checkpoint — Anthropic Claude reasoning adapter

Status: complete with live-provider and data-handling activation limits.

## Delivered

- A concrete Anthropic Messages adapter implements the existing provider-neutral `ReasoningProvider`; Core, secured tools, the real-estate pack and Angular contain no Claude branch.
- Claude SSE message/content-block events map to canonical text, tool call, usage, completion and safe failure events. Input usage includes uncached, cache-creation and cache-read tokens so canonical totals remain comparable.
- Stateless continuation preserves complete Claude assistant blocks only inside the active adapter, including opaque thinking/signature/redacted-thinking content when returned. None of that provider state is emitted into canonical history or application events.
- Canonical dotted tool IDs use adapter-local provider-safe aliases. Returned calls are translated back before the existing authenticated v2 dispatcher authorises or executes them.
- Tool results immediately follow the assistant tool-use turn in a user message. Failed, denied, cancelled and outcome-unknown results set Claude's `is_error` flag; no mutation is automatically retried.
- `disable_parallel_tool_use` is set inside Claude's `tool_choice`, preserving deterministic review/mutation ordering in the shared sequential loop.
- `anthropic-reasoning-v1` is registered as replaceable text/tool reasoning with no speech, realtime or avatar claim. It is absent from published profiles and fails closed without `ANTHROPIC_API_KEY`.

## Plan correction

Plan 2.1.20 records that a stateless Messages exchange does not prove zero data retention. Anthropic ZDR is an organisation/workspace contractual arrangement, not a per-request storage flag. Publishing a production Claude binding therefore requires an approved data-handling assessment, verified retention/ZDR terms and a current model-lifecycle review. Strict tool schemas remain static and contain no tenant personal data because the provider documents bounded schema caching for strict structured output.

## Verification

- Focused cross-provider reasoning, secured executor, dispatcher and registry run: 6 suites and 39 tests passed.
- Runtime typecheck, build and generated-contract drift check passed.
- Full Runtime suite: 56 suites and 224 tests passed.
- Boundary check passed across 146 new-product source files.
- 8 protected real-estate suites and 38 tests passed.

## Unrun/live evidence

- No live Claude Messages request was made; fetch/SSE behavior is covered with mocked contract fixtures.
- No Anthropic organisation/workspace retention or ZDR arrangement was verified.
- No published tenant provider binding was changed and no browser route was activated.
- No database migration, business mutation, email, report or provider provisioning was required.

Next ready task: P5-03 — implement and test the Google Gemini reasoning adapter against the same contract fixtures.
