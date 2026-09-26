# Sophia runtime database role hardening

Status: active and verified on the configured Neon database on 2026-09-23.

## Required separation

- Schema migrations authenticate as the database owner and do not assume an application role.
- Normal Sophia Runtime connections must execute as `sophia_runtime_app`.
- `sophia_runtime_app` is `NOLOGIN`, non-superuser, cannot create databases or roles, and does not have `BYPASSRLS`.
- The role has schema usage plus table DML and sequence usage only. Default privileges cover future Sophia Runtime tables and sequences created by the migration owner.
- `DatabaseService` assumes the role through the pool verification hook before a connection is handed to application code. Neon pooled connections do not accept `role` as a startup option.

Migration `010_least_privilege_runtime_role.sql` makes this setup reproducible. `SOPHIA_RUNTIME_DATABASE_ROLE` defaults to `sophia_runtime_app`; an override must be a valid PostgreSQL identifier.

## Verified behavior

A rollback-only test through the actual `DatabaseService` confirmed:

- `session_user = neondb_owner` and `current_user = sophia_runtime_app`;
- the effective role has `rolbypassrls = false`;
- a row created under one tenant context is invisible under another tenant context;
- a cross-tenant insert is rejected by row-level security;
- no synthetic verification rows were retained.

For stronger production credential isolation, a directly authenticated non-`BYPASSRLS` login role may replace the owner-plus-`SET ROLE` connection later. Until then, do not remove the pool role-assumption hook or configure the runtime with an owner/BYPASSRLS effective role.
