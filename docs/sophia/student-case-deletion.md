# Permanent case deletion and case controls

The related-case card uses a green restore/history icon for archived cases, smaller 32px desktop buttons (44px touch targets), and a permanent Delete action with native confirmation. Archived cases sort last on the server before pagination and stay last when related pages merge in the browser. Eligible linked-invoice actions and Create remain visible but disabled for archived/deleting cases; write endpoints continue enforcing the case guard.

`POST /cases/:caseId/delete` requires `{recordVersion,confirmed:true}`, an Idempotency-Key, and cases.manage/payments.prepare/payments.read_all. Deletion preserves the student account, its identity links, other cases and shared provider projections. It deletes this case's documents, analysis/reviews, offer courses/fees/instalments, draft batches/exports, upload/replacement/delete receipts, schedule, invoice links, checklist, activity and case row. A minimal tenant-scoped deletion receipt survives, with provider targets cleared, so lost responses remain retryable. Provider document files are retained with their contact; this action does not delete external document files.

Before provider changes, the API verifies permissions, optimistic version, case access, live work leases, invoice identities and unsettled statuses. Unconfirmed invoice creation receipts must be reconciled first; permanent deletion cannot abandon unknown provider invoices. Shared invoices and contacts mapped to another student are refused. Draft/submitted invoices become DELETED; unpaid, uncredited AUTHORISED invoices become VOIDED. Paid/credited/protected invoices prevent deletion. Every known invoice is read before the first write. Independent invoice work uses three workers, drains in-flight work on failure and uses stable provider keys.

**Contact rule:** excluding the case being deleted, if any case for the same student is not archived, retain active contacts. Otherwise archive the student's known billing/document contacts. Archived sibling cases remain stored. The student profile lock serializes this decision with creation/restoration; unfinished deletion prevents a new case/restore from invalidating the decision.

A durable deletion claim freezes the target case. Preflight failures before provider mutation unfreeze it. Once mutations may have started, it remains read-only until Delete is retried and completes. Retries re-read actual provider statuses rather than resending confirmed deletions; expired leases are reclaimable and concurrent initial requests cannot steal a live lease. All provider writes complete before local purge. When enabled, encrypted temporary analysis copies are removed before purge. Queued analysis/discovery excludes deleting cases; checklist automation does not advance them.

Migration 113 adds the deletion receipt, deleting marker and archive-order index. Local purge uses one narrowly scoped SECURITY DEFINER function with an explicit tenant/job/token check and fixed search_path. Runtime retains its normal non-BYPASSRLS role and receives no table DELETE grants. Case activity remains append-only except its FK cascade when that case is permanently purged; no global trigger disabling is used. Unknown future FK dependencies fail the local transaction rather than cascading across unrelated data.

Deploy `113_student_case_deletion.sql` through the owner migration runner **before** the Runtime API and frontend. Existing migration 112 is required. No production migration, provider mutation or deployment was performed during implementation.

Verification (2026-11-01):

- 137 focused case-page/invoice-editor ChromeHeadless tests passed at the normal test viewport, including restore icon, disabled invoice actions, sorting, cancel/confirm, retry identity and light/dark controls.
- Narrow-mobile case-page run: 91 passed. Wide-desktop run: 134 passed and three existing discovery/activity layout assertions failed. A separate temporary checkout of unchanged committed frontend reproduces exactly those three failures (79 passed); new control tests pass at desktop size.
- Four disposable PostgreSQL tests passed (37 unrelated tests skipped): archive/restore, permanent deletion of the full document/review/offer graph, role/tenant/version checks, paid-invoice refusal, shared-contact policy, simultaneous Delete requests, lost-provider-reply recovery, retained sibling/account, expired analysis leases and bounded analysis admission.
- 63 mocked API/provider tests passed across Xero client, invoice creation and analysis worker suites, including contact archive serialization/status verification and safe upstream error classification.
- Runtime TypeScript, production frontend build and both repository diff checks passed. The build reports existing CommonJS/stylesheet warnings.

Sources: [Xero invoices](https://developer.xero.com/documentation/api/accounting/invoices), [Xero contacts](https://developer.xero.com/documentation/api/accounting/contacts).
