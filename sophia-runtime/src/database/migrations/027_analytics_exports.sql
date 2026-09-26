CREATE TABLE IF NOT EXISTS __SOPHIA_RUNTIME_SCHEMA__.analytics_export_jobs (
  analytics_export_job_id uuid PRIMARY KEY,
  customer_id uuid NOT NULL REFERENCES __SOPHIA_RUNTIME_SCHEMA__.customers(customer_id) ON DELETE CASCADE,
  format text NOT NULL CHECK (format = 'json'),
  status text NOT NULL CHECK (status IN ('ready', 'expired')),
  filters jsonb NOT NULL CHECK (jsonb_typeof(filters) = 'object'),
  as_of timestamptz NOT NULL,
  max_points integer NOT NULL CHECK (max_points BETWEEN 1 AND 5000),
  point_count integer NOT NULL CHECK (point_count BETWEEN 0 AND max_points),
  metric_registry_digest text NOT NULL CHECK (metric_registry_digest ~ '^[a-f0-9]{64}$'),
  document_digest text NOT NULL CHECK (document_digest ~ '^[a-f0-9]{64}$'),
  document jsonb,
  created_by_identity text NOT NULL CHECK (length(created_by_identity) BETWEEN 1 AND 240),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  last_accessed_at timestamptz,
  access_count integer NOT NULL DEFAULT 0 CHECK (access_count >= 0),
  CHECK (expires_at > created_at),
  CHECK ((status = 'ready' AND document IS NOT NULL) OR (status = 'expired' AND document IS NULL)),
  CHECK (document IS NULL OR octet_length(document::text) <= 5242880),
  UNIQUE (analytics_export_job_id, customer_id)
);

CREATE INDEX IF NOT EXISTS idx_analytics_exports_customer_created
  ON __SOPHIA_RUNTIME_SCHEMA__.analytics_export_jobs(customer_id, created_at DESC);

CREATE OR REPLACE FUNCTION __SOPHIA_RUNTIME_SCHEMA__.protect_analytics_export_job()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Analytics export evidence cannot be deleted';
  END IF;
  IF NEW.customer_id IS DISTINCT FROM OLD.customer_id
     OR NEW.format IS DISTINCT FROM OLD.format
     OR NEW.filters IS DISTINCT FROM OLD.filters
     OR NEW.as_of IS DISTINCT FROM OLD.as_of
     OR NEW.max_points IS DISTINCT FROM OLD.max_points
     OR NEW.point_count IS DISTINCT FROM OLD.point_count
     OR NEW.metric_registry_digest IS DISTINCT FROM OLD.metric_registry_digest
     OR NEW.document_digest IS DISTINCT FROM OLD.document_digest
     OR NEW.created_by_identity IS DISTINCT FROM OLD.created_by_identity
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.expires_at IS DISTINCT FROM OLD.expires_at THEN
    RAISE EXCEPTION 'Analytics export job identity is immutable';
  END IF;
  IF NEW.access_count < OLD.access_count OR NEW.access_count > OLD.access_count + 1 THEN
    RAISE EXCEPTION 'Analytics export access count must advance by at most one';
  END IF;
  IF OLD.status = 'expired' AND NEW.status <> 'expired' THEN
    RAISE EXCEPTION 'Expired analytics exports cannot become ready';
  END IF;
  IF NEW.document IS DISTINCT FROM OLD.document
     AND NOT (OLD.status = 'ready' AND NEW.status = 'expired' AND NEW.document IS NULL) THEN
    RAISE EXCEPTION 'Analytics export document is immutable except for expiry scrubbing';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS protect_analytics_export_job ON __SOPHIA_RUNTIME_SCHEMA__.analytics_export_jobs;
CREATE TRIGGER protect_analytics_export_job BEFORE UPDATE OR DELETE
  ON __SOPHIA_RUNTIME_SCHEMA__.analytics_export_jobs
  FOR EACH ROW EXECUTE FUNCTION __SOPHIA_RUNTIME_SCHEMA__.protect_analytics_export_job();

ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.analytics_export_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.analytics_export_jobs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS analytics_export_jobs_tenant_isolation ON __SOPHIA_RUNTIME_SCHEMA__.analytics_export_jobs;
CREATE POLICY analytics_export_jobs_tenant_isolation
  ON __SOPHIA_RUNTIME_SCHEMA__.analytics_export_jobs
  USING (customer_id = NULLIF(current_setting('sophia.tenant_id', true), '')::uuid)
  WITH CHECK (customer_id = NULLIF(current_setting('sophia.tenant_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE ON __SOPHIA_RUNTIME_SCHEMA__.analytics_export_jobs TO sophia_runtime_app;
REVOKE DELETE ON __SOPHIA_RUNTIME_SCHEMA__.analytics_export_jobs FROM sophia_runtime_app;
