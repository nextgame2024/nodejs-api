# Standard PTY commission release

Both organisations create unsent ACCREC **DRAFT** invoices with tax-exclusive lines. TRUST uses the student contact and college reference. PTY uses one confirmed college contact and the student reference. Xero assigns invoice numbers.

Current active college rules apply under the user's confirmed initial policy. `not_recorded` cashback/bonus means no benefit. Specified benefits, conditional classification/location/program rules, ambiguous rules and unsupported application conditions block automatic commissions. The first release supports unrestricted fixed tuition percentages only. Integer cents are summed across tuition lines and rounded half up once per instalment; enrolment, materials, conditional transfer fees and other charges are excluded.

PTY inherits the corresponding TRUST tuition item code, resolves the unique matching item in the PTY catalogue and uses that PTY item's sales account, the local catalogue's exact GST on Income rate, branding `PTY Open for Australia Account` and a per-instalment Type of Sale selected from the active PTY Xero category, defaulting to `Instalment`. No TRUST Payment Track is copied. Initial dates match the source TRUST dates. Invoice dates, fully paid dates and individual payment/allocation dates remain distinct during sync.

## Release order

1. Run `node scripts/student-pty-release.mjs --check` with the migration-owner connection. This is read-only and checks the migration ledger and college-rule schema. It never changes the Runtime app's database role.
2. Run the same helper with `--apply`. It applies only migrations 127, 128 and 129, atomically, with a five-second lock timeout. It does not run unrelated pending migrations. If an operating organisation is already enabled before migration 127, it refuses that cutover until the updated shared worker is deployed. Existing production preflight found zero enabled operating organisations at the initial cutover. Migration 129 adds only the narrow, tenant-filtered legal/trading-name/acronym reader.
3. Deploy Runtime API, the shared student sync worker and frontend from the tested commits. Keep the shared worker on `sophia_runtime_app` and its existing schedules, leases, checkpoints, quotas and rate-limit controls. No extra cron is added.
4. In Company, explicitly assign the correct Xero connection to PTY. Refresh imports through the existing durable pipeline. No organisation is inferred or reassigned by a viewing request.
5. In Sync colleges, review the PTY college mappings. Imported contacts include contacts with no invoices, allowing a college recipient to be confirmed before its first commission. When several historical contacts map to one college, confirm the intended recipient for new commission invoices.
6. Open Prepare invoices and review alternating TRUST/PTY tabs. Select the tuition item on TRUST; its matching PTY item appears read-only. Save drafts includes ready pending commissions after saving the TRUST source. Bulk creation automatically includes them and drains TRUST first. Individual PTY creation independently requires its matching confirmed TRUST receipt and checks the current source invoice in Xero.

The backend and frontend source changes do not themselves create financial records. Initial historical import is an explicit organisation/refresh operation. Historical invoices retain their contact, reference, dates, balances, lines and supplied payment/allocation snapshots; unknown college mappings remain unresolved. Existing historical TRUST/PTY pairs are not guessed from names or references. Permanent automatic pairs are established for invoices created through the reviewed preparation workflow.

## College name matching

Following the user's approval on 11 November 2026, completed PTY imports match active contacts against each eligible college's legal name, trading name and stored acronym. Client-added `- number`, MAIN PROV/NO MAIN labels, dated suffix annotations, punctuation, accents, `&`/`and` and legal suffixes are normalised. Stored comma/semicolon-separated trading-name lists are treated as individual aliases. Strong unique normalised matches are accepted. A distinctive brand signature may also match when the remaining words are generic education/country descriptors and that signature identifies only one college across all aliases. A full name with its own repeated acronym is recognised. Other names require at least 90% combined similarity and an eight-percentage-point lead over the next college. A token index and at most twelve detailed candidate comparisons per contact avoid an all-pairs scan.

Aliases belonging to one college are one identity. Aliases shared by different colleges, weak names and unrecognised short acronyms remain pending. Multiple historical contacts can map to the same college identity. For new commissions, one explicitly human-confirmed recipient takes precedence over automatic identity links; several human-confirmed recipients remain blocked for review. Existing mappings and explicit other/unresolved decisions are preserved. Automatic links and confidence/method metadata are written with immutable audit events in one bulk statement after sync; no extra Xero requests or per-row background jobs are added. Human and automatic decisions share an organisation-scoped lock. The manual selector exposes legal name, trading name and acronym, and prepares its options once per response.

## Recovery and performance

