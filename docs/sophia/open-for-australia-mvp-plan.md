# Open For Australia operations MVP — gap analysis and proposed plan

Date: 5 October 2026  
Status: architecture and delivery order approved; OFA-00A through OFA-01A complete in source

## Product boundary

Open For Australia will be a client-specific operations workspace inside
Business Manager. Xero TRUST and Xero PTY remain accounting sources of truth.
Sophia stores operational cases, checkpoints, tasks, approvals, evidence and
audit context around Xero; it must not independently decide financial amounts or
execute transfers.

The retired student-agency demo is not a foundation for this product. The
real-estate demonstration remains independent and unchanged.

## What exists and can be reused

| Existing capability | Reuse decision |
| --- | --- |
| Angular Business Manager shell, company/user context, configurable navigation and responsive page patterns | Reuse for the five workspace routes and client entitlement. |
| Existing Express Business Manager company, user and navigation APIs | Keep in place; do not rewrite them as part of this MVP. |
| Node 22.23.2 repository/runtime contract | Reuse. Both the Express API and Nest Sophia Runtime target Node 22. |
| NestJS Sophia Runtime with tenant context, PostgreSQL migrations, RLS-oriented data model, authorization, immutable audit, workflows, escalations, privacy control plane and connector authority | Reuse as the host for a new `open-for-australia` business pack and its domain API. |
| Sophia conversation/orchestration and tool registry | Reuse after deterministic operational read models exist; tools call domain services rather than tables directly. |
| Real-estate business pack and deterministic tests | Preserve unchanged; it is a regression boundary, not a template to copy wholesale. |
| Existing Business Manager `Documents` module | Do not reuse as a student file vault. It models commercial quotes/invoices and lacks the quarantine/scanning/access lifecycle required for identity documents. |
| Existing generic S3 helper | Do not use for student documents. It includes legacy public-URL behavior and static application credentials and does not enforce scan-before-read. |
| Existing privacy Admin controls | Reuse the policy/evidence patterns; extend them with Open For Australia data-flow, retention, access/correction and erasure targets. |

## Missing from the proposed MVP

- No Open For Australia operational schema, RLS policies or API contracts.
- No student master record, case, stage history, payment schedule, checkpoint,
  task, approval, activity or college model.
- No five client workspace screens.
- No protected student-document upload/download lifecycle.
- No operational roles such as CEO, advisor and operations officer with
  least-privilege permissions.
- No Xero TRUST/PTY connector, identity mapping, webhook/polling reconciliation
  or idempotent synchronization.
- No deterministic TRUST-versus-PTY controls, commission calculation, signed
  Engagement Letter gate or Paid + PENDING urgency rule.
- No Open For Australia Sophia tools or grounded operational assistant.
- No approved privacy notice, collection-purpose catalogue, retention schedule,
  breach runbook or registered-migration-agent record schedule.

## Architecture decision

Use an incremental NestJS business pack, not an Express rewrite and not a third
deployable service for the MVP:

1. Keep the existing Express API responsible for legacy Business Manager
   company/user/navigation functions.
2. Add `open-for-australia` as a new bounded business pack in the existing NestJS
   Sophia Runtime. It owns the new operational tables, DTO validation, domain
   rules, RLS, permissions, audit events and APIs.
3. Add the new Angular routes under Business Manager and call the Nest domain API
   through the established authenticated runtime boundary.
4. Add Xero later through the connector-authority layer. Until credentials and
   scopes are approved, use explicit manual/reference fields and fixtures only.
5. Add Sophia tools only after the deterministic APIs and authorization tests
   are stable.

This gives new code NestJS structure and validation without paying the risk and
effort of rewriting the working Express application. If the operations domain
later requires independent scaling or ownership, the bounded module can be
extracted behind the same contracts.

## Privacy and document baseline

The implementation should treat the Australian Privacy Principles as the
minimum product baseline even if a small-business exemption might arguably apply
to a particular entity. Applicability and retention periods require Australian
legal review, especially because passports, visa/application material and client
files can be high-impact personal information and registered migration agents
have separate confidentiality and file-keeping duties.

Required product controls:

- purpose-limited collection with an approved privacy notice and field-level
  data inventory;
- tenant isolation plus case-scoped and role-scoped access; MFA/step-up for
  exports, bulk access and destructive actions;
- data minimisation, masked list views, no sensitive data in logs, URLs, analytics
  or AI prompts by default;
- access/correction, legal-hold, retention, deletion/de-identification and
  verified deletion workflows;
- immutable activity/audit evidence for view, download, upload, change, export,
  approval and deletion events;
