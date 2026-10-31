# Manual invoice creation from a case

The Linked invoices header now offers **+Create** for users with invoice-creation permission when invoice creation is enabled and the case is not closed. It opens the existing invoice editor in manual mode, with one blank line, blank issue/due dates, advisor and reference. The student is fixed to the case, currency defaults to AUD, Payment Track stays PENDING, and the conditional fee defaults to not applied.

Options are fetched only when opening the form, from the existing tenant-scoped advisor directory and local sales catalogue; opening never saves a draft or contacts a provider. The manual reference and currency are editable. There is no requirement for an approved offer or an unresolved offer instalment. The existing offer preparation action remains available separately.

After field validation and explicit review confirmation, the API saves a manual draft with an idempotency key and creates its invoice using the existing export pipeline. Provider claims, item/account/tax validation, contact resolution, stable provider keys, ambiguous-outcome reconciliation, register projection, and linked-invoice refresh are reused. The modal closes after successful creation. The approved offer's schedule and drafts are not modified.

Endpoints:

- `GET /cases/:caseId/manual-invoice-options`: case version, student, advisors and current catalogue; no provider requests.
- `POST /cases/:caseId/manual-invoice-drafts`: one reviewed invoice, reference, currency, advisor and catalogue identity/version, plus Idempotency-Key.
- The existing `POST /cases/:caseId/invoice-drafts/:batchId/xero` creates the saved manual invoice.

Manual batches have `offer_id=NULL` and an explicit case foreign key. Offer batches retain their original offer ownership, version and current-offer checks. Updates to manual batches reject stale revisions and any export already creating, created, or held for review. Permissions and closed-case checks are enforced by the server, and creation requires the existing `payments.approve` permission and feature flag.

Apply **110_student_manual_invoice_drafts.sql** through the normal owner migration runner before deploying the backend, then deploy the frontend. This is additive to migration 109. No production migration, deployment, or live invoice creation was performed locally.

Verification: 19 existing backend draft/export tests; a real PostgreSQL test covering manual preparation without an offer, invalid permission/catalogue rejection, idempotent saving and creation, list projection and duplicate-send prevention; 116 combined invoice-editor/case-page ChromeHeadless tests; backend/frontend TypeScript checks.
