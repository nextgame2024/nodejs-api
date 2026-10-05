# OFA-00C checkpoint — roles and privacy contract

Date: 5 October 2026
Decision: complete in source; stop before OFA-01A student records

## Demonstrable outcome

The authorized workspace boundary now returns the caller's fixed Open For
Australia role and exposes the versioned policy contract at:

`GET /business-packs/open-for-australia/v1/tenants/:tenantId/workspace/policy`

The contract defines three roles:

- `chief_executive`: organisation-wide operations, payment approval, export and
  privacy authority;
- `operations`: organisation-wide student/case/document work plus payment
  preparation, without payment approval, export or privacy administration; and
- `advisor`: assigned-student/case/document access plus assigned payment status,
  without organisation-wide access, payment amounts, bank references, approval
  or export.

Payment approval, report export and privacy administration are marked for
recent-MFA step-up. Navigation visibility is not authorization and cannot grant
these permissions.

## Personal-information contract

The field registry distinguishes operational, personal, restricted personal,
restricted identity, sensitive information and restricted financial data.
Projection tests enforce these initial display rules:

- list surfaces expose only explicitly list-visible fields;
- identity and sensitive fields are masked on lists;
- unassigned advisors receive no student fields;
- assigned advisors can access identity/sensitive case fields required for case
  work, but payment amounts and bank references remain masked; and
- unknown fields are never projected by the registry.

This is an output-minimisation contract for the coming APIs, not a substitute
for row-level authorization or assignment checks. OFA-01 must apply both.

## Data-flow and retention posture

The policy registers the initial first-party runtime flow and planned S3, Xero
and assistant-provider flows. No jurisdiction, retention control or deletion
control has been invented: all remain unverified and no flow is approved.

The following future datasets are registered as privacy/retention targets:

- student profiles;
- student cases and activity;
- student documents;
- payment-control records; and
- access and decision audit evidence.

Every target has a null retention duration, requires legal review, is legal-hold
aware and has automatic deletion disabled. A duration must not be configured
until the applicable Australian privacy and registered-migration-agent record
obligations are confirmed.

## Schema and deployment

Migration `061_open_for_australia_entitlement_roles.sql` adds `role_key` and
requires every active Open For Australia entitlement to use one of the three
fixed roles. It does not broaden the runtime application's ability to grant
entitlements.

Migrations 060 and 061 have not been applied to production, and no production
entitlement or role has been assigned.

## Verification

Executed with Node `v22.23.2`:

- OFA policy, workspace service/guard/controller and migration specs: 5 suites,
  15 tests passed.
- Full Sophia Runtime suite: 144 suites, 524 tests passed.
- Runtime build: passed.
- Source-boundary gate: passed, 252 source files scanned.
- Real-estate regression: 8 suites, 38 tests passed.

## Remaining decisions and risks

- Confirm whether advisors require assigned-case access to all defined sensitive
  categories; the contract permits it only within an assigned case.
- Confirm the authoritative retention schedule and legal-hold process before
  enabling deletion.
- Confirm deployment and processor jurisdictions before approving S3, Xero or
  assistant data flows.
- Implement recent-MFA enforcement with the first high-risk operation; no such
  operation exists in this checkpoint.

## Next proposed checkpoint

OFA-01A introduces only a synthetic, tenant-scoped Students read slice: schema,
RLS, search/list API and Business Manager screen. It must apply assignment
scoping and the masking contract above and must not yet accept real student data.
