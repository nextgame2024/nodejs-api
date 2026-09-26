# P3-A01a checkpoint — approved managed-text knowledge

Date: 2026-09-24 (Australia/Brisbane)

## Outcome

The safe backend slice of ADM-06 is complete. Sophia Runtime now owns tenant-scoped knowledge sources and immutable revisions, idempotent managed-text ingestion jobs, explicit approval/publication, capability-granted snapshots, a PostgreSQL full-text index, published-only retrieval preview, retirement, and privileged audit records.

Connector references are accepted only as opaque identifiers attached to an active tenant connector binding. They remain pending and cannot fetch, ingest, or publish until a separately approved connector ingestion adapter is implemented. Business Manager remains the authority for its real-estate knowledge; this slice neither copies nor replaces that index.

## Plan correction

Repository inspection found no Sophia-owned private object-storage binding, malware scanner, or isolated document-parser worker. Existing presigned upload paths are for public avatars/images and are not safe knowledge-document infrastructure. Plan version 2.1.2 therefore splits P3-A01:

- P3-A01a (complete): managed text and metadata-only connector references, lifecycle, grants, snapshots, index and retrieval preview.
- P3-A01b (not started): bounded files and the complete Angular ADM-06 surface, gated on approved private storage, malware scanning and an isolated bounded parser worker.

No browser-supplied URL, unrestricted fetch, embedding vendor, student implementation, or public image-upload flow was introduced.

## Database evidence

Migration `015_approved_knowledge_lifecycle.sql` was applied to the configured Neon PostgreSQL database. A rollback-only verification confirmed:

- `sophia_runtime_app` has `BYPASSRLS=false` and is not a superuser.
- The runtime role has the required privileges on the new knowledge tables.
- A different tenant's rows are invisible and a cross-tenant insert is denied.
- The temporary verification tenant and writes were rolled back.

## Verification

- Sophia Runtime typecheck: pass.
- Sophia Runtime full suite: 42 suites, 163 tests passed; typecheck and build passed.
- Focused knowledge/agent suites: 3 suites, 13 tests passed.
- Sophia boundary scan: pass, 66 new-product source files.
- Plan JSON parse: pass after the v2.1.2 amendment.

## Remaining P3-A01 work

P3-A01b must establish the private storage/scanning/parser contracts before accepting files, then add the protected lazy-loaded `/sophia-admin/knowledge` UI for source review, errors, grants, publication, preview and retirement. File support must remain disabled until those controls have executable evidence.
