# OFA-07A checkpoint — Xero student discovery

Date: 10 October 2026  
Decision: implemented in source; deployment, Xero re-authorization and live TRUST review remain pending

## Outcome

The Students page now uses the approved prototype direction without inventing unavailable data. It adds operational
summary cards and a Chief Executive-only Xero discovery panel. The panel reads distinct contacts from recent TRUST
sales invoices, shows invoice count, totals, next due payment and payment state, and lets staff review a candidate in
the existing validated student form.

Discovery does not automatically create student records, overwrite staff-maintained fields, infer colleges or
advisors, or write to Xero. The user must review and save each operational record. Contacts without email remain
visibly incomplete and fail the existing required-field validation until corrected.

## Xero contract

- Added granular read-only scopes `accounting.invoices.read` and `accounting.contacts.read`.
- Existing Xero authorizations report missing discovery scopes and require one explicit reconnect.
- `GET /business-packs/student-operations/v1/workspace/integrations/xero/connections/:connectionId/student-candidates`
  remains Chief Executive-only and resolves the connection inside the authenticated tenant.
- The preview requests the 500 most recently updated non-void sales invoices using `summaryOnly=true`, groups them by
  Xero Contact ID, and retrieves contact identity fields in bounded batches.
- A truncated result is clearly labelled. It is not represented as a complete synchronization.

## Performance and security decisions

- The student page never calls Xero automatically. Provider reads occur only after the Chief Executive selects
  **Find students**.
- Summary cards reuse the cached Student Operations dashboard request.
- Invoice responses are lightweight and bounded; Xero provider errors are not exposed to the browser.
- Xero financial facts remain read-only and are not copied into editable student fields.
- No database migration is required for this preview checkpoint.

## Next checkpoint

After reviewing the real TRUST candidate data, define the authoritative contact/reference mapping and implement a
resumable local read model with incremental synchronization, idempotent source links, freshness evidence and a
reviewed bulk-import path. This must not infer that arbitrary Xero contacts are students.

## Evidence run

- Sophia Runtime typecheck and production build: passed.
- Sophia Runtime full suite: 155 suites, 557 tests passed.
- Focused Angular Student Operations suite: 21 tests passed in Chrome Headless.
- Angular application and spec TypeScript checks: passed.
- Angular production build: passed on Node 22.23.2; only existing bundle/font/CommonJS/PrimeIcons warnings remain.
- Protected real-estate regression: 8 suites, 38 tests passed.
- Sophia boundary scan: passed across 266 new-product source files.
