# Sophia runtime database role hardening

Status: active and verified on the configured Neon database on 2026-09-27.

## Required separation

- Schema migrations authenticate as the database owner and do not assume an application role.
- Normal Sophia Runtime connections must execute as `sophia_runtime_app`.
- Normal connections authenticate as the dedicated `sophia_runtime_login`; they must never authenticate as the migration owner.
- `sophia_runtime_app` is `NOLOGIN`, non-superuser, cannot create databases or roles, and does not have `BYPASSRLS`.
- The role has schema usage plus table DML and sequence usage only. Default privileges cover future Sophia Runtime tables and sequences created by the migration owner.
- `DatabaseService` assumes the role through the pool verification hook before a connection is handed to application code. Neon pooled connections do not accept `role` as a startup option.

Migration `010_least_privilege_runtime_role.sql` makes this setup reproducible. `SOPHIA_RUNTIME_DATABASE_ROLE` defaults to `sophia_runtime_app`; an override must be a valid PostgreSQL identifier.

## Verified behavior

A catalog and deployed-health verification confirmed:

- the deployed pooled connection authenticates as `session_user = sophia_runtime_login` and assumes `current_user = sophia_runtime_app` through the pool verification hook;
- `sophia_runtime_login` is `NOINHERIT`, non-superuser, cannot create databases or roles, has no replication or `BYPASSRLS`, and its only membership is `sophia_runtime_app` with `SET` but without admin authority;
- the effective role has `rolbypassrls = false`;
- a row created under one tenant context is invisible under another tenant context;
- a cross-tenant insert is rejected by row-level security;
- no synthetic verification rows were retained.

The owner credential remains migration-only. Do not replace `sophia_runtime_login` with `neondb_owner`, remove the pool role-assumption hook, grant the login role owner membership, or configure an effective role with `BYPASSRLS`.
