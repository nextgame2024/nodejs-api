# Standard PTY commission release

Both organisations create unsent ACCREC **DRAFT** invoices with tax-exclusive lines. TRUST uses the student contact and college reference. PTY uses one confirmed college contact and the student reference. Xero assigns invoice numbers.

Current active college rules apply under the user's confirmed initial policy. `not_recorded` cashback/bonus means no benefit. Specified benefits, conditional classification/location/program rules, ambiguous rules and unsupported application conditions block automatic commissions. The first release supports unrestricted fixed tuition percentages only. Integer cents are summed across tuition lines and rounded half up once per instalment; enrolment, materials, conditional transfer fees and other charges are excluded.

PTY uses the selected PTY item's sales account, the local catalogue's exact GST on Income rate, branding `PTY Open for Australia Account` and Type of Sale `Instalment`. No TRUST Payment Track is copied. Initial dates match the source TRUST dates. Invoice dates, fully paid dates and individual payment/allocation dates remain distinct during sync.

## Release order

1. Run `node scripts/student-pty-release.mjs --check` with the migration-owner connection. This is read-only and checks the migration ledger and college-rule schema. It never changes the Runtime app's database role.
2. Run the same helper with `--apply`. It applies only migrations 127 and 128, atomically, with a five-second lock timeout. It does not run unrelated pending migrations. If an operating organisation is already enabled, it refuses this cutover until the updated shared worker is deployed. Existing production preflight found zero enabled operating organisations.
3. Deploy Runtime API, the shared student sync worker and frontend from the tested commits. Keep the shared worker on `sophia_runtime_app` and its existing schedules, leases, checkpoints, quotas and rate-limit controls. No extra cron is added.
4. In Company, explicitly assign the correct Xero connection to PTY. Refresh imports through the existing durable pipeline. No organisation is inferred or reassigned by a viewing request.
5. In Payments and Control, choose PTY and review college mappings. Imported contacts include contacts with no invoices, allowing a college recipient to be confirmed before its first commission. Multiple active contacts mapped to the same college require correction before creation.
6. Open Prepare invoices, review alternating TRUST/PTY tabs, choose a PTY sales item and opt into commissions. Bulk creation drains TRUST first. Individual PTY creation independently requires its matching confirmed TRUST receipt and checks the current source invoice in Xero.

The backend and frontend source changes do not themselves create financial records. Initial historical import is an explicit organisation/refresh operation. Historical invoices retain their contact, reference, dates, balances, lines and supplied payment/allocation snapshots; unknown college mappings remain unresolved. Existing historical TRUST/PTY pairs are not guessed from names or references. Permanent automatic pairs are established for invoices created through the reviewed preparation workflow.

## Recovery and performance

The local database serves previews, registers, college matching, related-invoice navigation and settlement details. Tab switches do not call Xero. The full PTY catalogue is read once per export request; per-invoice claims use small revision checks. Three workers share one request-scoped session per organisation, including token/settings lookups. Large catalogues are not returned twice in option payloads. Register filters are saved separately per organisation and stale responses are cancelled.

Each PTY receipt is unique by source TRUST invoice and target organisation. Database checks enforce the source receipt, tenant scope and immutable confirmed identities/calculations. Unknown Xero outcomes stay `review_required`/`creating`; they are never automatically resent. Check PTY in Xero uses exact contact/date/payload matching after the active request window. Multiple exact matches require operator review. Successful TRUST invoices remain recorded if their commissions fail.

Later source voids/amount changes are flagged in the preparation view; there is no automatic credit, cancellation or replacement of a financial document. A changed source is blocked before a new PTY send. Related invoices are navigable through the Payments detail modal after normal indexing. Payment and allocation snapshots are replaced during full invoice imports, not appended, preventing duplicate entries; omitted summary data preserves the previous snapshot.

Xero field semantics were checked against the official [Invoices API](https://developer.xero.com/documentation/api/accounting/invoices) and [Payments API](https://developer.xero.com/documentation/api/accounting/payments).
