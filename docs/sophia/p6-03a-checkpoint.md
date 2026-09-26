# P6-03A checkpoint — Privacy control plane and legal-review evidence

Completed 25 September 2026.

## Delivered

- A tenant-scoped privacy control plane records versioned notice manifests, append-only purpose-specific consent evidence, explicit retention-policy proposals, legal holds, subject requests, store ownership targets, provider/subprocessor data flows and the production legal checklist.
- Subject requests accept only opaque references, persist a tenant-bound SHA-256 digest rather than names or email addresses, and reject session selectors that are unknown or outside the tenant.
- Runtime-controlled targets and external-owner targets are distinct. Business Manager generated documents, provider-held data and backups cannot be represented as deleted until their owning adapter supplies evidence.
- Organisation Owner receives privacy management permissions. Approval, subject-request and hold operations require recent MFA; Read-only Auditor receives `privacy.read` only.
- New and existing sessions receive database-constrained privacy defaults: raw-audio recording, full-transcript persistence and marketing are all off. V2 admission rejects an experience requesting recording or full transcript persistence before provider allocation because no explicit session-consent activation path exists yet.
- Legal review remains one of `required`, `pending` or `approved`. Approval requires a review reference and an identified independent reviewer; the administrator recording the state cannot identify themself as that reviewer.
- Automatic retention execution remains disabled even when policy records exist. No retention duration, legal conclusion, provider deletion or backup capability was invented.

## Database and Neon verification

- Migration `023_privacy_control_plane.sql` was applied to the configured Neon database.
- All nine privacy tables have RLS enabled and forced.
- A rollback-only `sophia_runtime_app` probe inserted an in-tenant request, rejected a cross-tenant request, verified existing privacy controls are off and confirmed the database rejects enabling raw-audio recording. All synthetic customers, sessions and requests were rolled back.

## Verification at this checkpoint

- Portability-Core and production typechecks, build and generated-contract drift check passed; all 73 Runtime suites/277 tests passed.
- Boundary scan passed across 178 new-product files; 8 protected real-estate suites/38 tests passed.
- No live provider, Business Manager write, document deletion, backup operation, email, payment, legal approval or retained synthetic record was created.

## Plan refinement

Plan 2.1.29 splits P6-03 into two evidence boundaries. P6-03A is complete with limits. P6-03B must implement Runtime redaction/access processors, external owner completion evidence, legal-hold-aware retention execution and a rollback-only synthetic end-to-end deletion proof before P6-03 is complete.

Next ready task: P6-03B — implement and verify privacy request execution across owned stores.