- cross-border data-flow review before any overseas cloud or AI disclosure;
- breach detection, containment and Notifiable Data Breaches assessment runbook;
- processor/subprocessor register and contractual controls.

Reference baseline:

- OAIC APP 11 security and destruction/de-identification guidance:
  https://www.oaic.gov.au/privacy/australian-privacy-principles/australian-privacy-principles-guidelines/chapter-11-app-11-security-of-personal-information
- OAIC APP 8 cross-border guidance:
  https://www.oaic.gov.au/privacy/australian-privacy-principles/australian-privacy-principles-guidelines/chapter-8-app-8-cross-border-disclosure-of-personal-information
- OAIC NDB guidance:
  https://www.oaic.gov.au/privacy/notifiable-data-breaches/preventing-preparing-for-and-responding-to-data-breaches/data-breach-preparation-and-response/part-4-notifiable-data-breach-ndb-scheme
- OMARA client confidentiality and secure document handling:
  https://www.mara.gov.au/tools-for-agents-subsite/Files/client-confidentiality-storing-information.pdf

## S3 document design

S3 can support the storage controls, but a bucket policy alone cannot deliver the
whole solution. Use a dedicated student-document bucket in an approved region
with:

- account- and bucket-level Block Public Access, ACLs disabled and TLS-only
  access;
- SSE-KMS using a customer-managed key and separate least-privilege workload,
  scanner and break-glass roles;
- random opaque object keys and no personal data in key names;
- short-lived, authorization-checked presigned operations; never permanent or
  public object URLs;
- upload to a quarantine prefix, strict size/type controls, and no application
  read access while scan state is pending;
- GuardDuty Malware Protection for S3 (or an approved scanning worker), with
  EventBridge-driven state transition to `clean` or `quarantined`;
- deny-download behavior unless both application authorization and the clean scan
  verdict pass;
- CloudTrail S3 data events plus application audit records;
- version-aware retention/lifecycle deletion, legal holds and verified deletion;
- tested backup/recovery and security alerts for policy or public-access changes.

Object Lock should only be enabled where a confirmed retention obligation needs
immutability; indiscriminate locking can conflict with correction/deletion and
operational recovery requirements.

## CRM-like scope after HubSpot removal

The MVP already needs the useful operational core of a CRM: people/organisation
records, a case pipeline, assigned owners, tasks, due dates, notes/evidence and an
activity timeline. Build those as Open For Australia operational concepts now.

Do not build marketing automation, campaign management, lead scoring or a
general-purpose HubSpot clone in the MVP. A later phase can add inquiry/lead
capture, configurable pipelines, templates, email history and shared task queues
if validated. There is no HubSpot migration or synchronization work.

## Incremental delivery checkpoints

Every checkpoint must be independently reviewable and functional. A checkpoint
is complete only when its code, migration, authorization, functional tests,
real-estate regression tests and short evidence record all pass. Production
deployment remains a separate decision.

| Checkpoint | Demonstrable outcome | Required functional evidence |
| --- | --- | --- |
| OFA-00A — pack boundary | Nest declares a versioned, disabled-by-default `open-for-australia` contract without changing the active registry or real-estate behavior. | Contract/registry tests, fail-closed capability tests, runtime build, full real-estate regression. |
| OFA-00B — workspace authorization | An authenticated, entitled Open For Australia user can read workspace metadata; unauthenticated, wrong-tenant and unentitled calls fail closed. | HTTP/API tests for 200/401/403 and cross-tenant denial; immutable audit event assertion. |
| OFA-00C — roles/privacy contract | CEO, Operations and Advisor permissions, field classification, data-flow inventory and retention/legal-hold placeholders are represented explicitly. | Permission-matrix tests, sensitive-field masking tests and privacy-target registration tests. |
| OFA-01A — Students read slice | `/manager/open-for-australia/students` lists/searches synthetic tenant-scoped students. | Migration/RLS tests, API contract tests, Angular service/component tests and cross-tenant denial. |
| OFA-01B — Students write slice | Authorized users can create and edit a synthetic student with validation and audit history. | Validation, duplicate/idempotency, role-denial, audit and UI form tests. |
| OFA-02A — Case foundation | A student case shows stage, owner, checkpoints and append-only activity. | State-transition, append-only activity, permission and Student Case page tests. |
| OFA-02B — Tasks/actions | Users can assign, complete and filter case actions with due dates and priorities. | Task lifecycle, concurrency, authorization and UI interaction tests. |
| OFA-03 — Dashboard | Dashboard derives priorities, due dates, blocked cases and workflow counts from operational data. | Deterministic read-model fixtures, empty/error states and dashboard component tests. |
| OFA-04A — Payments read model | Manual/reference payment schedules, reconciliation states and TRUST/PTY separation are visible without claiming Xero verification. | Financial invariant, tenant isolation, status and Payments page tests. |
| OFA-04B — Controls/approvals | Signed Engagement Letter, Paid + PENDING urgency and college-payment preparation are enforced; execution remains disabled. | Blocking/urgency/approval state-machine tests and explicit no-transfer assertion. |
| OFA-05A — storage infrastructure | Dedicated private S3/KMS/quarantine design is deployed and verified before the product accepts documents. | Infrastructure policy tests, public-access denial, encryption and scan-event test evidence. |
| OFA-05B — documents | Clean scanned documents can be associated and read by authorized case users; pending/infected/unauthorized reads fail. | Upload/scan/download, retention, deletion, audit and UI tests. |
| OFA-06A — Sophia read-only | Embedded and full Sophia can explain priorities, missing documents and blocked cases from scoped APIs. | Grounding, authorization, no-cross-tenant and no-write tool tests. |
| OFA-06B — reviewed preparation | Sophia can prepare drafts/packs only through explicit review; financial and destructive execution is prohibited. | Review-gate, replay/idempotency, rejection and prohibited-action tests. |
| OFA-07 — Xero read-only | Separately authorized TRUST and PTY connections synchronize verified read models with freshness and reconciliation evidence. | OAuth/scope, webhook or polling, idempotency, retry and TRUST/PTY isolation tests. |
| OFA-08 — Xero reviewed writes | Any approved Xero write is individually scoped, MFA/review gated and auditable. | Sandbox end-to-end proof, replay protection, denial and reconciliation tests before any live authority. |

