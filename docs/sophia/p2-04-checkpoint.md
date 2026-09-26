# Sophia realtime P2-04 checkpoint

Checkpoint date: 2026-09-23 (Australia/Brisbane)

## Delivered locally

- Added explicit DI registries for provider capabilities and complete session lifecycle adapters.
- Registered the existing native realtime, composite realtime, reasoning, speech, avatar and research implementations with provider-neutral capability manifests.
- Added deterministic validation for capability support, pipeline modes, capability ownership, single speech-output ownership and non-replaceable composite reasoning.
- Moved Essential and Professional session open/close behavior into the native realtime lifecycle adapter. Professional preserves text-only reasoning output with one LiveAvatar FULL speech owner; Essential preserves native audio output.
- Moved Premium session open/close behavior into the composite lifecycle adapter. It preserves the native-only reasoning constraint, avoids a second reasoning session and keeps provider-native research separate from `researchBusiness`.
- `ConversationService` now depends only on `ProviderSessionRegistry`; it contains no OpenAI, Tavus, LiveAvatar, Simli, concrete-provider injection or vendor switch.
- New sessions persist a lifecycle adapter key. A bounded compatibility resolver closes sessions created before this metadata existed.
- Failed session persistence now invokes adapter cleanup, preventing an opened external session from being orphaned.
- `researchBusiness` resolves its implementation through the registered research capability rather than concrete provider construction in the tool registry.
- Removed obsolete concrete-provider exports from the provider composition module; consumers receive only capability and lifecycle registries.

## Compatibility and activation boundary

The public Essential, Professional and Premium request/response shapes, provider session behavior and database provider fields remain compatible. Browser-supplied legacy provider hints still cannot select authority. No provider was called live during this task.

The current experience mapping remains a server-owned compatibility registration pending P2-06 activation of published experience profiles and release-pinned session plans.

## Verification

- Focused capability/lifecycle/conversation/tool tests — pass, including partial-open cleanup coverage.
- Full runtime suite under Node 22.23.2 — pass, 28 suites and 112 tests.
- Runtime typecheck and build — pass.
- Nest dependency graph initialized successfully in a local smoke; socket binding was denied by the sandbox after initialization.
- Protected real-estate suite — pass, 7 suites and 30 tests.
- P2 contract suite — pass, 15 tests.
- Full Business Manager release suite — pass, 16 suites and 66 tests; 4 suites/12 SQL-gated tests skipped.
- Boundary scan — pass, 37 new-product files.

No live provider, email, billing or subscription operation was invoked.

## Next task

P2-A02 is next in roadmap order: organisation, membership and invitation lifecycle APIs on the existing Business Manager identity boundary.
