# Sophia Admin scope and permissions audit

## Hosting decision

Use Business Manager as the UI host: add a sibling, lazy-loaded `/sophia-admin` feature in the existing Angular deployment. Reuse its authenticated shell, identity records, tenant/company identity, branding, and navigation presentation where verified. Build dedicated `/api/admin/v1` APIs and enforce tenant/resource permissions on the server. Do not treat a hidden link, Angular route guard, user `type`, or the existing hardcoded super-admin identifier as authority.

A separate frontend is not justified by P0 evidence. Reconsider only for a verified need such as separate compliance boundary, release ownership, or deployment isolation. Backend ownership may remain split: Business Manager continues as business-record authority while the Nest control plane owns versioned Sophia configuration.

## Fixed MVP role templates

| Role | Intended grant boundary |
|---|---|
| Organisation owner | Tenant governance and membership; protected final owner; no platform privilege |
| Configuration editor | Draft agents, instructions, approved knowledge and permitted bindings; no publish by default |
| Release publisher | Validate/publish/rollback within granted tenant resources; cannot grant itself roles |
| Operations member | Permitted operational metadata and assigned escalations; content/export are separate grants |
| Billing administrator | Approved tenant commercial/portal operations; no transcript or publishing access by default |
| Read-only auditor | Permitted metadata/audit reads; personal content and exports require separate grants |

Roles are templates. Domain code must check named permissions and tenant/resource ownership.

P6-01 integration validation corrected one unreachable mapping: the shared
configuration-read boundary includes `escalations.read`, and Configuration Editor
owns `escalations.configure`. Escalation case assignment and resolution remain
Operations Member permissions; Organisation Owner receives readiness visibility,
not escalation edit authority.

P6-A04 grants `audit.export` to Organisation Owner behind the existing recent-MFA
gate. Read-only Auditor retains `audit.read` but does not receive export authority.

P6-03A grants Organisation Owner `privacy.read/manage/approve`,
`privacy.requests.manage` and `privacy.holds.manage`. Approval, subject-request and
hold operations require recent MFA. Read-only Auditor receives `privacy.read`
only; no role can bypass tenant ownership or use an agent instruction to enable
recording, transcript persistence or marketing.

P6-03B keeps privacy execution on `privacy.requests.manage` with recent MFA and
requires immutable per-target evidence before completion. The Business Manager
owner adapter requires the dedicated `bm:real-estate:privacy:write` service
scope; that scope is deliberately absent from the tenant connector's ordinary
configurable scope list, and the legacy broad integration token is rejected.

P6-A01A keeps conversation metadata, content and annotation as distinct API
permissions. Operations Member retains metadata and annotation only; content
requires the separate `conversations.read_content` permission and recent MFA.
The Runtime currently retains neither full transcripts nor raw audio, so those
assets are reported unavailable rather than reconstructed from operational logs.

P6-A01B adds `conversations.export` as a separate recent-MFA boundary. Export
authority alone can create/download metadata manifests; content-scoped exports
also require `conversations.read_content`. Manifests expire after 24 hours and
store no generated content copy. JSON is rendered on authorised access against
current privacy/retention state and audited with a SHA-256 digest.

## Sixteen-module source audit

