# Case stages and case statuses

This change concerns cases only, not invoice statuses or payment tracking.

| Case stage | Allowed case statuses |
| --- | --- |
| Imported — Pending Review | In progress (existing imported cases only) |
| Documents Requested | Pre-sale, On hold |
| Verified Documents | Pre-sale |
| Awaiting Payment | Pre-sale, On hold |
| Payment Monitoring | Awaiting Payment, Payment Received, Payment overdue, In collections, Payment complete |
| Payments Complete | Closed |

Payment Received and Invoices Created are no longer case stages and are not shown as progress steps. Regular cases show five steps; existing imported cases additionally show Imported — Pending Review.

Apply Runtime owner migration 106 before deploying the Runtime API and frontend. It changes allowed stage/status CHECK constraints only: it performs no backfill, record updates, audit inserts or invoice changes. Existing imported cases remain In progress / Imported — Pending Review. No worker or synchronization change is required.
