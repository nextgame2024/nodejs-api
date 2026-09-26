# Sophia realtime P2-A02 checkpoint

Checkpoint date: 2026-09-23 (Australia/Brisbane)

## Delivered locally

- Added revisioned organisation settings and admission suspension/resumption APIs. Settings and lifecycle writes use optimistic concurrency and write their audit event in the same database transaction.
- Added tenant-scoped member listing and role/status mutation. Every mutation increments `authorization_revision`, clears permission overrides, prevents self-change and refuses to demote, suspend or revoke the final active organisation owner.
- Added dry-run invitation issue, list, revoke and redemption APIs. Invitation tokens are random, returned once, stored only as SHA-256 hashes, bound to a normalised recipient email and Business Manager company, expire, and are single-use.
- Added the fixed role/permission registry endpoint. Role values are validated both at the API boundary and by PostgreSQL constraints; custom roles and permission-elevation overrides remain disabled.
- Refactored Admin principal resolution through a tenant-scoped transaction so membership RLS is effective. Membership status is checked on every Admin request, so a revoked membership cannot retain access through a stale Admin principal.
- Suspended organisations can still enter the Admin control plane to resume service, but `ConversationService` rejects new session admission before provider allocation. Existing sessions, records, bookings and durable queues are not cancelled or deleted.
- Extended Admin audit recording with resource identity and transaction-aware writes.

## Database and isolation

Migration `011_organisation_membership_lifecycle.sql` was applied transactionally to the configured Neon PostgreSQL 17 database with explicit user authorization. It adds organisation lifecycle revision fields, invitation storage, fixed-role constraints, and enables and forces tenant RLS on `admin_memberships`.

A rollback-only verification through the real `DatabaseService` confirmed `session_user = neondb_owner`, `current_user = sophia_runtime_app`, `BYPASSRLS=false`, membership RLS enabled/forced, the role constraint installed, invitation writes available to the runtime role, and zero retained synthetic rows. The runtime role correctly cannot read the owner-only public migration ledger.

`admin_invitations` deliberately does not use tenant-session RLS because an unaffiliated recipient must resolve a tenant from an unguessable token before a tenant transaction exists. Only a SHA-256 token hash is stored; redemption then locks the invitation inside the resolved tenant transaction and verifies status, expiry, recipient email and Business Manager company before creating membership.

## Verification

- Focused authorization/lifecycle/migration tests — pass, 3 suites and 12 tests.
- Full runtime suite under Node 22.23.2 — pass, 30 suites and 123 tests.
- Runtime typecheck and build — pass.
- Nest dependency graph and all new routes initialized successfully; sandbox socket binding was denied only after initialization.
- Boundary scan — pass, 41 new-product source files.
- Protected real-estate suite — pass, 7 suites and 30 tests.
- Provider-neutral contract suite — pass, 15 tests.
- Business Manager release suite — pass, 16 suites and 66 tests; 4 suites/12 SQL-gated tests skipped.

No live provider, email, payment, subscription or invitation delivery was invoked.

## Remaining limitations and next task

- Invitations intentionally support `deliveryMode: "dry-run"` only. The returned token must be transferred through a controlled test/onboarding channel until an approved delivery integration exists.
- No Admin membership is auto-seeded. Initial owner onboarding still requires an authorised operational database step using a verified Business Manager identity reference; automatic or anonymous bootstrap would weaken the identity boundary.
- The current Business Manager identity response supplies no verified MFA timestamp. Invitation role assignment, membership role/status changes and organisation suspension/resumption therefore fail closed until Business Manager provides trustworthy MFA evidence.
- The runtime assumes the non-`BYPASSRLS` `sophia_runtime_app` effective role. A separately authenticated least-privilege login credential remains optional stronger production hardening because the configured session credential is still the owner.

P2-05 is next in roadmap order: make provider setup, allocation recovery, cleanup and tool-event ownership operationally safe.
