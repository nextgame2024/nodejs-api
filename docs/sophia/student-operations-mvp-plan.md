# Student Operations operations MVP — gap analysis and proposed plan

Date: 5 October 2026  
Status: architecture and delivery order approved; OFA-00A through OFA-01E complete; OFA-07A reviewed discovery superseded by OFA-07B durable Xero synchronization in source

## Current Students register delivery plan — 13 October 2026

The new `/manager/students` module is tracked in
[students-module-delivery-plan.json](students-module-delivery-plan.json).
STU-01 and STU-02 are implemented locally and verified on isolated PostgreSQL
fixtures. STU-03's prototype-aligned frontend is implemented locally and passes
the Angular build and targeted browser tests. STU-04 through STU-06 are not
started, and document/OpenAI extraction is the later STU-07 task. The next task
is STU-04: Student actions and the minimum case workflow.

This updates the Students scope to the supplied multi-case register prototype.
Existing Student users and their `STD-N` identifiers remain authoritative for
identity. The current runtime operational-student UUID is a separate identity
that must be explicitly mapped. Cases own workflow, advisor/college relationships,
documents and financial associations. The register has one row per student,
server-side pagination, summary cards, an attention panel and case links.

The renamed Payments and Control page remains the Xero transaction register.
Its component is still located under `student-operations/students`, whereas the
new Students route currently renders the placeholder under `manager/students`.
Older missing-capability statements and checkpoint descriptions below are the
original phased baseline; consult the new plan's source findings for this
register's current state. The operator reports migration 069 was applied in
Render; we have not independently verified that or run the user/profile backfill.
The STU-02 migration 070 and API have not been deployed.

### STU-02 register API handoff

The guarded `GET /business-packs/student-operations/v1/workspace/student-register`
endpoint reads the tenant-scoped Student roster, case model and payment schedule
without creating profiles or starting provider sync. It accepts bounded
`page`/`limit`, `q`, `status`, `advisorId`, `collegeId`, complete `from`/`to`
date pairs, `attentionThisWeek=true`, and whitelisted `sortBy`/`sortDir` values.
Dates filter case `opened_on`; Students without cases use their account-created
date. Its response includes one row per Student account, authorized case links,
same-case advisor/college context, a permission-aware next payment, exact total,
summary cards, deterministic attention count, unavailable-trend marker and
authorized filter options. A Student can be listed without a runtime profile;
the case action in STU-04 will establish one on demand.

Migration `070_student_register_advisor_projection.sql` creates a narrow,
tenant-filtered advisor-name view and a user-name sorting index. Deploy this
migration with the new API before using the Students register. The normal
runtime database role must remain restricted; the migration runner needs the
database-owner URL. No data backfill is required merely to list existing
Student users. The isolated SQL suite includes a 1,000-student `EXPLAIN ANALYZE`
check and cross-tenant/advisor regression tests; production data and plans were
not inspected.

### STU-01 schema and identity handoff

Migration `sophia-runtime/src/database/migrations/069_student_case_foundation.sql`
adds a constrained `public.users` → runtime profile link, case, college, case
advisor/college, reviewed invoice-to-case, payment schedule and append-only
case activity tables. All new runtime tables enforce tenant RLS. Existing
`STD-N` IDs, invoices, and operational student UUIDs are left unchanged. The
runtime receives a narrow, tenant-filtered roster view, without access to
`public.users` credentials. The `ensure_student_operations_profile(uuid)`
function supports explicit, authorized case creation for newly created Student
accounts; list reads and Xero refresh do not invoke it. STU-04 must call it
inside a tenant-scoped transaction after application permission checks.

The repeatable backfill is `sophia-runtime/scripts/backfill-student-profiles.ts`.
It links a legacy operational profile only when its `STD-N` reference, legal
name and email all agree with the Student account. A legacy profile with a
matching name or email but a different reference is reported as pending for
manual review. It never creates users or cases. A new profile is created only
when no candidate profile exists. The command reports counts and unresolved
account IDs without printing personal names or email addresses.

Before any deployed backfill, apply runtime migrations using the configured
database owner. The deployed image must contain migration 069; verify it exists
in the built migrations directory and that the prior Business Manager Student
ID and Xero sync migrations were applied. Supply `OWNER_DATABASE_URL` securely
in the backend shell, then from the `sophia-runtime` source directory run:

