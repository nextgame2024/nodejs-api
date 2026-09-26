# P3-A01b2a checkpoint — private file-ingestion foundation

Date: 2026-09-24 (Australia/Brisbane)

## Outcome

The repository-side private knowledge file pipeline is complete and remains fail-closed pending deployment resources. ADM-06 can show and use bounded file controls only when Sophia Runtime verifies both its dedicated private object store and authenticated malware scanner.

The initial file set is deliberately narrow: `.txt` and `.md`, at most 1 MiB uploaded and 256 KiB after strict UTF-8 parsing. PDF, Office, archives, images, HTML, arbitrary URLs and universal document parsers remain unsupported.

## Pipeline

1. An authorised Admin requests an intake for an active managed-text source with filename, type, exact byte length, SHA-256 checksum and idempotency key.
2. Runtime verifies all S3 Public Access Block controls and scanner health before creating the intake.
3. Runtime generates a non-public quarantine key and returns a short-lived PUT signed for exact type, length, checksum, server-side encryption and quarantine metadata. It never returns a GET URL.
4. Completion verifies object size, type and checksum metadata. Mismatches are quarantined and deleted.
5. A separately deployed tenant-scoped worker claims durable jobs under `sophia_runtime_app` and FORCE RLS using `FOR UPDATE SKIP LOCKED` leases.
6. The worker downloads only the declared bounded bytes, recomputes SHA-256, scans them, and never passes infected bytes to the parser.
7. Clean text is parsed in a resource-limited worker thread with fatal UTF-8 decoding and control-character/output bounds.
8. Only then is a ready draft knowledge revision created. Quarantined objects are deleted; transient processing failures retry no more than three times.

## Plan corrections

Plan version 2.1.4 records two evidence-driven corrections:

- A global worker cannot discover all tenant queues while preserving FORCE RLS. Workers are explicitly tenant-scoped through `SOPHIA_KNOWLEDGE_WORKER_TENANT_ID`; owner/BYPASSRLS credentials are prohibited.
- The initially matched workspace AWS SDK versions had a critical transitive XML parser advisory, and Nest 12.0.1 retained high-severity Multer advisories. AWS packages were updated to 3.1139.0 and aligned Nest packages to 12.1.0. The production dependency audit now reports zero known vulnerabilities.

P3-A01b2 is divided into repository-complete P3-A01b2a and deployment-gated P3-A01b2b.

## Database evidence

Migration `016_private_knowledge_file_intake.sql` was applied to the configured Neon PostgreSQL database. Rollback-only verification confirmed:

- `sophia_runtime_app` remains non-superuser and `BYPASSRLS=false`.
- The runtime role has the intended intake-table privileges.
- Cross-tenant reads returned zero rows and cross-tenant inserts were denied.
- No verification rows were retained.

## Verification

- Sophia Runtime typecheck/build: pass.
- Sophia Runtime full suite: 44 suites, 171 tests passed.
- Compiled isolated parser worker smoke: pass (`bounded-utf8-v1`).
- Production dependency audit: zero vulnerabilities.
- Angular production build: pass with the existing bundle/font/CommonJS/PrimeIcons warnings.
- Combined Sophia Runtime/Admin ChromeHeadless suite: 16 tests passed.
- Boundary scan: 81 new-product source files passed.
- Protected real-estate tests: 30 passed.
- Runtime contract tests: 15 passed.
- Backend release tests: 16 suites and 66 tests passed; 12 existing SQL-gated tests skipped.

## Remaining activation gate

P3-A01b2b needs infrastructure authority and deployment configuration not present in the repository: a dedicated private bucket, authenticated scanner service, one worker deployment per activated tenant, and live clean/infected/mismatch/retry verification. Until that evidence exists, `/files/readiness` reports disabled and the UI cannot initiate an upload. The existing public Business Manager asset bucket and unauthenticated upload route were not reused or modified.