The local database serves previews, registers, college matching, related-invoice navigation and settlement details. Tab switches do not call Xero. The full PTY catalogue is read once per export request; per-invoice claims use small revision checks. Three workers share one request-scoped session per organisation, including token/settings lookups. Large catalogues are not returned twice in option payloads. Register filters are saved separately per organisation and stale responses are cancelled.

Each PTY receipt is unique by source TRUST invoice and target organisation. Database checks enforce the source receipt, tenant scope and immutable confirmed identities/calculations. Unknown Xero outcomes stay `review_required`/`creating`; they are never automatically resent. Check PTY in Xero uses exact contact/date/payload matching after the active request window. Multiple exact matches require operator review. Successful TRUST invoices remain recorded if their commissions fail.

Later source voids/amount changes are flagged in the preparation view; there is no automatic credit, cancellation or replacement of a financial document. A changed source is blocked before a new PTY send. Related invoices are navigable through the Payments detail modal after normal indexing. Payment and allocation snapshots are replaced during full invoice imports, not appended, preventing duplicate entries; omitted summary data preserves the previous snapshot.

Xero field semantics were checked against the official [Invoices API](https://developer.xero.com/documentation/api/accounting/invoices) and [Payments API](https://developer.xero.com/documentation/api/accounting/payments).

### Sync colleges follow-up (verified locally, release pending)

College review now lives at `/manager/sync-colleges`, beside Sync users, rather than below Payments and Control. Existing Chief Executive Sync users entitlements expose the sibling navigation item; Runtime still enforces `integrations.manage` on every queue/mapping request. Release the Business Manager API, Runtime API and frontend together. No migration is required.

The default queue is unresolved ACTIVE contacts with visible PTY sales. All-active and all-imported scopes remain available for new recipients and archived history. Transaction counts follow the Payments register's document/status/latest-full-import rules. The queue aggregates local transactions once per request and the browser loads the stable college selection directory only on the first request per organisation.

Read-only verification on 11 November: 1,548 active and 130 archived contacts (1,678 imported); 7,342 visible sales documents across 569 recipients; 4,951 documents linked to colleges; 496 unresolved active sales contacts. These are contact and sales-document counts, not interchangeable pending totals. Insurance companies, individuals and other businesses should be classified separately rather than forced into college mappings.

### Simplified invoice preparation (12 November 2026)

Deploy Runtime before the frontend: commission preparation now accepts sequence-only selections and derives each PTY item from the saved corresponding TRUST tuition code. Supplied legacy item IDs must match that derived item. Missing or ambiguous PTY codes and multiple different tuition codes in one instalment remain pending instead of guessing. No schema migration is needed.

Per-invoice actions are named Create Xero Invoice and align right. PTY creation remains disabled until that exact TRUST sequence has a confirmed Xero creation receipt. The general Create Xero invoices action uses the existing ordered orchestration; Xero invoices remain unsent DRAFT. Individual TRUST creation remains independent when PTY configuration is unavailable.

### Shared invoice header, PTY table and inherited quantity (12 November 2026)

The active invoice number, organisation and status share one header style immediately before Close. PTY follows the TRUST fields/table/totals layout, including responsive cards. PTY quantity comes from the corresponding positive TRUST tuition lines for the matched item; price is the rounded commission divided by that quantity. For tuition 3,840, quantity 12 and commission 25%, the saved Xero line is quantity 12, unit amount 80.00, net 960.00, GST 96.00 and total 1,056.00.

Unit prices use up to four decimals and integer arithmetic. A total that cannot retain both the source quantity and the exact rounded cents is held for review. The creation gate rejects pending legacy one-unit payloads until re-prepared; created and unknown-outcome payloads remain unchanged for safe reconciliation. Deploy Runtime first, then frontend. No migration or worker configuration change is needed.

### Selectable PTY Type of Sale and compact tabs (12 November 2026)

The existing durable catalogue importer now caches the active PTY Type of Sale options. One metadata backfill is claimed for existing PTY snapshots without tracking metadata; failures retain normal lease, quota and retry backoff. Normal daily imports maintain freshness. Previews and tab changes read only the local catalogue. Creation validates each saved choice against current cached and live options, sharing one live tracking lookup per request session. Existing clients that omit a choice retain the Instalment default.

The local frontend uses the shared selector per PTY instalment, restores saved selections, and locks created or unknown-outcome values. Smaller invoice tabs retain touch targets and use a green active background in light/dark modes. Per the user's explicit instruction, deploy only the backend now; keep this frontend follow-up local and unpublished. No migration or new worker schedule is required. The shared worker must run the updated backend source to import the option metadata.
