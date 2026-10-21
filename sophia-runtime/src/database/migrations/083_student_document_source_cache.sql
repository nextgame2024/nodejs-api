-- Case jobs remain the UI/audit contract. Only discovery metadata (never file
-- contents, credentials or provider URLs) is shared within one tenant/source.
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.student_operations_document_jobs
  ADD COLUMN refresh_requested_at timestamptz;
CREATE TABLE __SOPHIA_RUNTIME_SCHEMA__.student_operations_document_sources (
  customer_id uuid NOT NULL,
  xero_connection_id uuid NOT NULL,
  source_kind text NOT NULL CHECK(source_kind IN ('Invoices','CreditNotes','Contacts')),
  source_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','processing','succeeded','failed')),
  attempts integer NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 5),
  lease_token uuid,
  lease_expires_at timestamptz,
  last_attempt_at timestamptz,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  checked_at timestamptz,
  attachments jsonb CHECK(jsonb_typeof(attachments)='array' AND jsonb_array_length(attachments)<=1000),
  error_code text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(customer_id,xero_connection_id,source_kind,source_id),
  FOREIGN KEY(xero_connection_id,customer_id)
    REFERENCES __SOPHIA_RUNTIME_SCHEMA__.xero_connections(xero_connection_id,customer_id)
);
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.student_operations_document_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.student_operations_document_sources FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON __SOPHIA_RUNTIME_SCHEMA__.student_operations_document_sources
  USING(customer_id=NULLIF(current_setting('sophia.tenant_id',true),'')::uuid)
  WITH CHECK(customer_id=NULLIF(current_setting('sophia.tenant_id',true),'')::uuid);
GRANT SELECT,INSERT,UPDATE ON __SOPHIA_RUNTIME_SCHEMA__.student_operations_document_sources TO sophia_runtime_app;
CREATE INDEX student_document_jobs_source
  ON __SOPHIA_RUNTIME_SCHEMA__.student_operations_document_jobs(customer_id,xero_connection_id,source_kind,source_id,status);