```sh
./node_modules/.bin/tsx scripts/backfill-student-profiles.ts --preview
./node_modules/.bin/tsx scripts/backfill-student-profiles.ts --apply
```

Use `--customer-id UUID` to scope either command to one tenant. Preview first;
resolve its pending and unmapped-company report before treating backfill as
complete. Applying again is safe: already linked users keep their profile UUID.
The script uses only `OWNER_DATABASE_URL`; ordinary runtime database credentials
must not be used. Neither command is automatically triggered by page reads,
sync runs or service startup.

Local STU-01 evidence: five integration cases passed against a fresh, disposable
PostgreSQL 17 database, covering preview/apply/retry, two cases per student,
separate advisors and colleges, foreign-key isolation, roster RLS, and an
explicit on-demand profile. The backfill command's `--preview --customer-id`
path returned a pending legacy match without changing it. Fourteen existing
Student Operations tests, 38 real-estate regression tests, the v2 boundary
check, Runtime typecheck and build passed. The broad spec-only TypeScript sweep
still reports errors in unrelated existing specs; it is not a build failure.
Production data was not inspected; the operator must review preview conflicts
against the deployed schema before running `--apply`.

## Product boundary

Student Operations will be a client-specific operations workspace inside
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
| NestJS Sophia Runtime with tenant context, PostgreSQL migrations, RLS-oriented data model, authorization, immutable audit, workflows, escalations, privacy control plane and connector authority | Reuse as the host for a new `student-operations` business pack and its domain API. |
| Sophia conversation/orchestration and tool registry | Reuse after deterministic operational read models exist; tools call domain services rather than tables directly. |
| Real-estate business pack and deterministic tests | Preserve unchanged; it is a regression boundary, not a template to copy wholesale. |
| Existing Business Manager `Documents` module | Do not reuse as a student file vault. It models commercial quotes/invoices and lacks the quarantine/scanning/access lifecycle required for identity documents. |
| Existing generic S3 helper | Do not use for student documents. It includes legacy public-URL behavior and static application credentials and does not enforce scan-before-read. |
| Existing privacy Admin controls | Reuse the policy/evidence patterns; extend them with Student Operations data-flow, retention, access/correction and erasure targets. |

## Missing from the proposed MVP

- No Student Operations operational schema, RLS policies or API contracts.
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
- No Student Operations Sophia tools or grounded operational assistant.
- No approved privacy notice, collection-purpose catalogue, retention schedule,
  breach runbook or registered-migration-agent record schedule.

## Architecture decision

Use an incremental NestJS business pack, not an Express rewrite and not a third
deployable service for the MVP:

1. Keep the existing Express API responsible for legacy Business Manager
   company/user/navigation functions.
2. Add `student-operations` as a new bounded business pack in the existing NestJS
   Sophia Runtime. It owns the new operational tables, DTO validation, domain
   rules, RLS, permissions, audit events and APIs.
3. Add the new Angular routes under Business Manager and call the Nest domain API
   through the established authenticated runtime boundary.
