# TRUST register reconciliation — 10 October 2026

## Scope and observed mismatch

The operator's Xero TRUST screenshot reports All **7,793**, Draft **1,277**,
Awaiting approval **14**, and Awaiting payment **652**. These are observed
comparison targets, not values to hardcode into the application.

Read-only live checks used `sophia_runtime_app`, the configured tenant context,
and the existing TRUST connection. No credentials, contact details, or invoice
line items were exported.

Before reconciliation, the local read model contained:

| Invoice status | Sales invoices |
| --- | ---: |
| DRAFT | 1,277 |
| SUBMITTED | 14 |
| AUTHORISED | 582 |
| PAID | 5,672 |
| VOIDED | 292 |
| DELETED | 3,150 |

Active sales invoices therefore totalled **7,545**. Including VOIDED produced
**7,837**, explaining the two previous BM totals. Neither is evidence that the
Xero register has been reconciled. All invoice contacts matched the local
contact table; a missing-contact join was not responsible for this difference.

No credit notes, prepayments, or overpayments had been backfilled. The last full
run completed at 08:22 UTC, before the supplemental-resource implementation.
The later 10:23 UTC success was an incremental check importing zero records,
not a full historical refresh.

## Recovery and verification

One full reconciliation was enqueued through the existing durable queue,
without deleting records or writing to Xero. Run:
`24eea1dc-86ef-420e-a6de-fbe0e71401e6`.

The public read-model response now includes status totals computed over the
same filtered register as pagination, not just the current page. BM displays
Draft, Awaiting approval, Awaiting payment, and Paid counts. Freshness now
distinguishes the last successful check from the last full reconciliation.
The UI does not assert that the register matches Xero merely because a sync
completed.

No schema migration is required for these additions. Backend/frontend source
deployment is required for the new status/freshness display.

## Confirmed authorization blocker

The live run failed at **11:10:29 UTC** with `xero_authorization_rejected`,
provider status **401**, correlation ID `c1934f59-97ef-4be9-897f-4f4119ee9033`.
It processed 10,987 invoices and 35 credit notes, then failed on prepayments.
Credit notes comprise 2 AUTHORISED, 29 PAID, and 4 VOIDED. The existing token
grants invoice/contact/settings reads but **not `accounting.payments.read`**.
Xero's granular payments scope covers Prepayments and Overpayments; invoice
permission alone does not authorize these endpoints.

The fix adds `accounting.payments.read` to OAuth consent and to the connection
capability check. Missing permission is detected before provider pagination
and produces the reconnect-required error rather than a generic sync failure.
The Company reconnect warning names the additional document types.

Required operator steps:

1. Deploy the updated runtime and frontend.
2. Company → Reconnect Xero → authorize the existing TRUST organisation.
3. Students → Refresh once, and wait for a successful full reconciliation.
4. Compare All 7,793 / Draft 1,277 / Awaiting approval 14 / Awaiting payment 652
   against a contemporaneous Xero screen. Do not claim parity until verified.

No records were deleted and no Xero data was modified. The 31 active credit
notes are confirmed; the remaining prepayment/overpayment counts are blocked
by consent and are **not yet verified**.

Scope reference: [Xero's granular scope mapping](https://github.com/XeroAPI/xero-prompt-library/blob/main/python/SKILL.md#scopes).

The actual compiled BM list service, executed read-only against the live tenant
after this failed run, returns **7,576**: 7,545 invoices + 31 credit notes.
Status totals: Draft 1,277 / Awaiting approval 14 / Awaiting payment 584 /
Paid 5,701. The remaining total gap is **217**, not yet attributed to verified
prepayment/overpayment records. The failure is visible and the successful/full
refresh timestamps have not advanced.

Validation: all 158 runtime suites / 582 tests passed; runtime build passed;
16 focused Students UI tests passed; frontend TypeScript check and production
build passed (existing bundle/font/CommonJS/PrimeIcons warnings). Added text
uses the existing wrapping header and mobile/dark/light styles; no separate
live mobile-browser visual verification was performed.
