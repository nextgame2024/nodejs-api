DO $$
DECLARE
  existing_role record;
BEGIN
  SELECT rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls
    INTO existing_role
    FROM pg_roles
    WHERE rolname = 'sophia_runtime_app';

  IF NOT FOUND THEN
    CREATE ROLE sophia_runtime_app NOLOGIN;
  ELSIF existing_role.rolcanlogin OR existing_role.rolsuper OR existing_role.rolcreatedb
     OR existing_role.rolcreaterole OR existing_role.rolreplication OR existing_role.rolbypassrls THEN
    RAISE EXCEPTION 'Existing sophia_runtime_app role is not least privilege';
  END IF;

  EXECUTE format('GRANT sophia_runtime_app TO %I WITH SET TRUE', current_user);
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO sophia_runtime_app', current_database());
END;
$$;

GRANT USAGE ON SCHEMA __SOPHIA_RUNTIME_SCHEMA__ TO sophia_runtime_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA __SOPHIA_RUNTIME_SCHEMA__ TO sophia_runtime_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA __SOPHIA_RUNTIME_SCHEMA__ TO sophia_runtime_app;

ALTER DEFAULT PRIVILEGES IN SCHEMA __SOPHIA_RUNTIME_SCHEMA__
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO sophia_runtime_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA __SOPHIA_RUNTIME_SCHEMA__
  GRANT USAGE, SELECT ON SEQUENCES TO sophia_runtime_app;