### Checkpoint review gate

At the end of each checkpoint, provide:

1. a working screen or API behavior the owner can exercise;
2. schema/API/UI changes and any migration command;
3. automated test results plus real-estate regression results;
4. privacy/security decisions and remaining risks;
5. screenshots or response examples where useful; and
6. a stop/go decision before starting the next checkpoint.

## Delivery detail

### OFA-00 — contracts, privacy and authorization foundation

- Confirm roles, field inventory, privacy notice, retention/legal-hold matrix,
  audit events and acceptance criteria.
- Define API/OpenAPI contracts and the `open_for_australia` tenant-scoped schema.
- Add business-pack boundary, permissions and cross-tenant denial tests.
- Create infrastructure-as-code design for the private quarantine/clean bucket;
  no sensitive upload feature is released before it is deployed and verified.

### OFA-01 — students and operational cases

- Student list/search/filter and create/edit flow.
- Student Case header, stage/checkpoints, assignment, tasks and append-only
  activity timeline.
- Manual/reference-only Xero IDs and payment schedule fields while Xero access is
  pending.
- Seed only synthetic fixtures; no production student data in development.

### OFA-02 — dashboard and payments controls

- Deterministic dashboard read model for priorities, due dates, blocked cases and
  workflow counts.
- Payment/reconciliation queues, exceptions and college-payment approval state.
- Enforce TRUST/PTY separation, Signed Engagement Letter blocking and Paid +
  PENDING urgency in code and database constraints where feasible.
- All financial execution remains preparation/approval only.

### OFA-03 — protected documents

- Quarantine upload, malware verdict, metadata, case association, download
  authorization, audit, retention and deletion.
- Document types for LoO, passport, Engagement Letter, proof of payment, Cover
  Letter and receipt.
- Document interpretation is introduced only after redaction/purpose/AI-provider
  boundaries are approved.

### OFA-04 — Sophia Assistant

- Read-only operational tools first: priorities, case status, missing documents,
  overdue payments and blocked reasons.
- Embedded screen context plus a dedicated assistant workspace.
- Draft/preparation actions use explicit review; financial/destructive actions
  remain prohibited or separately MFA-approved.

### OFA-05 — Xero integration

- Separate OAuth connections and authorities for TRUST and PTY.
- Idempotent import/sync, source identifiers, freshness indicators, retries,
  reconciliation evidence and webhook/polling verification.
- No Xero write scopes until read-only mapping and acceptance tests pass; later
  writes require individual approval boundaries.

## Review decisions needed before OFA-00 implementation

1. Confirm the initial roles and who can see passports, payment details and
   exports.
2. Confirm whether Open For Australia is operating through a registered migration
   agent and obtain the authoritative client-file retention requirements.
3. Confirm AWS account/region and whether GuardDuty Malware Protection for S3 is
   available and approved.
4. Confirm whether the first iteration may use synthetic data only while the
   privacy notice and document controls are finalized.
Architecture approval is complete. Items 1–4 are resolved incrementally before
their first dependent checkpoint rather than blocking the fail-closed pack
boundary.
