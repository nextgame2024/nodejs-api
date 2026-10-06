# OFA-01D checkpoint — User role administration

Date: 6 October 2026
Decision: complete in source; production use waits for OFA-01B migration

## Outcome

The Super Admin Users form exposes an Open For Australia role selector only when
the selected company has `workspace_profile = student_operations`. The model is
generic business-pack assignment data (`packId`, `roleKey`, `status`) rather than
an Open For Australia boolean, allowing later workspace profiles and packs to
define their own named roles.

Assigning, changing or removing a role updates the existing runtime entitlement,
increments its authorization revision and appends an audit event. The endpoint
is Super-Admin-only, validates role names, resolves exactly one active runtime
customer and establishes the tenant database context before touching RLS data.

Removing the role revokes the entitlement. It does not delete the Business
Manager user or company membership.

## Evidence

- Named-role and no-boolean HTTP contract test passed.
- Backend source/security assertions passed.
- Backend release and boundary suites passed.
- Angular production build passed.

