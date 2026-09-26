# P3-A01b1 checkpoint — managed-text Admin workspace

Date: 2026-09-24 (Australia/Brisbane)

## Outcome

The protected ADM-06 managed-text operator surface is available at `/sophia-admin/knowledge` as a lazy-loaded Angular feature. It resolves the tenant and permissions through the server-side Sophia Admin context, then supports source creation, bounded text ingestion, revision review, approval, capability-granted publication, published-snapshot retrieval preview and explicit source retirement.

The backend now exposes tenant-scoped knowledge capability-binding discovery and revision review. Binding discovery returns identifiers and profile labels only; it does not expose connector credentials or configuration secrets. Revision content remains behind `knowledge.read` and the existing Admin membership/tenant guard.

## Evidence-driven plan correction

The existing S3 code is owned by the legacy Express application, shares configuration with public assets, and includes an unauthenticated avatar/image presign route. Sophia Runtime has no separately configured private document store, malware scanner deployment or isolated parser worker. It would be unsafe to route Admin knowledge files through that surface.

Plan version 2.1.3 therefore divides the remaining work:

- P3-A01b1 (complete): protected managed-text Admin UI and safe backend discovery/review endpoints.
- P3-A01b2 (not started): Sophia-owned private object storage, malware scanning, durable isolated parsing and bounded file controls after deployment verification.

The UI presents the file gate as locked. It does not upload file bytes, issue object URLs, call the public upload route or imply scanning is active.

## Security properties

- The browser gets its tenant ID from `/api/admin/v1/context`; changing the tenant URL still fails in the server guard.
- Business Manager credentials are attached explicitly only to the Sophia Admin origin and are revalidated by the identity bridge.
- Route guards are navigation assistance only; every backend operation retains named permission and tenant enforcement.
- Publication choices come from enabled tenant `knowledge` capability bindings rather than operator-entered UUIDs.
- Retrieval preview requires both a published snapshot and one of its stored capability grants.
- No student implementation, arbitrary URL fetch, public upload path or embedding vendor was added.

## Verification

- Sophia Runtime: typecheck and build passed; 42 suites and 165 tests passed.
- Angular application typecheck and production build passed. Existing bundle/font/CommonJS/PrimeIcons warnings remain unchanged release hygiene work.
- Sophia Admin focused ChromeHeadless tests: 5 passed.
- Combined Sophia Runtime/Admin ChromeHeadless suite: 15 tests passed.
- Backend boundary scan: 72 new-product source files passed.
- Protected real-estate tests: 30 passed.
- Runtime contract tests: 15 passed.
- Backend release tests: 16 suites and 66 tests passed; 12 existing SQL-gated tests skipped.

## Next step

P3-A01b2 should first define the storage/scanner/parser ports and deployment readiness gate. File-presign and completion APIs must remain unavailable until a configured private store and scanner pass executable health checks; parsers must consume quarantined objects through a bounded worker rather than the request process.
