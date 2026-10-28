# Invoice indexing and event-driven financial checklist

Apply Runtime owner migrations 104 and 105 in sequence, after existing migrations through 103. Use the existing Runtime migration runner (`npm run migrate` from the compiled Runtime package), with the approved migration-owner connection and configured schema. These migrations have not been applied to production by Codex.

Then deploy the Runtime API and shared student-sync worker together, and deploy the frontend. Existing document-workflow/checklist and worker tenant-scope configuration remains required; no new feature flag or provider write is introduced.

Migration 104 provides a narrowly scoped identity-registration function. It derives the student reference and company from the current tenant's existing case, user link and active account, rather than accepting arbitrary identity fields. Runtime still has no direct shared-identity-table grants. This satisfies the production invoice/student foreign key before a new invoice is sent to Xero. Actual verified invoice responses are retained with the durable creation receipt.

The shared worker recovers confirmed but unindexed invoices in batches of at most three. It replays a retained verified response locally, or, for older receipts, reads the exact existing invoice ID through normal Xero quota/auth policy. It never creates or resends an invoice. Attempts are fenced, delayed and capped at eight; exhausted work produces a review state, not an endless checking indicator. Already indexed and linked invoices require no provider request. This also recovers the existing eight test invoices after deployment; do not delete or recreate those invoices.

Migration 105 caches financial validation and marks it dirty only on relevant offer, draft, receipt or indexed-invoice changes. The existing worker scans dirty work; its periodic document-expiry sweep reuses unchanged financial results. Normal checklist GETs read cached financial results and never call Xero or repeat invoice comparisons. Payment milestones remain completed after the case advances; later payments do not reopen the original PENDING milestone.

After all reviewed invoices are indexed and match the reviewed offer and each financial line has confirmed PENDING tracking, both financial actions complete and the case advances to Awaiting Payment while remaining Pre-sale. Incomplete batches show a waiting reason; missing details show awaiting indexing; mismatches or exhausted recovery show review guidance. Only actual document analysis uses Checking.

Validation uses disposable PostgreSQL with the production-shaped `bm_xero_student_identities` foreign key and no application-role grants on that table. It reproduces SQLSTATE 23503 before registration and verifies immediate indexing, tenant refusal, eight-invoice recovery without duplicate sends, receipt-local replay, unchanged-data cache reuse, source-change invalidation, stage advancement and preservation of newer nightly-sync data.
