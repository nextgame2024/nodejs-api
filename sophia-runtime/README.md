# Sophia Runtime API

NestJS TypeScript service for Sophia realtime assistant sessions, provider adapters, avatar adapters, and trusted business tools.

This service is intentionally separate from the existing Express API in `backend/src`.

Runtime target: Node 22.

## Local Setup

```bash
cd backend/sophia-runtime
fnm use 22.23.2
npm install
cp .env.example .env
npm run migrate
npm run build
npm test
npm run start:dev
```

For Phase 1, `SOPHIA_RUNTIME_DATABASE_URL` can point to the existing Neon database while using `SOPHIA_RUNTIME_SCHEMA=sophia_runtime`. For production, prefer a dedicated Sophia Runtime Neon database or project.

Runtime connections must use `SOPHIA_RUNTIME_DATABASE_ROLE=sophia_runtime_app` (or a directly authenticated equivalent role) so PostgreSQL row-level security is enforced. The migration connection remains the schema owner and deliberately does not assume this role. Never run the application with an owner, superuser or `BYPASSRLS` effective role.

## Render

Create a separate Render service scoped to `backend/sophia-runtime`.

Build command:

```bash
npm ci && npm run build
```

Start command:

```bash
npm run start
```

Run migrations before deployment:

```bash
npm run migrate
```

Do not copy secrets into Angular. Browser clients should call this runtime API for short-lived session metadata only.

## Xero connector foundation

Xero uses a shared, multi-tenant OAuth 2.0 connector. A Student Operations Chief Executive can begin consent through
`POST /api/business-packs/student-operations/v1/workspace/integrations/xero/authorization`.
The registered Xero callback must exactly match `XERO_REDIRECT_URI`; locally it is
`http://localhost:3400/api/connectors/xero/v1/oauth/callback`.

Configure `XERO_CLIENT_ID`, `XERO_CLIENT_SECRET`, `XERO_REDIRECT_URI`, `XERO_RETURN_URL`,
`XERO_OAUTH_STATE_SECRET`, `XERO_TOKEN_ENCRYPTION_KEY`, and `XERO_WEBHOOK_KEY` only in the runtime environment.
The connector requests identity, offline access, `accounting.settings.read`, `accounting.invoices.read`, and
`accounting.contacts.read`. It can verify the selected organisation, list bank-account metadata, and produce a
tenant-scoped read models from paged sales invoices and contacts. By default it cannot write accounting data.
Existing connections must be re-authorized when the invoice/contact scopes are introduced. Each Xero
organisation is persisted as a tenant-scoped connector binding, allowing one agency to connect TRUST and operating
organisations independently and allowing other agencies to connect their own organisations later.

Normal Students page, search, and infinite-scroll requests read PostgreSQL only. A Chief Executive can enqueue a
durable refresh with `POST .../student-sync`; the scheduler performs initial/incremental/reconciliation paging and
the UI keeps the last successful projection when Xero is unavailable. The legacy inline scheduler uses
`XERO_SYNC_SCHEDULER_ENABLED=true`. For the opt-in shared nightly worker and
API enqueue-only cutover, follow [the worker runbook](../docs/sophia/student-sync-worker-cutover.md);
do not leave the legacy scheduler enabled after that cutover. Configure the Xero webhook endpoint as
`/api/connectors/xero/v1/webhooks`; signed events coalesce into the same durable queue. Candidate acceptance links a
Xero contact to a reviewed operational student without writing to Xero.

### Student document storage: primary Contact and first upload

Apply owner migration `090_student_primary_xero_contacts.sql` after 089. It adds an RLS-protected,
student/organisation primary destination and a narrow tenant-filtered projection of existing reviewed Contact
links. It does not change users, passwords, historical Contacts, invoices or documents, or call Xero.

Chief Executive/Operations document-management permissions are unchanged. On the first explicit upload for
a saved student, the API selects the active Contact used by the most recent non-void/deleted invoice in the
active TRUST organisation and persists it across all the student's cases. An exact Sophia external reference
takes precedence; an explicitly reviewed Contact link without invoices can also be reused. Ties/no invoice
dates use provider last-updated time, then Contact ID. Xero does not expose a dependable creation date.
The persisted primary is not repicked when invoice activity changes. Archived primaries or ambiguous TRUST
organisation configuration fail closed for administrator review; no historical Contacts are merged or deleted.

If no Contact is linked, both new and existing students can provision storage on their first upload, without
an invoice. The durable intent snapshots the name/email and uses `sophia:<runtime student UUID>` as its unique
ContactNumber. A two-minute student/organisation lease serializes concurrent cases. Every attempt looks up
that exact reference before creating, including after Xero's six-minute idempotency cache expires. The
provider call happens outside database transactions, uses shared operational quota/backoff and does not
blindly retry writes. A timeout retains the intent; retry the same file after two minutes. No provider calls
or primary-binding writes occur on ordinary page viewing or upload-options GETs. File metadata remains
associated with the explicitly selected Sophia case. Invoice attachment linking and S3 remain deferred.

Release order: keep uploads disabled during rollout; deploy updated Runtime API, shared worker and
Business Manager (`nodejs-api`) code, apply owner migrations 090 and 091 in order (skip already applied
migrations through the existing ledger), deploy the frontend, then explicitly enable **on Runtime API only**:

```text
XERO_ATTACHMENT_UPLOAD_ENABLED=true
XERO_CONTACT_CREATION_ENABLED=true
```

An integration administrator must reauthorize Xero from company integrations to grant `accounting.attachments`
and `accounting.contacts`. Deploy the updated worker before reauthorization: its read checks accept full
Contacts permission in place of Contacts read-only permission. Invoice/payment write permissions remain
unrequested unless the separate invoice-creation rollout below is enabled. Disabling Contact creation does not prevent uploads to an already linked Contact; disabling
attachment uploads stops file writes. Roll back feature flags/UI without deleting bindings or provider files.
Older frontend requests may only resume their already-persisted upload; new uploads require the refreshed UI.

### Xero invoice creation

Apply owner migration `100_student_xero_invoice_exports.sql`, then deploy Runtime API and Business Manager
before setting `XERO_INVOICE_CREATION_ENABLED=true` on Runtime API only. Reconnect Xero from company
integrations to grant `accounting.transactions`; existing read scopes remain requested. The action creates
unsent `DRAFT` ACCREC invoices only. It never authorises, emails or pays an invoice.