| ID / route | Required permission families | Existing reusable surface | Verified gap / P0 status |
|---|---|---|---|
| ADM-01 Organisations `/sophia-admin/organisations` | `platform.organisations.provision`, `organisation.read/manage/suspend` | Company records/screens and branding | Partial. No safe platform/tenant lifecycle, memberships, suspension policy, or resource permissions. |
| ADM-02 Users `/sophia-admin/users` | `users.read/invite/manage`, `users.roles.assign` | User records, login, basic management UI | Partial. No invitations, tenant memberships, fixed roles, final-owner rule, or permission enforcement. |
| ADM-03 Agents `/sophia-admin/agents` | `agents.read/edit/publish/disable` | Tenant agent drafts, releases and safe authoring-dependency API | Complete with limits. Neutral list/editor, immutable selectors, validation and deterministic no-effects preview are delivered. Published profile authoring and a live metered sandbox remain separate controls. |
| ADM-04 Agent versions `/sophia-admin/agent-versions` | `agent_versions.read/publish/rollback` | Immutable release manifests and session pins | Complete with limits. Diff, server publication checks, release history, publish, rollback and MFA-gated revocation UI are delivered; authenticated browser E2E remains unavailable. |
| ADM-05 Instructions `/sophia-admin/instructions` | `instructions.read/edit/test` | Tenant instruction sets and immutable approved revisions | Complete with limits. Draft revisions, scalar variables, fixed safety-policy separation and approval are delivered; preview is deterministic and deliberately does not open a provider session. |
| ADM-06 Knowledge `/sophia-admin/knowledge` | `knowledge.read/edit/ingest/publish/retire` | Managed-text lifecycle, deployment-gated private-file intake and granted snapshot retrieval | Complete with limits. Generic revisions, approval, ingestion status, publication grants, preview and retirement are delivered. Private files remain fail-closed until storage/scanner/worker readiness passes. |
| ADM-07 Tools `/sophia-admin/tools` | `tools.read/bind/test` | Compiled runtime tool/policy registry and draft capability bindings | Complete with limits. Safe schemas and policy are inspectable, synthetic tests have no external effects, and active compatible connectors can bind only to draft profiles. Business-profile creation remains in its owning control plane. |
| ADM-08 Connectors `/sophia-admin/connectors` | `connectors.read/manage/test`, `connectors.credentials.rotate` | Compiled connector registrations and tenant binding lifecycle | Complete for the current runtime-scoped connector. Scope disclosure, tenant-account verification, health, reconnect, disconnect and reconciliation states are delivered without secret exposure. OAuth expiry/re-consent and tenant credential rotation remain unsupported until a connector explicitly implements them. |
| ADM-09 Workflows `/sophia-admin/workflows` | `workflows.read/configure/publish/retry` | Compiled template/version and authoritative owner-run APIs | Complete with limits. Constant-only schema configuration, immutable version publication and aggregate owner status UI are delivered. The current owner declares retry unsupported and no durable step graph exists. |
| ADM-10 Permissions `/sophia-admin/permissions` | `permissions.read/assign`, `platform.support.access` | JWT authentication and company scoping | Missing. Existing menu/user-type behavior is not deny-by-default authorization. |
| ADM-11 Escalations `/sophia-admin/escalations` | `escalations.read/configure/assign/resolve` | Runtime durable policy/case APIs and internal operations inbox | Complete with limits. Supported destination/policy authoring, channel availability, event evidence and optimistic assign/start/resolve UI are delivered. External callback/notification/live transfer remain unavailable without a compiled executable adapter. |
| ADM-12 Conversations `/sophia-admin/conversations` | `conversations.read_metadata/read_content/export/annotate` | Runtime session/tool/review/event records linked to existing workflow and escalation state | Complete with limits. Tenant filters, normalized timeline, retention-aware content, privacy-aware notes, expiring no-copy exports and the Angular workspace are delivered. Transcript/audio playback remains unavailable because no consent-bound retained asset exists; fixed Operations Member has metadata/annotation only. |
| ADM-13 Evaluations `/sophia-admin/evaluations` | `evaluations.read/edit/run/approve` | Shared deterministic agent publication-check contract | Delivered tenant datasets, pinned immutable runs/results and exact-draft publication evidence. Live/provider-judged runs remain unavailable pending separate authority, data-policy and budget gates. |
| ADM-14 Analytics `/sophia-admin/analytics` | `analytics.read/export` | Versioned core/pack metric registry, canonical runtime aggregates and expiring aggregate snapshots | Complete with limits. The workspace exposes filters, definitions, denominators, timezone, freshness, coverage, source-confirmed outcome separation and currency/version/status-separated estimates. Organisation Owner can create digest-verified 24-hour aggregate-only exports; Operations Member and Read-only Auditor remain read-only. Materialized aggregates remain deferred until measured scale requires them. |
| ADM-15 Audit logs `/sophia-admin/audit-logs` | `audit.read/export` | Existing Admin audit ledger plus privileged request outcomes | Delivered with limits. FORCE RLS, append-only grants/triggers, recursive redaction, correlation filters and MFA-gated bounded exports are implemented. Retention deletion/legal-hold automation remain unavailable until an approved policy exists. |
| ADM-16 Usage/Billing `/sophia-admin/usage-billing` | `usage.read`, `usage.limits.manage`, `billing.read/manage` | Existing Stripe one-time Toolkit/video payment flows | Sophia module missing. No usage ledger, plans/rates/subscriptions/reconciliation. Existing payments remain isolated. |

## Permission rules to carry into P1

- Public runtime credentials cannot call Admin APIs.
- Every API checks permission plus tenant/resource ownership; UI guards improve navigation only.
- Configuration editing, publishing, transcript content, export, credentials, support access, and billing are distinct grants.
- Platform support access is explicit, time-bound, and audited.
- Secret values never appear in list/read DTOs, release manifests, diffs, logs, or exports.
- A user cannot self-elevate, grant platform access, cross tenants, or remove the final organisation owner.
- Live billing stays disabled until commercial policy and a separate activation gate are approved.

## Unresolved decisions

P1 must verify the identity/session refresh mechanism, membership storage, account suspension semantics, Admin API owner (Nest versus a dedicated module boundary), and support-access workflow. Later billing work needs approved prices, units, currency, tax, overage/refund policy, provider account, webhook mapping, and reconciliation. None is inferred in P0.
