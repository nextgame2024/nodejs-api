CREATE TABLE IF NOT EXISTS __SOPHIA_RUNTIME_SCHEMA__.conversation_export_jobs (
  conversation_export_job_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL,
  session_id uuid NOT NULL,
  format text NOT NULL CHECK (format = 'json'),
  export_scope text NOT NULL CHECK (export_scope IN ('metadata', 'content')),
  status text NOT NULL CHECK (status IN ('ready', 'expired')),
  as_of timestamptz NOT NULL,
  max_items integer NOT NULL CHECK (max_items BETWEEN 1 AND 5000),
  initial_item_count integer NOT NULL CHECK (initial_item_count BETWEEN 0 AND max_items),
  created_by_identity text NOT NULL CHECK (length(created_by_identity) BETWEEN 1 AND 240),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  last_accessed_at timestamptz,
  access_count integer NOT NULL DEFAULT 0 CHECK (access_count >= 0),
  FOREIGN KEY (session_id, customer_id)
    REFERENCES __SOPHIA_RUNTIME_SCHEMA__.sessions(session_id, customer_id) ON DELETE CASCADE,
  CHECK (expires_at > created_at),
  UNIQUE (conversation_export_job_id, customer_id)
);

CREATE INDEX IF NOT EXISTS idx_conversation_exports_customer_created
  ON __SOPHIA_RUNTIME_SCHEMA__.conversation_export_jobs(customer_id, created_at DESC);

CREATE OR REPLACE FUNCTION __SOPHIA_RUNTIME_SCHEMA__.protect_conversation_export_job()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Conversation export evidence cannot be deleted';
  END IF;
  IF NEW.customer_id IS DISTINCT FROM OLD.customer_id
     OR NEW.session_id IS DISTINCT FROM OLD.session_id
     OR NEW.format IS DISTINCT FROM OLD.format
     OR NEW.export_scope IS DISTINCT FROM OLD.export_scope
     OR NEW.as_of IS DISTINCT FROM OLD.as_of
     OR NEW.max_items IS DISTINCT FROM OLD.max_items
     OR NEW.initial_item_count IS DISTINCT FROM OLD.initial_item_count
     OR NEW.created_by_identity IS DISTINCT FROM OLD.created_by_identity
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.expires_at IS DISTINCT FROM OLD.expires_at THEN
    RAISE EXCEPTION 'Conversation export job identity is immutable';
  END IF;
  IF NEW.access_count < OLD.access_count OR NEW.access_count > OLD.access_count + 1 THEN
    RAISE EXCEPTION 'Conversation export access count must advance by at most one';
  END IF;
  IF OLD.status = 'expired' AND NEW.status <> 'expired' THEN
    RAISE EXCEPTION 'Expired conversation exports cannot become ready';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS protect_conversation_export_job
  ON __SOPHIA_RUNTIME_SCHEMA__.conversation_export_jobs;
CREATE TRIGGER protect_conversation_export_job BEFORE UPDATE OR DELETE
  ON __SOPHIA_RUNTIME_SCHEMA__.conversation_export_jobs
  FOR EACH ROW EXECUTE FUNCTION __SOPHIA_RUNTIME_SCHEMA__.protect_conversation_export_job();

ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.conversation_export_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.conversation_export_jobs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS conversation_export_jobs_tenant_isolation
  ON __SOPHIA_RUNTIME_SCHEMA__.conversation_export_jobs;
CREATE POLICY conversation_export_jobs_tenant_isolation
  ON __SOPHIA_RUNTIME_SCHEMA__.conversation_export_jobs
  USING (customer_id = NULLIF(current_setting('sophia.tenant_id', true), '')::uuid)
  WITH CHECK (customer_id = NULLIF(current_setting('sophia.tenant_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE ON __SOPHIA_RUNTIME_SCHEMA__.conversation_export_jobs TO sophia_runtime_app;
REVOKE DELETE ON __SOPHIA_RUNTIME_SCHEMA__.conversation_export_jobs FROM sophia_runtime_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA __SOPHIA_RUNTIME_SCHEMA__ TO sophia_runtime_app;