Only `payments.approve` users see and may invoke creation. Every request reauthorises the case, current offer,
TRUST connection and active student Contact, and requires the visible review confirmation. Migration 100
stores one tenant-scoped execution receipt per proposal instalment. A create-all request skips receipts already
created by a prior one-at-a-time request. Concurrent requests are claimed by one transaction and also carry a
stable Xero `Idempotency-Key`. An uncertain result is marked `review_required` and is not replayed after Xero's
short idempotency window; reconcile it with Xero before any manual action. Disable the flag to roll back without
deleting Sophia receipts or Xero drafts.

Xero [limits each Contact to ten attachments](https://developer.xero.com/documentation/api/accounting/contacts).
Migration 091 adds automatic **document-only overflow**, approved while S3/AWS migration is deferred:

- Preserve the primary billing Contact. Prefer it for uploads, then reuse other active explicitly linked
  Contacts, then create `Student (STD-n) — Documents 2`, `Documents 3`, etc. only as capacity is needed.
- Document destinations are student/organisation scoped and shared across cases. Each file remains linked
  to its originating case in Sophia. Discovery excludes Sophia-uploaded files belonging to another case;
  historical imported files retain their existing discovery behaviour. No historical files are moved/deleted.
- RLS-protected destination records store stable `sophia:<student UUID>:docs:<ordinal>` references, Contact
  creation snapshots and fenced leases. Provider creation is outside transactions and reconciles by exact
  external reference before retrying. No extra Sophia student, case or invoice is created for an overflow.
- Allocation locks the destination row and counts live provider files plus outstanding local reservations
  whose filenames are not yet visible upstream. This prevents concurrent cases/actors/replicas from taking
  the same last slot. Reservations are conservative: timeouts and completed-but-not-visible files are not
  blindly refunded. Full observations persist; deleted remote files do not automatically reclaim capacity.
- A provider capacity check rejects before byte PUT when necessary; only such an unattempted reservation
  may safely reroute. Once PUT might have happened, the upload stays pinned to its destination. Recovery
  finds its durable filename and verifies remote content size/SHA-256 before accepting the receipt, rather
  than overwriting/relying on Xero's six-minute key cache. Byte PUT is fenced after operational admission.
- Contact allocation bounds provider work to twelve destinations per request and three pre-PUT reroutes.
  Very large historical collections, concurrent provisioning, Xero outages/quota or stale leases can require
  retrying the same file after two minutes. Progress/intent persists; files themselves remain in the browser
  until confirmed and are never staged in PostgreSQL. This is not an outage-proof/offline upload queue.
- Sync users recognises explicit managed storage mappings, rejects conflicting identities, repairs Contact/
  invoice links to the existing student and excludes managed Contacts from fuzzy new-user grouping. The
  mapping lookup is additive when 091 is absent; deploy worker and nodejs-api together before enabling.

No additional OAuth scopes or environment flags beyond 090 are needed. Existing `accounting.contacts` and
`accounting.attachments` consent must already be granted; an administrator reauthorizes only if missing.
New stores deny direct deletion, including inherited default grants. Old in-flight uploads are marked as
already attempted by 091 and cannot be silently retargeted. Roll back upload enablement/code without
deleting overflow Contacts, reservations or provider receipts. S3 and invoice-document linking remain deferred.
App uploads retain PDF/JPEG/PNG and the 10 MB limit. No live Contact creation/file upload or production migration
is part of local verification; use an explicitly approved real student/file for release smoke testing.

### Document analysis foundation (phase 1)

Owner migration `094_student_document_analysis.sql` follows 093. It creates a
tenant-scoped durable analysis queue, append-only extraction results/reviews and
case offer/course/fee/instalment stores. Every document/result reference includes
its tenant and case; all seven stores force RLS and deny application deletion.
Only jobs and offer headers permit updates. Source financial rows and review
history remain append-only; phase 3 also supports reviewed versions of a result. One
confirmed current offer is allowed per case.

`student-document-analysis.contracts.ts` defines bounded strict extraction and
optimistic review payloads plus the provider-neutral extraction interface. Dates
are ISO calendar dates; money is integer minor units. Passport expiry is evaluated
against a caller-supplied company-local current date (valid through the expiry
date), so a persisted extraction can be reevaluated later. Ambiguous evidence or
identity requires review. Signed engagement evidence is not cryptographic
signature verification. Offer financial data always requires confirmation.
Conditional fees retain their source inclusion: the explicit future invoice
choice produces 970 AUD or 995 AUD for the example first payment without adding
25 AUD twice. No invoice applicability decision is inferred during extraction.

`enqueueDocumentAnalysis` accepts an existing transaction for atomic upload
finalization in phase 2. `StudentDocumentAnalysisQueue` claims one tenant's due
job with `SKIP LOCKED`, a three-minute lease and at most five attempts. Completion
and result insertion are atomic; expired lease tokens cannot publish. Safe error
codes and bounded exponential retry delays are persisted without raw upstream
errors. A final-attempt crash is marked failed on the next claim. Worker calls
must finish within the lease, verify attachment content/hash and run outside
database transactions. Authorized tenant scheduling, provider admission, manual
retry and replacement/result-selection policy belong to the next phases.

Phase 2 connects the upload hook, worker and review surface described below.
Migration application alone does not analyze existing documents. See
`../docs/sophia/student-document-validation-plan.json` for remaining phases.

### Passport and engagement analysis (phase 2)

Apply owner migration `095_student_document_analysis_review.sql` after 094 and
deploy Runtime API, shared student worker and Business Manager frontend together.
The migration extends existing idempotency operations and adds lookup indexes;
it does not trigger provider calls or change stored files.

Configuration (leave disabled until the coordinated rollout is ready):

- Runtime API and shared worker: `STUDENT_DOCUMENT_ANALYSIS_ENABLED=true`.
- Shared worker: `OPENAI_API_KEY` using the existing server-side secret mechanism,
  and `STUDENT_DOCUMENT_ANALYSIS_MODEL` set to an explicitly approved vision model
  supporting Responses Structured Outputs. No model default is silently selected.
- Shared worker retains `STUDENT_SYNC_DOCUMENT_CUSTOMER_IDS` as its explicit tenant
  allowlist. Shared quota/backoff must be enabled; its startup checks reject missing
  model/credential/migration dependencies before processing.

Only new uploads mapped by active stable `passport` or `engagement_letter`
requirement keys enqueue analysis, atomically with local upload finalization.
Receipt recovery follows the same path. Replayed completed uploads do not enqueue
duplicates; existing unclassified/imported attachments are not backfilled. Turn on
the worker before enabling uploads on the API. Disabling the feature stops new
enqueues and claims while preserving jobs, results, files and manual review history.

The existing shared worker has an independent round-robin lane, with one analysis
request in flight per process and five-second admission ticks throughout the day.
It does not wait for the 03:00–06:00 discovery window or block invoice/student
coordinator ticks. Shutdown drains its current analysis before closing pools.
An optional standalone `npm run cases:analyze -- --once` uses
`STUDENT_DOCUMENT_ANALYSIS_TENANT_IDS` and the same model/key/feature/quota flags;
omit `--once` for continuous operation. Use one deployment mode, normally shared.

The worker downloads through existing Xero quota/backoff admission, checks the
stored content hash and 10 MB analysis bound, and calls a pack-local dedicated
OpenAI adapter outside DB transactions. PDFs use direct `input_file`, images use
`input_image`; no public file URL, hosted File, conversation, tool or vector store
is created. `store:false`, bounded response size, strict per-kind schemas and
safe error classifications are enforced. Source/AI timeouts stay within the lease.
Provider retention controls are separate from `store:false`; no live extraction
or provider accuracy evaluation is implied by mock tests.

Case document lists project local status only. The browser polls pending metadata
every ten seconds while visible, bounded per visit, and refreshes activity when
checks finish. File preview/download are retained. Managers can open a native
review dialog showing source evidence, edit student name/expiry/signer as
applicable, add a required note, confirm or reject. Conflicting passport expiry
requires explicit verification/correction; expired passports remain Invalid even
after confirmation. Unknown evidence can be explicitly accepted with the review
note; this records a human judgment, not model verification. Other roles receive
safe status only. Raw extraction is not included in normal file lists.

Authenticated routes under `.../workspace/cases/:caseId/documents/:documentId`:

- `GET analysis` (private/no-store; case read scope, extraction only for managers).
- `POST analysis/review` (existing cases.manage, strict payload, optimistic document
  review version, actor-scoped Idempotency-Key, append-only review and case activity).
- `POST analysis/retry` with `{jobId}` (same manager scope/idempotency; failed latest
  jobs only; reuses the saved file, never performs another upload).

Automatic result completion records `Document checked` as SophiaAi; manual review
and retry events use the authenticated user's existing activity identity. No
checklist completion/status transition is automated in phase 2. Letter of Offer
extraction, financial proposal persistence and college matching are described below;
checklist automation is phase 4. Historical/replacement authoritative selection
and wider model accuracy/cost evaluation remain documented rollout work.

### Letter of Offer review (phase 3)

Apply owner migration `096_student_offer_review.sql` after 095. Deploy the Business
Manager Express backend, Runtime API, shared worker and frontend together. Enable
`STUDENT_OFFER_ANALYSIS_ENABLED=true` on **both Runtime API and shared worker**, with
the existing analysis feature enabled. Keep the approved worker model (currently
`gpt-4.1`) and server credential configured. The worker checks the 096 directory
view before startup. Migration alone performs no provider calls or backfill.

New uploads with the stable `letter_of_offer` requirement key enqueue schema v2
extraction. The provider receives bounded PDF/image input with strict per-kind
Structured Outputs and a 12,000-token offer output cap. Existing v1 stored offers
remain readable. Source content is untrusted evidence, never model instructions.
All courses, fee lines, instalments and per-payment components are preserved with
integer minor-unit amounts. Stated totals and printed instalment totals remain
distinct: the example retains 9,040 AUD and 9,065 AUD, with the first 25 AUD already
included in its 995 AUD payment. Conditional-fee applicability is deferred to the
future invoice flow. `Immediately` stays a literal due term with no invented date.

Extraction appends an immutable result and proposed relational offer atomically.
Confirmation adds an immutable reviewed version and makes it the case's one
current confirmed offer; prior source and reviewed financial rows remain intact.
Incomplete proposals retain their source extraction for correction. Financial
children are bulk inserted. Normal page/status reads use local data, not providers.

Only a unique normalized exact active same-company college match, with clear
student/evidence and no identifier conflict, may auto-assign an unassigned case.
Partial/duplicate/conflicting matches require selection. An existing different
college is preserved until an explicit replacement is confirmed. Review requires
a note, current document/case versions, complete financial fields and an explicit
acknowledgement of unexplained total differences. The case summary uses the first
course; all courses remain available on the offer. Automatic college matching and
extraction activity use SophiaAi; confirmations/rejections use the signed-in actor.

The existing review dialog includes an editable offer form and company-scoped
college selection/creation. Creation follows College Details' required name and
optional owner/ABN/notes through `POST /bm/colleges/from-offer`. A transaction lock
serializes same-name offer creations; retries reuse a unique compatible active
college, while duplicate matches or ABN conflicts return a safe conflict. This
does not merge or rewrite historical colleges. Refreshing the local directory
retains unsaved review edits and does not silently rebase the case version.
The source-order course/fee/instalment cards are financial editors, not directory
tables; they reuse manager inputs/selects, toasts, native dialog and touch/dark styles.
The widened offer dialog now groups those editors into Details, Fee details,
Instalment schedule and Evidence & review note tabs. Edits persist between tabs;
validation selects the relevant tab, and Reject/Confirm stay outside the single
content scroll. Upload success closes its modal and shows a page toast. Busy-save
messages describe secure storage, not AI extraction: extraction remains a separate
background job. This feedback does not establish an upload latency improvement.

Managers can also `POST analysis/start` with `{}` and an Idempotency-Key for a
completed, typed app-upload with a known stored hash that has no existing job.
This supports files uploaded before activation without reuploading or creating
another Contact. Imported/unclassified files are not automatically analyzed.
Existing retry continues to reuse saved files. Tenant RLS, manager-only evidence,
active company college checks and optimistic/idempotent writes remain enforced.

No invoices, fee applicability choices, automatic checklist completion or case
status transitions are introduced by phase 3 alone. Phase 4 below adds document
checklist integration and replacement/expiry reevaluation. Mock tests and local database/UI tests do not
establish live provider accuracy, latency or cost; controlled live evaluation is
still required after rollout.

### Evidence-based Pre-sale checklist (phase 4)

Apply owner migration `097_student_document_checklist.sql` **after 096**, then
deploy Runtime API, shared student worker (including its host script) and frontend.
Enable `STUDENT_DOCUMENT_CHECKLIST_ENABLED=true` on Runtime API and worker only
after rollout. Retain both analysis flags; the worker checks them and migration
097 before startup. No new service or provider permission is required. No live
provider request or production migration was performed as part of local verification.
Enabling the flag also reconciles existing Pre-sale cases: previously checked
document items can reopen when they lack accepted current evidence. Imported
In-progress cases are not automatically moved into this workflow.

With this opt-in flag, Signed engagement letter and Document completeness become
evidence-controlled, read-only checklist items. Review/correction remains in the
existing Document check dialog. The newest typed document is authoritative for
each requirement (immutable discovery timestamp, then document UUID as a stable
tie-breaker); a pending, failed, rejected or unreadable replacement cannot fall
back to an older passing file. Untyped imports are not guessed from filenames.
Signed engagement requires a passing extraction or audited human acceptance.
Completeness requires every active required status binding's latest document to
pass; a Letter of Offer must also be the current confirmed financial version.
Archived types, missing evidence and unsupported custom validators fail closed.
An empty requirement set never means complete. Merely uploading three files is
not sufficient. Human signature acceptance is still not cryptographic verification.

Upload finalization, worker result publication, review/retry and case edits
reconcile under the existing case lock, in the same tenant transaction as their
audit entries. Queue completion now locks case before job, matching API writes.
Historical files remain readable but cannot be confirmed after a replacement.
Late old offer results cannot auto-assign the college. Replacing an offer makes
its old financial approval historical and reopens Invoice/LoO consistency; this
item and Pending Track remain manual and are never automatically marked complete.
No stage/status is advanced, no invoice is generated and no conditional fee is
applied. Manual stage/status selection remains the existing workflow contract.

The shared worker has a separate all-day local-only reconciliation lane: at most
20 due Pre-sale cases per tenant tick, round-robin tenant admission every 15 seconds,
15-minute per-case cooldown, SKIP LOCKED and shutdown drain. It does not wait for
AI extraction or overnight discovery. Passport expiry is valid through its date
and is reevaluated against Australia/Brisbane time, with no new AI call. A confirmed
passport cannot pass after expiry, even if its extraction had other warnings.
Human identity acceptance records the case student name at review time; later
identity changes need fresh review rather than inheriting an unrelated approval.
Checklist GET remains local/read-only and suppresses stale document acceptance
before the worker catches up. Configuration and cross-case profile changes are
eventually reconciled by the bounded worker lane; this is not an exact-time SLA.
Checklist responses also expose safe passed/needs_review/checking/missing metadata
for document-driven items. The UI shows green completion or amber review icons
beside the checkbox; missing files are not misleadingly labelled review failures.

Only real boolean transitions produce activity: SophiaAi for automatic item and
aggregate completion/reopening, authenticated identity for manual changes. Each
automatic event retains rule version and scoped document/result/review references,
not source text. The tenant cursor stores its latest evidence snapshot separately;
normal app role RLS and composite case FK are enforced, with no DELETE grant.
Repeated evaluation does not create duplicate completion events. The frontend
reuses existing checkbox/card/dialog/toast styling and refreshes the checklist
after uploads, review and polled result changes; no new page-level provider calls.

Controlled live accuracy/cost/latency evaluation and invoice comparison with the
user's explicit conditional-fee decision remain separate follow-up work. These
must not be inferred from local synthetic tests. Disable the new flag on API and
worker to stop automation without deleting files, results, reviews or audit history.

### Status-based document requirements

Apply owner migration `093_student_status_document_requirements.sql` after 092,
then deploy Runtime API and frontend together. It creates tenant-scoped
`student_operations_status_document_requirements` bindings between a case status
and document type, plus global default templates. Pre-sale starts with Engagement
letter, Letter of Offer and Passport, in that order. Migration seeding reuses
case/whitespace-insensitive active type names instead of duplicating them; it
does not change existing type names or their general `required` flag.

Draft creation reads `GET workspace/cases/document-requirements?status=pre_sale`
and displays missing rows without writing a student, case or file. Upload is
disabled until the case is saved. The invoker-rights initializer runs on case
creation/update to provision defaults for newly onboarded companies; it uses
the authenticated tenant/company binding, tenant RLS and existing type grants,
not general customer-table access or `SECURITY DEFINER`. Archived bindings and
archived bound types are not silently recreated/reactivated.

Saved case document responses include workflow requirements and whole-case typed
file coverage. Missing rows appear on page one with Upload, while actual file
rows retain View/Download. A requirement upload opens the existing modal with
its type selected and disabled; general Upload still permits choosing any active
company type. Fulfilment uses the case/type UUID, never filenames, another case
or only the current pagination page. A coverage index supports this lookup.
The document count continues to count actual files, not missing placeholders.

Workflow bindings carry `customer_id`, `case_status`, stable `requirement_key`,
`document_type_id`, `required`, `sort_order` and active/archived status. Future
owner migrations can add bindings for more types/statuses without changing the
UI. Configuration authoring UI is not introduced here. The general Manage types
Required flag remains independent of status-specific requirements. Renaming a
type preserves bindings; archiving a still-required type leaves a visible
unavailable requirement for administrator resolution, without losing files.

No automatic checklist confirmation, signature validation, workflow transition,
student-save gate, provider write or historical document classification is
performed by this feature. Existing Contact storage/overflow uploads are reused.

### Case Next Actions and Pre-sale checklist

Apply owner migration `092_student_case_checklists.sql` after existing migrations,
then deploy Runtime API and frontend. No Xero scope or worker changes are needed
for manual checklist updates. New cases must be saved before checklist edits.

`GET /business-packs/student-operations/v1/workspace/cases/:caseId/checklist`
returns the four Pre-sale items. Missing rows are unchecked, version zero, and
reads never create records. `PATCH` on the same route accepts only `itemKey`,
`completed` and `recordVersion`, with the existing `Idempotency-Key` contract.
It requires `cases.manage` and an authorized, saved Pre-sale case. Existing advisor
read-only access is unchanged. Updates commit immediately, independently of case
editing; they do not change workflow stage or case status.

Tenant RLS, a case-scoped foreign key, a case-row lock and per-item versions
isolate checklists and prevent concurrent lost updates. Item changes and the
transition to/from all four complete append activity in the same transaction.
Retrying a successful request does not duplicate activity. The activity feed
shows the server-resolved actor name and timestamp; Add student also records
`User created`. New human events snapshot the display name. Historical automated
events with migration/system/worker/Sophia identities display `SophiaAi`; unknown
human identities are not mislabelled as automation. The browser cannot choose an
actor or mark its change as automatic.

Next Actions sits beside Documents/Linked invoices; Meet Sophia moves beside
Recent activity/Case at a glance. Only Pre-sale has defined checklist content;
other statuses show an explicit unconfigured state. Future automatic verification
must use trusted server-side actor attribution and the same transactional audit
and concurrency rules. Automatic document/invoice/track validation, workflow
gating and assistant execution are not enabled by this release.

## Sophia subscription billing

Sophia subscriptions use an independently configured Stripe adapter. It never
falls back to the legacy Business Manager `STRIPE_*` variables used by Toolkit
and video purchases. `stripe_sandbox` is charge-safe test mode; `stripe_live`
keeps Checkout disabled unless `SOPHIA_BILLING_LIVE_CHECKOUT_ENABLED=true` is
separately authorised. Live overage collection and Founding milestone invoicing
have distinct default-off switches so enabling one path cannot implicitly enable
another. Required values are validated for each enabled path; a base-plus-overage
sandbox deployment uses:

```bash
SOPHIA_BILLING_PROVIDER=stripe_sandbox
SOPHIA_BILLING_PROVIDER_ACCOUNT_KEY=legacy-primary
SOPHIA_BILLING_LIVE_CHECKOUT_ENABLED=false
SOPHIA_BILLING_LIVE_OVERAGE_ENABLED=false
SOPHIA_BILLING_LIVE_MILESTONE_ENABLED=false
# Set only after the final activation audit and explicit real-charge authority:
# SOPHIA_BILLING_LIVE_ACTIVATION_CONFIRM=I_AUTHORIZE_SOPHIA_LIVE_CHECKOUT_FOR_APPROVED_CUSTOMERS
SOPHIA_BILLING_STRIPE_SECRET_KEY=sk_test_...
SOPHIA_BILLING_STRIPE_WEBHOOK_SECRET=whsec_...
SOPHIA_BILLING_STRIPE_PORTAL_CONFIGURATION_ID=bpc_...
SOPHIA_BILLING_STRIPE_COMMITTED_PORTAL_CONFIGURATION_ID=bpc_...
SOPHIA_BILLING_STRIPE_PRICE_MAPPINGS={"commercial-plan-version-uuid":"price_..."}
SOPHIA_BILLING_STRIPE_INITIAL_PRICE_MAPPINGS={"commercial-plan-version-uuid":{"commencement":"price_..."}}
SOPHIA_BILLING_STRIPE_MILESTONE_PRICE_MAPPINGS={"commercial-plan-version-uuid":{"production-deployment":"price_..."}}
SOPHIA_BILLING_STRIPE_METERED_PRICE_MAPPINGS={"commercial-plan-version-uuid":"price_..."}
SOPHIA_BILLING_STRIPE_OVERAGE_PRICE_MAPPINGS={"commercial-plan-version-uuid":"price_..."}
SOPHIA_BILLING_STRIPE_METER_BINDINGS={"active-overage-minutes":"sophia_active_overage_minutes"}
SOPHIA_BILLING_CHECKOUT_SUCCESS_URL=https://admin.example/sophia-admin/usage-billing?checkout=success
SOPHIA_BILLING_CHECKOUT_CANCEL_URL=https://admin.example/sophia-admin/usage-billing?checkout=cancelled
SOPHIA_BILLING_PORTAL_RETURN_URL=https://admin.example/sophia-admin/usage-billing
```

The base mapping is a recurring licensed Price. Initial mappings are optional,
plan-version and component-key scoped one-time Prices that appear only on the
initial subscription invoice; a plan without immutable initial charge
components ignores this mapping. Milestone mappings are separate approved
one-time Prices used only after a recent-MFA billing administrator records
immutable acceptance evidence; submission and exact finalized-line
reconciliation are environment-scoped and idempotent. The overage mapping is a
separate one-time Price used by the draft-renewal invoice-adjustment and
missed-window carry-forward paths; Meter-backed mappings remain independent
usage-delivery evidence. In live mode, overage invoice adjustment, recovery and
Meter submission require `SOPHIA_BILLING_LIVE_OVERAGE_ENABLED=true`, while a
Founding production-deployment invoice requires
`SOPHIA_BILLING_LIVE_MILESTONE_ENABLED=true`. Both default to false and neither
enables Checkout. Exact reconciliation remains available after either collection
switch is turned off so in-flight obligations can be resolved safely.

The committed portal configuration must be active in the same Stripe mode and
must disable subscription cancellation. A paid initial subscription invoice
anchors any minimum commitment to the exact first provider billing period. The
runtime counts contiguous observed provider periods and uses the committed
portal before the exact final-period boundary; at or after that boundary it uses
the standard active portal configuration, which must enable cancellation. The
provider subscription metadata must pin the same immutable commercial plan.
This does not create a local cancellation scheduler or claim that Stripe
guarantees collection of the contractual term.

Founding sandbox resources and proof fixtures are operator-only workflows:

```bash
SOPHIA_FOUNDING_CATALOG_CONFIRM=I_UNDERSTAND_THIS_PUBLISHES_A_COMMERCIAL_PLAN \
npm run commercial:publish-founding

SOPHIA_FOUNDING_PLAN_VERSION_ID=<published-plan-uuid> \
SOPHIA_FOUNDING_CONFIRM=I_UNDERSTAND_THIS_CREATES_STRIPE_SANDBOX_OBJECTS \
npm run billing:founding-provision

SOPHIA_FOUNDING_PLAN_VERSION_ID=<published-plan-uuid> \
SOPHIA_FOUNDING_TENANT_ID=<isolated-proof-tenant-uuid> \
SOPHIA_FOUNDING_CONFIRM=I_UNDERSTAND_THIS_CREATES_STRIPE_SANDBOX_OBJECTS \
npm run billing:founding-sandbox -- prepare
```

The compiled Founding publisher derives the already-approved seller identity
from the configured sandbox provider account, so it does not require the legal
catalog JSON to be reconstructed in a production shell. Publication and
provisioning are idempotent by immutable database identity, Product metadata
and Price lookup keys. Stripe provisioning
refuses non-test keys, and prints mapping entries to merge with existing Render
JSON values. The proof stages are `prepare`, `close`, `milestone`,
`advance-commitment`, and `status`; they create Stripe sandbox objects and must
never be run against a real tenant.

Commercial plan entitlements remain provider-neutral. Runtime safety/capacity
controls can only lower those ceilings and are configured independently:

```bash
SOPHIA_PROVIDER_SESSION_CAPACITY={"lifecycle-adapter-key":3}
SOPHIA_TOOL_READ_SEARCH_CALLS_PER_MINUTE=15
SOPHIA_TOOL_MUTATION_CALLS_PER_MINUTE=15
SOPHIA_TOOL_SENSITIVE_CALLS_PER_MINUTE=15
SOPHIA_TOOL_CALLS_PER_MINUTE_BY_TOOL={"booking.commit":5}
```

Provider-capacity keys are internal lifecycle-adapter identifiers, not vendor
names embedded in plans. The effective session ceiling is the minimum of the
commercial entitlement, tenant guardrail, platform cap, and configured capacity
for the selected adapter. An explicit `default` key may represent a verified
platform-wide fallback; without an adapter key or that fallback, new sessions
fail closed. Tool class and per-tool values are operational abuse
guards and may not raise the commercial aggregate limit.

The provider-account key is a stable internal identifier, not a secret or a
Stripe API key. Keep `legacy-primary` for the existing Stripe account during the
expand rollout. Changing it creates a different billing identity scope and must
be handled as an explicit provider-account migration, not routine secret
rotation.

The signed endpoint is `POST /api/billing/v1/webhooks/stripe`. Raw bodies are
used only for signature verification and are never persisted. Store only opaque
customer/subscription/invoice references and payload digests. Hosted actions and
reconciliation require `billing.manage` plus recent MFA.

Before Checkout, the adapter retrieves the mapped Stripe Price and requires an
exact environment-mode match to the approved fixed plan currency, base amount and
month/year interval. This first lifecycle rejects usage-overage rate cards and
tax modes other than `not_applicable`. Base-plus-metered support requires the
separately staged active-second ledger/outbox design recorded in plan 2.1.46;
do not approximate it with per-session rounding or a single transformed tiered
Price. Sandbox observations do not assign plans, enforce
live entitlements or activate production charging.

## Provider-neutral reasoning

The server-side `ReasoningPipelineService` resolves a published reasoning adapter,
streams canonical text/usage events and sends every requested tool through the
authenticated v2 dispatcher. The OpenAI Responses adapter is registered as
`openai-reasoning-v1` and is configured with:

```bash
OPENAI_API_KEY=your-openai-api-key
OPENAI_REASONING_MODEL=gpt-5.4-mini
OPENAI_REASONING_TIMEOUT_MS=60000
OPENAI_REASONING_MAX_OUTPUT_TOKENS=4096
```

Responses are requested with provider storage disabled. Opaque continuation state
is held only for the active server turn, and canonical dotted tool IDs are translated
inside the adapter. The pipeline does not itself provide speech, avatar or native
realtime capability, and it is not a public browser credential endpoint. Browser v2
activation still requires the managed kiosk credential broker described below.

The interchangeable Claude Messages adapter is registered as
`anthropic-reasoning-v1` but is disabled by default: it is absent from published
profiles and fails closed without `ANTHROPIC_API_KEY`.

```bash
ANTHROPIC_API_KEY=your-anthropic-api-key
ANTHROPIC_API_BASE_URL=https://api.anthropic.com
ANTHROPIC_REASONING_MODEL=claude-sonnet-5
ANTHROPIC_REASONING_TIMEOUT_MS=60000
ANTHROPIC_REASONING_MAX_OUTPUT_TOKENS=4096
```

Claude continuation blocks remain only in the active adapter session. Protocol
statelessness does not prove zero data retention: before publishing a production
Claude binding, approve its data-handling assessment and verify the organisation's
applicable Anthropic retention/ZDR arrangement. No browser receives the API key.

The interchangeable Gemini Interactions adapter is registered as
`gemini-reasoning-v1` and is likewise disabled by default: it is absent from
published profiles and fails closed without `GEMINI_API_KEY`.

```bash
GEMINI_API_KEY=your-gemini-api-key
GEMINI_API_BASE_URL=https://generativelanguage.googleapis.com/v1beta
GEMINI_REASONING_MODEL=gemini-3.8-flash
GEMINI_REASONING_TIMEOUT_MS=60000
GEMINI_REASONING_MAX_OUTPUT_TOKENS=4096
```

Requests use the current Interactions `steps` schema with `store: false`. Complete
Gemini continuation steps, including encrypted thought signatures, remain only in
the active adapter session. The adapter rejects unsupported JSON Schema keywords
before network I/O instead of allowing provider-side silent constraint loss. The
common pipeline executes returned calls sequentially because Interactions can emit
parallel function calls but exposes no equivalent of OpenAI's parallel-call switch.
The Gemini Developer API may still retain abuse-monitoring data, so production
publication requires an approved data-handling assessment; guaranteed ZDR requires
the separately assessed Vertex AI deployment path. No browser receives the API key.

## Gemini native Live

`gemini-live-v1` is a separate native-realtime adapter for explicitly published v2
profiles. It does not replace `native-realtime-v1` or change existing Essential and
Professional routing. The server mints a one-use constrained token; the long-lived
`GEMINI_API_KEY` never reaches the browser.

```bash
GEMINI_LIVE_MODEL=gemini-3.8-live
GEMINI_LIVE_TOKEN_TTL_SECONDS=600
GEMINI_LIVE_NEW_SESSION_TTL_SECONDS=60
```

The token locks the model, server instructions, tool catalog, audio response,
transcription and barge-in configuration. Every tool is explicitly `BLOCKING`
because this model otherwise defaults to asynchronous function execution. Browser
tool events remain an untrusted bridge and pass through the authenticated v2
dispatcher; voice never confirms a prepared booking or other reviewed mutation.

The browser adapter validates Google's constrained WebSocket endpoint, sends PCM16
mono input at 16 kHz, plays 24 kHz PCM through one Web Audio owner, processes every
audio part, maps provider-local tool names and clears queued output on interruption.
No SessionResumptionConfig is enabled: current Google documentation says generated
resumption state can retain text, audio and video for up to 24 hours. Sessions are
capped at 540 seconds, before the documented approximate ten-minute connection-reset
boundary. Longer sessions require a separately reviewed reconnection and retention
design.

Gemini Live and ephemeral tokens are still preview API surfaces even though
`gemini-3.8-live` is a stable model ID. The registration remains absent from
published profiles until preview risk, data handling, regional processing,
AI-voice disclosure and a credentialed live smoke test are approved. The Angular
transport is compiled and contract-tested, but the active kiosk facade still uses
the bounded v1 session response. Selection through a v2 profile also requires the
managed kiosk broker and descriptor/bootstrap translation recorded in P4.

## Orchestrated voice composition

The internal `OrchestratedVoicePipelineFactory` composes independently registered
transcription, reasoning and synthesis adapters with exactly one playable-audio
sink. The first real speech adapters are `openai-transcription-v1` and
`openai-synthesis-v1`. They accept and emit signed 16-bit little-endian 24 kHz mono
PCM. Input is deliberately a bounded, client-delimited turn: the runtime holds it
in memory, wraps it as WAV for `/v1/audio/transcriptions`, and emits final text only.
This is not a low-latency partial-transcription claim. TTS PCM is streamed through
the runtime with bounded output and sample-aligned chunks.

```bash
OPENAI_AUDIO_API_BASE_URL=https://api.openai.com/v1
OPENAI_TRANSCRIPTION_MODEL=gpt-transcribe
OPENAI_SYNTHESIS_MODEL=gpt-4o-mini-tts
OPENAI_SYNTHESIS_VOICE=marin
OPENAI_TRANSCRIPTION_MAX_INPUT_BYTES=2880000
OPENAI_SYNTHESIS_MAX_OUTPUT_BYTES=12000000
```

Turn epochs bind transcript, reasoning and audio. Interruption aborts work, asks the
sole sink to clear queued audio, and drops late events; audio already heard cannot be
retracted. Raw audio is not persisted by Sophia, but it does traverse this backend
and OpenAI. Deployment must approve current provider data controls and disclose that
the voice is AI-generated. This factory has no public browser route yet: authenticated
media transport still depends on the managed kiosk broker.

The generic `live-avatar-v1` and `simli-avatar-v1` registrations are avatar-only.
Their current server `sendAudioChunk` implementations do not inject media, so neither
is accepted as an orchestrated-voice audio sink until a real adapter and interruption
contract are implemented and tested. Existing browser-SDK session behavior remains a
separate legacy composition.

LiveAvatar uses its separate real-time platform. The session request can select
`avatarMode: "LITE"` or `avatarMode: "FULL"`; `LIVEAVATAR_MODE` is only the
server-side fallback when a mode is not supplied. LITE sends OpenAI's native
24 kHz PCM output to LiveAvatar. FULL requests text-only OpenAI output and lets
LiveAvatar synthesize the voice and lip-sync, avoiding duplicate output-audio
charges. For sandbox testing, configure:

```bash
LIVEAVATAR_API_KEY=your-liveavatar-key
LIVEAVATAR_MODE=FULL
LIVEAVATAR_VOICE_ID=your-liveavatar-voice-id
LIVEAVATAR_SANDBOX=true
LIVEAVATAR_MAX_SESSION_DURATION_SECONDS=60
```

Sandbox mode always uses LiveAvatar's fixed public avatar and ignores
`LIVEAVATAR_AVATAR_ID`. For production, set `LIVEAVATAR_AVATAR_ID`, disable
sandbox mode, and configure the longer session duration allowed by your plan.

## Tavus Full

The `Tavus` kiosk experience uses Tavus's complete conversational pipeline and
does not create an OpenAI Realtime session. Configure a Tavus Persona that uses
the native `tavus-gpt-oss` LLM, then add these variables to the Sophia Runtime
service:

```bash
TAVUS_API_KEY=your-tavus-api-key
TAVUS_PERSONA_ID=your-native-tavus-persona-id
TAVUS_REPLICA_ID=your-replica-id
TAVUS_NATIVE_LLM_ONLY=true
TAVUS_INTERNET_SEARCH_ENABLED=true
```

`TAVUS_REPLICA_ID` is optional when the Persona already has a default replica.
Do not set `TAVUS_NATIVE_LLM_ONLY=true` for a Persona whose LLM layer contains
an OpenAI `base_url` or API key. The runtime refuses Tavus sessions unless this
operator confirmation is enabled, and its Tavus code path never requests an
OpenAI client secret.

The runtime injects the same approved Sophia product profile into OpenAI and
Tavus conversations. OpenAI-based experiences use the `researchBusiness` tool,
which calls OpenAI Responses web search only when business research is
requested. Tavus Full attaches Tavus's native `internet_search` skill to the
PAL during an explicit deployment operation and does not use OpenAI for research. Set
`TAVUS_INTERNET_SEARCH_ENABLED=false` only when that behavior is intentionally
disabled.

See [Tavus acceptance suite](./TAVUS_ACCEPTANCE_SUITE.md) before selecting Tavus
as the production default.

### Provider catalog and cleanup operations

Customer session creation never creates, updates or attaches remote Tavus tools.
Provision each tenant/environment catalog as a versioned deployment before enabling
Premium sessions:

```bash
SOPHIA_PROVIDER_OPERATION_CUSTOMER_ID=11111111-1111-4111-8111-111111111111 \
SOPHIA_PROVIDER_OPERATION_CONFIRM=11111111-1111-4111-8111-111111111111 \
SOPHIA_PROVIDER_CATALOG_VERSION=2026-09-23.1 \
SOPHIA_PROVIDER_CATALOG_MODE=legacy \
npm run providers:provision
```

Use `legacy` while Premium sessions use the v1 compatibility API. Use
`canonical` when cutting Premium over to v2. Session opening compares the exact
tool-definition digest with the active remote deployment and fails closed when
the modes or definitions differ; changing this mode therefore requires an
explicit provider catalog deployment.

Provider resource ownership is exclusive per tenant and environment. A failed
version retains only non-secret resource IDs and may be resumed after its operation
lease expires. Premium admission fails closed when no active catalog matches the
configured persona.

Run cleanup reconciliation for each tenant from the scheduler/worker environment:

```bash
SOPHIA_PROVIDER_OPERATION_CUSTOMER_ID=11111111-1111-4111-8111-111111111111 \
SOPHIA_PROVIDER_OPERATION_CONFIRM=11111111-1111-4111-8111-111111111111 \
npm run providers:reconcile
```

Reconciliation claims expired/disconnected allocations with a database lease. Close
is idempotent, and failed cleanup remains retryable without exposing provider tokens.

## Runtime v2 canary

Runtime v2 is disabled unless the fixed runtime tenant is explicitly allowlisted:

```bash
SOPHIA_V2_CANARY_TENANT_IDS=11111111-1111-4111-8111-111111111111
SOPHIA_V2_INSTALLATION_KEY=a-random-installation-secret-of-at-least-32-characters
SOPHIA_V2_BOOTSTRAP_TTL_SECONDS=120
```

`POST /api/runtime/v2/bootstrap` requires `X-Sophia-Installation-Key` and returns
a short-lived one-time bootstrap token. Use that token as `Bearer` authentication
for `POST /api/runtime/v2/sessions`; the returned session access token then
authenticates the v2 session lifecycle and tool routes. The server resolves only
published profiles and active, non-revoked agent releases. Unsupported or stale
compositions fail before provider allocation. Check `/api/runtime/v2/readiness`
for non-secret activation status.

Existing `/api/runtime/sessions` traffic remains pinned to the v1 path. Never put
the installation key or provider credentials in a public browser bundle; an
installation backend or managed kiosk credential broker must perform bootstrap.

## Admin onboarding readiness

`GET /api/admin/v1/tenants/:tenantId/onboarding-readiness` returns a persisted,
permission-masked integration view for the tenant already resolved by Admin
authentication. It aggregates organisation access, foundational profiles,
approved content, connectors/capabilities, workflow/escalation policy, active
immutable releases, v2 session evidence and audit evidence. A caller without all
required read grants receives `activationReady: null`; restricted steps never
disclose their counts.

This is an existing-authorised-tenant assembly gate, not a platform provisioning
API. Business, provider and experience profile versions must already have been
published through their owning operational control plane. Pinned v2 session
evidence is shown separately and does not grant publication authority. Do not use
an owner/BYPASSRLS database role for the Runtime service; use the configured
`sophia_runtime_app` effective role described in
`../docs/sophia/database-role-hardening.md`.

## Operational accountability and provider usage

`GET /api/admin/v1/tenants/:tenantId/operations/status` requires
`analytics.read` and returns tenant-scoped session, tool, workflow and queue
counts together with queue-age, orphan-session, failure and denial-spike signals.
Its retry-capability section is authoritative: workflow retry is available only
when a compiled owner declares an idempotent implementation, provider cleanup is
scheduler-only, and generic session/tool replay is unsupported.

`GET /api/admin/v1/tenants/:tenantId/operations/usage` requires `usage.read` and
returns aggregate provider-independent usage dimensions split by
`incomplete`, `estimated` and `measured` evidence. Internal reasoning pipelines
write stable source-event identities; identical replay is deduplicated and a
conflicting replay is rejected. Missing final provider usage is recorded as
incomplete and may move forward through optimistic reconciliation. Measured rows
cannot be edited or deleted by `sophia_runtime_app`.

Optional cost values are provider-cost estimates and require a currency plus a
cost-table version. They are never customer charges. Budget status remains
`unavailable` until P6-A05 defines and approves tenant budget and commercial
policy. Callback requests, notification acceptance and live-transfer connection
are likewise separate evidence states; only the internal operations inbox is
currently supported.

## Private knowledge file intake

Knowledge files are disabled by default. Activation requires a dedicated private
S3 bucket with all four Public Access Block controls enabled and an authenticated
scanner implementing `GET /health` and `POST /scan`. Do not reuse the public
avatar/article bucket or `/api/uploads/presign` route.

The first bounded file set is `.txt` and `.md`, at most 1 MiB. Presigned PUTs are
bound to server-generated quarantine keys, exact length, media type, SHA-256
checksum and server-side encryption. A draft revision is created only after the
worker rechecks the bytes, receives a clean scan result and parses strict UTF-8 in
a resource-limited worker thread with a 256 KiB extracted-text cap.

Configure the Runtime API and a separate worker deployment with the variables in
`.env.example`. Run one worker per explicitly configured tenant so FORCE RLS stays
effective:

```bash
SOPHIA_KNOWLEDGE_WORKER_TENANT_ID=11111111-1111-4111-8111-111111111111 \
npm run knowledge:file-worker
```

Use `npm run knowledge:file-worker -- --once` for a scheduler invocation. The
Admin readiness endpoint remains disabled when the bucket's public-access policy
cannot be verified or the scanner health check fails. Scanner-infected and upload
metadata-mismatch objects are marked quarantined and deleted; transient failures
are retried no more than three times.

## Capability portability checks

Portable resource references use `connectorBindingId` plus a connector-opaque ID.
The current operation's distinct `capabilityBindingId` remains in its server-owned
context for grant, schema, policy and audit enforcement. This distinction permits a
catalog result to flow into availability or booking on the same connector without
allowing a same-named resource from another tenant connector.

Run `npm run typecheck:portability-core` to compile the shared capability,
orchestration, business-pack registry and tool contracts without a concrete provider
adapter or real-estate registration. The adversarial neutral fixtures are under
`test/portability`; they are test-only and are never registered as a business pack.

## Business Manager Real-Estate Demo

Real estate is a compiled optional business pack, not a Core dependency. The
default preserves the existing demo:

```bash
SOPHIA_BUSINESS_PACKS=real-estate
```

Set `SOPHIA_BUSINESS_PACKS=none` for a Core-only composition. In that mode the
runtime starts with generic approved capabilities only, publishes no property or
inspection tools, injects no real-estate instructions, and reports the
`core-tools-v1` catalog version. Unknown pack IDs fail startup rather than loading
code from configuration.

The compiled real-estate manifest owns its connector key, capability operations,
typed extension schema IDs, renderer IDs, workflow instructions and bounded v1
tool aliases. V2 sessions receive canonical capability names only; v1 sessions
retain only the legacy catalog. Changing the enabled pack set requires compatible
published profiles and provider-catalog provisioning before activation.

The real-estate tools read company-scoped listings and agency guidance from the
Business Manager API. Generate one random service token and configure the same
value on both Render services. This token is accepted by the real-estate and student-agency integration
routes; normal Business Manager user JWTs remain supported.

Business Manager (`nodejs-api`) variables:

```bash
SOPHIA_RUNTIME_SERVICE_TOKEN=a-random-value-of-at-least-32-characters
SOPHIA_RUNTIME_COMPANY_ID=81c2f065-aceb-4043-add5-b11271d21fb3
```

Sophia Runtime variables:

```bash
BUSINESS_MANAGER_API_URL=https://your-business-manager-service.onrender.com/api
BUSINESS_MANAGER_API_TOKEN=the-same-random-service-token
```

The tracked schema starts in `../scripts/sql/bm_real_estate_demo.sql`. Apply
`../scripts/sql/bm_real_estate_demo_city.sql` after it to add city-level search.
Reset the fictional presentation data, agency guidance and future inspection
slots with:

```bash
cd backend
BM_DEMO_COMPANY_ID=81c2f065-aceb-4043-add5-b11271d21fb3 \
  node scripts/seed-bm-real-estate-demo.mjs
```

OpenAI-based experiences receive all real-estate tools through the Realtime
tool registry. The explicit Tavus provisioning command deploys the equivalent PAL
tools; sessions only consume that active catalog, deliver calls through Daily app
messages, and receive matching tool results.
The OpenAI-backed public business research tool is intentionally excluded from
Tavus, which uses its native internet-search skill instead.

## Boundaries

- Core modules depend on `AIProvider`, not OpenAI directly.
- Core modules resolve `AvatarProvider` implementations per session, not at application startup.
- Live business data must flow through the `ToolRegistry`.
- Existing website/Business Manager users can be referenced by external ID, but this runtime database does not use cross-database foreign keys to the existing `users` table.

## Student agency demo release

Student knowledge, official verification, comparisons and consultations use the
same company-scoped Business Manager connection. Deploy the backend before this
runtime and the frontend. No additional runtime environment variables are needed.
The backend consultation sender accepts `SES_FROM_EMAIL` (preferred) or the
existing `SES_FROM`; region resolution is `AWS_REGION`, `SES_REGION`, then
`ap-southeast-2`. SMTP uses the existing `SMTP_*` variables. `EMAIL_PROVIDER=log`
is a preview only and cannot pass a live delivery acceptance check.

See [Phase 5 release validation](../docs/student-agency-phase5-release.md) for
repeatable tests, the demo script and deployment acceptance criteria.
