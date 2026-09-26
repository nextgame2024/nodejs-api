# P3-03 checkpoint — Business Manager real-estate connector

Date: 2026-09-24 (Australia/Brisbane)

## Outcome

The Business Manager real-estate connector now maps the shared knowledge, catalog, availability, booking, delivery and workflow-status ports to protected authoritative Business Manager HTTP APIs. Runtime code does not import Business Manager models or query `bm_*` tables, and no runtime booking table was introduced.

The connector uses strict response DTOs, binding-matched opaque resource references, cursor pagination, exact inspection-slot revalidation, durable review hashes, stable command IDs, authoritative receipts and polling-based status/reconciliation. Business Manager continues to enforce the credential scope and derives `companyId` from the authenticated connector credential rather than request input.

## Authority and failure behavior

- Property values, photographs, inspection capacity, bookings, delivery state, report jobs and agency knowledge remain Business Manager-owned.
- Missing property values are omitted from capability extensions and are not inferred.
- The former hardcoded agency-knowledge fallback was removed. An unavailable authoritative source now fails closed.
- Booking and resend commits consume the exact durable reviewed payload before mutation.
- A missing command receipt returns `outcome_unknown`; the runtime does not repeat an ambiguous mutation.
- Status endpoints are read-scoped and company-filter every Business Manager query.

## Plan correction

Plan version 2.1.5 records that the original reusable port types could not safely implement durable reviews: `CapabilityContext` lacked `sessionId`, prepare did not return its durable command ID, and commit carried no reviewed payload to re-hash. Those fields are now explicit. Real-estate output fields that Business Manager legitimately permits to be missing are also optional instead of model-filled.

## Verification

- Sophia Runtime typecheck/build: pass.
- Sophia Runtime full suite: 45 suites, 175 tests passed.
- Focused connector/client/capability suite: 5 suites, 25 tests passed.
- Protected real-estate suite: 7 suites, 32 tests passed.
- Contract suite: 15 tests passed.
- Boundary scan: 84 new-product files passed.
- Backend release suite: 16 suites and 66 tests passed; 12 existing SQL-gated tests skipped.

## Remaining evidence limit

No confirmed disposable Business Manager PostgreSQL environment was available for destructive/contention RE-01–RE-06 execution. Deterministic service, connector, capacity, queue, report and delivery fixtures passed, but the SQL-gated cases remain skipped. This is recorded as an evidence limitation rather than a fabricated database pass.
