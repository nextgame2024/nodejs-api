ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.admin_audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.admin_audit_events FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS admin_audit_events_tenant_isolation ON __SOPHIA_RUNTIME_SCHEMA__.admin_audit_events;
CREATE POLICY admin_audit_events_tenant_isolation ON __SOPHIA_RUNTIME_SCHEMA__.admin_audit_events
  USING (customer_id = NULLIF(current_setting('sophia.tenant_id', true), '')::uuid)
  WITH CHECK (customer_id = NULLIF(current_setting('sophia.tenant_id', true), '')::uuid);

CREATE OR REPLACE FUNCTION __SOPHIA_RUNTIME_SCHEMA__.protect_admin_audit_event()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Admin audit events are append-only';
END;
$$;
DROP TRIGGER IF EXISTS protect_admin_audit_event ON __SOPHIA_RUNTIME_SCHEMA__.admin_audit_events;
CREATE TRIGGER protect_admin_audit_event BEFORE UPDATE OR DELETE
  ON __SOPHIA_RUNTIME_SCHEMA__.admin_audit_events
  FOR EACH ROW EXECUTE FUNCTION __SOPHIA_RUNTIME_SCHEMA__.protect_admin_audit_event();

CREATE INDEX IF NOT EXISTS idx_admin_audit_event_type_created
  ON __SOPHIA_RUNTIME_SCHEMA__.admin_audit_events(customer_id, event_type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_admin_audit_correlation
  ON __SOPHIA_RUNTIME_SCHEMA__.admin_audit_events(customer_id, correlation_id, created_at DESC);

CREATE TABLE IF NOT EXISTS __SOPHIA_RUNTIME_SCHEMA__.admin_audit_export_jobs (
  audit_export_job_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES __SOPHIA_RUNTIME_SCHEMA__.customers(customer_id) ON DELETE CASCADE,
  format text NOT NULL CHECK (format = 'json'),
  status text NOT NULL CHECK (status IN ('ready', 'expired')),
  filters jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(filters) = 'object'),
  as_of timestamptz NOT NULL,
  max_rows integer NOT NULL CHECK (max_rows BETWEEN 1 AND 5000),
  row_count integer NOT NULL CHECK (row_count BETWEEN 0 AND max_rows),
  created_by_identity text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  last_accessed_at timestamptz,
  access_count integer NOT NULL DEFAULT 0 CHECK (access_count >= 0),
  CHECK (expires_at > created_at),
  UNIQUE (audit_export_job_id, customer_id)
);

CREATE INDEX IF NOT EXISTS idx_admin_audit_exports_customer_created
  ON __SOPHIA_RUNTIME_SCHEMA__.admin_audit_export_jobs(customer_id, created_at DESC);

CREATE OR REPLACE FUNCTION __SOPHIA_RUNTIME_SCHEMA__.protect_admin_audit_export_job()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.customer_id IS DISTINCT FROM OLD.customer_id
     OR NEW.format IS DISTINCT FROM OLD.format
     OR NEW.filters IS DISTINCT FROM OLD.filters
     OR NEW.as_of IS DISTINCT FROM OLD.as_of
     OR NEW.max_rows IS DISTINCT FROM OLD.max_rows
     OR NEW.row_count IS DISTINCT FROM OLD.row_count
     OR NEW.created_by_identity IS DISTINCT FROM OLD.created_by_identity
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.expires_at IS DISTINCT FROM OLD.expires_at THEN
    RAISE EXCEPTION 'Audit export job identity is immutable';
  END IF;
  IF NEW.access_count < OLD.access_count
     OR NEW.access_count > OLD.access_count + 1 THEN
    RAISE EXCEPTION 'Audit export access count must advance by at most one';
  END IF;
  IF OLD.status = 'expired' AND NEW.status <> 'expired' THEN
    RAISE EXCEPTION 'Expired audit exports cannot become ready';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS protect_admin_audit_export_job ON __SOPHIA_RUNTIME_SCHEMA__.admin_audit_export_jobs;
CREATE TRIGGER protect_admin_audit_export_job BEFORE UPDATE
  ON __SOPHIA_RUNTIME_SCHEMA__.admin_audit_export_jobs
  FOR EACH ROW EXECUTE FUNCTION __SOPHIA_RUNTIME_SCHEMA__.protect_admin_audit_export_job();
DROP TRIGGER IF EXISTS protect_admin_audit_export_job_delete ON __SOPHIA_RUNTIME_SCHEMA__.admin_audit_export_jobs;
CREATE TRIGGER protect_admin_audit_export_job_delete BEFORE DELETE
  ON __SOPHIA_RUNTIME_SCHEMA__.admin_audit_export_jobs
  FOR EACH ROW EXECUTE FUNCTION __SOPHIA_RUNTIME_SCHEMA__.protect_admin_audit_event();

ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.admin_audit_export_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.admin_audit_export_jobs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS admin_audit_export_jobs_tenant_isolation ON __SOPHIA_RUNTIME_SCHEMA__.admin_audit_export_jobs;
CREATE POLICY admin_audit_export_jobs_tenant_isolation ON __SOPHIA_RUNTIME_SCHEMA__.admin_audit_export_jobs
  USING (customer_id = NULLIF(current_setting('sophia.tenant_id', true), '')::uuid)
  WITH CHECK (customer_id = NULLIF(current_setting('sophia.tenant_id', true), '')::uuid);

REVOKE ALL ON __SOPHIA_RUNTIME_SCHEMA__.admin_audit_events FROM sophia_runtime_app;
REVOKE ALL ON __SOPHIA_RUNTIME_SCHEMA__.admin_audit_export_jobs FROM sophia_runtime_app;
GRANT SELECT, INSERT ON __SOPHIA_RUNTIME_SCHEMA__.admin_audit_events TO sophia_runtime_app;
GRANT SELECT, INSERT, UPDATE ON __SOPHIA_RUNTIME_SCHEMA__.admin_audit_export_jobs TO sophia_runtime_app;
