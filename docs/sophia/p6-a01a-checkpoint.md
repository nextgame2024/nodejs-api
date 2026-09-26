# P6-A01A checkpoint — Conversation operations backend

Completed 25 September 2026.

## Delivered

- Tenant-scoped conversation list filters for date, agent/release, normalized channel, session outcome and current escalation status, with stable cursor pagination.
- A normalized, chronological metadata timeline spanning session lifecycle, events, tool calls, action reviews, workflow references and escalation case events without returning raw payloads.
- A separate `conversations.read_content` endpoint behind the existing recent-MFA gate. Credential-shaped fields are recursively redacted, and approved retention durations suppress expired content at read time unless an active legal hold applies.
- Append-only operator notes with tenant-forced RLS. Note bodies are available only at the content boundary; annotation receipts do not echo the note. Privacy deletion may replace a note body only with `[privacy redacted]` while retaining authorship and timestamp evidence.
- Optional source-session linkage on existing workflow-run references, preserving the workflow owner as the source of truth.
- Transcript and audio status remain `unavailable_not_recorded`. The console does not reconstruct transcripts from generic events or expose playback without a consent-bound retained asset.

## Database and Neon verification

- Migration `025_conversation_operations.sql` was applied to the configured Neon database.
- A rollback-only probe executed the actual conversation service under `sophia_runtime_app` and proved tenant-separated lists, metadata/content separation, recursive credential redaction, forced RLS on notes and unavailable transcript/audio states.
- The probe created no retained records and invoked no provider or external business effect.

## Verification

- Sophia Runtime portability-Core typecheck, production typecheck, build, generated-contract drift check and the final all-tests rerun passed: 78 suites/288 tests.
- The rollback-only Neon probe passed after sequential transaction queries replaced a deprecated concurrent single-client pattern.
- Boundary scan passed for 185 new-product files.
- Protected real-estate characterization passed 8 suites/38 tests.

## Remaining boundary

The fixed Operations Member role intentionally has metadata and annotation but not content or export. No role was silently broadened. A production identity still needs a separately approved content grant plus recent MFA before content can be read.

P6-A01 remains in progress. Next ready slice: P6-A01B — bounded expiring conversation exports and the permissioned Angular Conversations workspace. Retained-audio UI must remain unavailable until a future consent-bound storage model exists.