4. Integrate Xero through the connector-authority layer and durable local read
   models. Browser list/search requests never depend on provider availability;
   scheduled, webhook and manual refresh triggers share the same leased queue.
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
activity timeline. Build those as Student Operations operational concepts now.

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
| OFA-00A — pack boundary | Nest declares a versioned, disabled-by-default `student-operations` contract without changing the active registry or real-estate behavior. | Contract/registry tests, fail-closed capability tests, runtime build, full real-estate regression. |
| OFA-00B — workspace authorization | An authenticated, entitled Student Operations user can read workspace metadata; unauthenticated, wrong-tenant and unentitled calls fail closed. | HTTP/API tests for 200/401/403 and cross-tenant denial; immutable audit event assertion. |
| OFA-00C — roles/privacy contract | CEO, Operations and Advisor permissions, field classification, data-flow inventory and retention/legal-hold placeholders are represented explicitly. | Permission-matrix tests, sensitive-field masking tests and privacy-target registration tests. |
| OFA-01A — Students read slice | `/manager/student-operations/students` lists/searches synthetic tenant-scoped students. | Migration/RLS tests, API contract tests, Angular service/component tests and cross-tenant denial. |
| OFA-01B — Workspace profile and dashboard shell | A super-admin-selected `workspace_profile` switches the Business Manager home between the existing project map and the student-operations dashboard without loading Google Maps for the latter. | Safe-default migration, server-authorized profile mutation, accurate empty/error/dashboard states, Angular build and real-estate regression. |
| OFA-01C — Students UI alignment | Students uses the established Business Manager controls, list styling and infinite loading without changing the tenant authorization boundary. | Shared-control component tests, filter/error/empty-state tests and production build. |
| OFA-01D — User role administration | Super Admin assigns or revokes named Student Operations roles per user for a student-operations company. | Super-admin denial, named-role validation, tenant/RLS context, revision/audit assertions and API/UI tests. |
| OFA-01E — Students write slice | Authorized users can create and edit a student with validation and audit history after the real-data onboarding gate is approved. | Validation, duplicate/idempotency, role-denial, audit and UI form tests. |
| OFA-02A — Case foundation | A student case shows stage, owner, checkpoints and append-only activity. | State-transition, append-only activity, permission and Student Case page tests. |
| OFA-02B — Tasks/actions | Users can assign, complete and filter case actions with due dates and priorities. | Task lifecycle, concurrency, authorization and UI interaction tests. |
| OFA-03 — Dashboard expansion | The dashboard adds due dates, payment controls, blocked-case reasons and workflow counts as those operational read models become available. | Deterministic read-model fixtures, empty/error states and dashboard component tests. |
| OFA-04A — Payments read model | Manual/reference payment schedules, reconciliation states and TRUST/PTY separation are visible without claiming Xero verification. | Financial invariant, tenant isolation, status and Payments page tests. |
| OFA-04B — Controls/approvals | Signed Engagement Letter, Paid + PENDING urgency and college-payment preparation are enforced; execution remains disabled. | Blocking/urgency/approval state-machine tests and explicit no-transfer assertion. |
| OFA-05A — storage infrastructure | Dedicated private S3/KMS/quarantine design is deployed and verified before the product accepts documents. | Infrastructure policy tests, public-access denial, encryption and scan-event test evidence. |
| OFA-05B — documents | Clean scanned documents can be associated and read by authorized case users; pending/infected/unauthorized reads fail. | Upload/scan/download, retention, deletion, audit and UI tests. |
| OFA-06A — Sophia read-only | Embedded and full Sophia can explain priorities, missing documents and blocked cases from scoped APIs. | Grounding, authorization, no-cross-tenant and no-write tool tests. |
| OFA-06B — reviewed preparation | Sophia can prepare drafts/packs only through explicit review; financial and destructive execution is prohibited. | Review-gate, replay/idempotency, rejection and prohibited-action tests. |
| OFA-07 — Xero read-only | Separately authorized TRUST and PTY connections synchronize verified read models with freshness and reconciliation evidence. | OAuth/scope, webhook or polling, idempotency, retry and TRUST/PTY isolation tests. |
| OFA-07A — Xero student discovery | A Chief Executive can explicitly scan recent TRUST sales invoices, review distinct Xero contacts and prefill a student record without silently importing or overwriting operational data. | Granular read-scope, tenant/role denial, bounded-provider-read, candidate mapping and Angular review-flow tests. |
| OFA-07B — durable Xero student read model | Normal page, search and infinite-scroll requests read tenant-scoped PostgreSQL projections; manual refresh enqueues a resumable sync, preserves stale data on failure and exposes freshness without repeated consent. Provider pages use batched idempotent upserts with durable progress checkpoints and lease renewal; browser status polling uses bounded backoff while the worker continues independently. | Migration/RLS, durable lease/idempotency and recovery, batched incremental paging and progress, rate-limit/error classification, backend candidate search, bounded Angular refresh polling/infinite-scroll and real-estate regression tests. |
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
- Define API/OpenAPI contracts and the `student_operations` tenant-scoped schema.
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
- Review invoice-derived Xero contacts from the local projection and explicitly
  link accepted candidates; never infer that every accounting contact is a student.

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
2. Confirm whether Student Operations is operating through a registered migration
   agent and obtain the authoritative client-file retention requirements.
3. Confirm AWS account/region and whether GuardDuty Malware Protection for S3 is
   available and approved.
4. Confirm whether the first iteration may use synthetic data only while the
   privacy notice and document controls are finalized.
Architecture approval is complete. Items 1–4 are resolved incrementally before
their first dependent checkpoint rather than blocking the fail-closed pack
boundary.
