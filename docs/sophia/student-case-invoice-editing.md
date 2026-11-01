# Linked invoice editing

Linked invoices expose an Edit icon for permitted financial users when the locally indexed sales invoice is DRAFT, SUBMITTED or AUTHORISED, with no payments/credits and the whole total outstanding. The full editor changes quantities and prices; Xero allows only a limited set of fields on paid or partially paid invoices, so those invoices do not offer this full-edit action.

Source: [Xero Accounting API — Updating Invoices](https://developer.xero.com/documentation/api/accounting/invoices). Xero also disallows edits in locked periods. Eligibility is checked again against the live invoice and organisation lock dates on open and save. Local list reads do not call Xero. Tax-inclusive, discounted, adjusted, incomplete or oversized line sets are refused rather than silently converting their financial representation; this editor supports the same standard exclusive-tax invoice lines as Create. The existing currency is read-only.

The existing invoice editor opens with current reference/college, advisor, branding, dates, quantities and prices. Payment tracking is retained. Save changes updates the existing invoice with POST to `/Invoices/{InvoiceID}?unitdp=4`; it preserves the existing status and line IDs, omits removed lines and sends new lines without IDs. It does not change the invoice number, approve, email or recreate the invoice. Existing line tracking dimensions are retained, with the advisor category updated when selected.

API:

- `GET /cases/:caseId/invoices/:connectionId/:invoiceId/edit-options` returns scoped form options, live invoice, fingerprint and any resumable request belonging to the reviewer.
- `PUT /cases/:caseId/invoices/:connectionId/:invoiceId` requires financial approval/preparation/case-management permissions, an Idempotency-Key, a matching fingerprint and review confirmation.

The server validates links and contact ownership, dates, college/advisor directory entries, accounting defaults, amounts and existing line IDs. Provider calls happen outside database transactions. The case row lock serializes edit/removal claims; durable edit receipts and two-minute leases prevent overlapping sends. Each write uses a stable provider idempotency key. Response confirmation checks identity, status, totals, lines, tracking and retained line IDs before publishing the local invoice and its export receipt atomically with activity/checklist changes.

Uncertain saves retain their planned input. The same retry first reads the live invoice, confirms an already-applied update without resending, or retries the original provider request. Reopening the editor confirms completed provider writes after local rollback, or restores the original reviewer's pending changes and retry key. Conflicting new changes and deletion are blocked until that request is resolved. Fingerprints detect changes observed between opening and saving; Xero does not provide an atomic compare-and-swap guarantee for this update endpoint, so a change made directly in Xero after the final read can still race the write.

Deploy migration **111_student_case_invoice_edits.sql** with the normal owner migration runner before the API and frontend. It adds a tenant-isolated receipt table; runtime grants remain SELECT/INSERT/UPDATE only. No production migration, deployment or live provider mutation was run.

Local verification: 128 ChromeHeadless editor/case-page tests; 79 connector/client/creation/edit-policy tests; three PostgreSQL integration tests selected by `linked invoice edits|invoice removal|manual invoice` (36 unrelated tests not selected); backend/frontend TypeScript and diff whitespace checks. Tests cover status/settlement gating, prefilled editing, stable line IDs, stale fingerprints, locked periods, permission/tenant/link rejection, idempotent retries, local rollback, deletion blocking and reopening recovery. Provider responses were simulated; production timings and end-to-end Xero writes are not claimed.
