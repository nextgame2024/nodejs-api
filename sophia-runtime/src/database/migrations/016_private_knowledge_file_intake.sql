CREATE TABLE IF NOT EXISTS __SOPHIA_RUNTIME_SCHEMA__.knowledge_file_intakes (
  knowledge_file_intake_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES __SOPHIA_RUNTIME_SCHEMA__.customers(customer_id) ON DELETE CASCADE,
  knowledge_source_id uuid NOT NULL,
  knowledge_revision_id uuid,
  idempotency_key text NOT NULL,
  status text NOT NULL DEFAULT 'awaiting_upload' CHECK (status IN (
    'awaiting_upload', 'queued', 'processing', 'succeeded', 'quarantined', 'failed'
  )),
  object_key text NOT NULL,
  original_filename text NOT NULL,
  media_type text NOT NULL CHECK (media_type IN ('text/plain', 'text/markdown')),
  declared_bytes integer NOT NULL CHECK (declared_bytes BETWEEN 1 AND 1048576),
  declared_sha256_base64 text NOT NULL,
  scan_engine text,
  scan_signature text,
  parser_version text,
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 3),
  lease_owner text,
  lease_expires_at timestamptz,
  error_code text,
  error_message text,
  created_by_identity text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  upload_verified_at timestamptz,
  processing_started_at timestamptz,
  completed_at timestamptz,
  FOREIGN KEY (knowledge_source_id, customer_id)
    REFERENCES __SOPHIA_RUNTIME_SCHEMA__.knowledge_sources(knowledge_source_id, customer_id) ON DELETE CASCADE,
  FOREIGN KEY (knowledge_revision_id, customer_id)
    REFERENCES __SOPHIA_RUNTIME_SCHEMA__.knowledge_source_revisions(knowledge_revision_id, customer_id) ON DELETE RESTRICT,
  UNIQUE (customer_id, idempotency_key),
  UNIQUE (object_key)
);

CREATE INDEX IF NOT EXISTS idx_knowledge_file_intakes_claim
  ON __SOPHIA_RUNTIME_SCHEMA__.knowledge_file_intakes(customer_id, status, created_at)
  WHERE status IN ('queued', 'processing', 'failed');

ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.knowledge_file_intakes ENABLE ROW LEVEL SECURITY;
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.knowledge_file_intakes FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS knowledge_file_intakes_tenant_isolation ON __SOPHIA_RUNTIME_SCHEMA__.knowledge_file_intakes;
CREATE POLICY knowledge_file_intakes_tenant_isolation ON __SOPHIA_RUNTIME_SCHEMA__.knowledge_file_intakes
  USING (customer_id = NULLIF(current_setting('sophia.tenant_id', true), '')::uuid)
  WITH CHECK (customer_id = NULLIF(current_setting('sophia.tenant_id', true), '')::uuid);
