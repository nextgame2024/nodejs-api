CREATE TABLE IF NOT EXISTS __SOPHIA_RUNTIME_SCHEMA__.knowledge_sources (
  knowledge_source_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES __SOPHIA_RUNTIME_SCHEMA__.customers(customer_id) ON DELETE CASCADE,
  source_key text NOT NULL,
  title text NOT NULL,
  source_type text NOT NULL CHECK (source_type IN ('managed_text', 'connector_reference')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'retired')),
  created_by_identity text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  retired_at timestamptz,
  UNIQUE (customer_id, source_key),
  UNIQUE (knowledge_source_id, customer_id)
);

CREATE TABLE IF NOT EXISTS __SOPHIA_RUNTIME_SCHEMA__.knowledge_source_revisions (
  knowledge_revision_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  knowledge_source_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved', 'published', 'retired')),
  ingestion_status text NOT NULL DEFAULT 'pending' CHECK (ingestion_status IN ('pending', 'ready', 'failed', 'quarantined')),
  media_type text,
  content_text text,
  connector_binding_id uuid REFERENCES __SOPHIA_RUNTIME_SCHEMA__.connector_bindings(connector_binding_id) ON DELETE RESTRICT,
  connector_object_ref text,
  content_sha256 text,
  failure_code text,
  failure_message text,
  created_by_identity text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  approved_at timestamptz,
  published_at timestamptz,
  FOREIGN KEY (knowledge_source_id, customer_id)
    REFERENCES __SOPHIA_RUNTIME_SCHEMA__.knowledge_sources(knowledge_source_id, customer_id) ON DELETE CASCADE,
  UNIQUE (knowledge_source_id, revision),
  UNIQUE (knowledge_revision_id, customer_id),
  CHECK (
    (content_text IS NOT NULL AND connector_binding_id IS NULL AND connector_object_ref IS NULL)
    OR (content_text IS NULL AND connector_binding_id IS NOT NULL AND connector_object_ref IS NOT NULL)
  )
);

CREATE TABLE IF NOT EXISTS __SOPHIA_RUNTIME_SCHEMA__.knowledge_ingestion_jobs (
  knowledge_ingestion_job_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES __SOPHIA_RUNTIME_SCHEMA__.customers(customer_id) ON DELETE CASCADE,
  knowledge_revision_id uuid NOT NULL,
  idempotency_key text NOT NULL,
  status text NOT NULL CHECK (status IN ('processing', 'succeeded', 'failed', 'quarantined')),
  attempt_count integer NOT NULL DEFAULT 1 CHECK (attempt_count BETWEEN 1 AND 3),
  error_code text,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  FOREIGN KEY (knowledge_revision_id, customer_id)
    REFERENCES __SOPHIA_RUNTIME_SCHEMA__.knowledge_source_revisions(knowledge_revision_id, customer_id) ON DELETE CASCADE,
  UNIQUE (customer_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS __SOPHIA_RUNTIME_SCHEMA__.knowledge_snapshots (
  knowledge_snapshot_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES __SOPHIA_RUNTIME_SCHEMA__.customers(customer_id) ON DELETE CASCADE,
  knowledge_revision_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'published' CHECK (status IN ('published', 'retired')),
  published_by_identity text NOT NULL,
  published_at timestamptz NOT NULL DEFAULT now(),
  retired_at timestamptz,
  FOREIGN KEY (knowledge_revision_id, customer_id)
    REFERENCES __SOPHIA_RUNTIME_SCHEMA__.knowledge_source_revisions(knowledge_revision_id, customer_id) ON DELETE RESTRICT,
  UNIQUE (knowledge_revision_id),
  UNIQUE (knowledge_snapshot_id, customer_id)
);

CREATE TABLE IF NOT EXISTS __SOPHIA_RUNTIME_SCHEMA__.knowledge_snapshot_grants (
  knowledge_snapshot_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  capability_binding_id uuid NOT NULL REFERENCES __SOPHIA_RUNTIME_SCHEMA__.capability_bindings(capability_binding_id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (knowledge_snapshot_id, customer_id)
    REFERENCES __SOPHIA_RUNTIME_SCHEMA__.knowledge_snapshots(knowledge_snapshot_id, customer_id) ON DELETE CASCADE,
  PRIMARY KEY (knowledge_snapshot_id, capability_binding_id)
);

CREATE TABLE IF NOT EXISTS __SOPHIA_RUNTIME_SCHEMA__.knowledge_index_documents (
  knowledge_snapshot_id uuid PRIMARY KEY,
  customer_id uuid NOT NULL,
  title text NOT NULL,
  document_text text NOT NULL,
  search_vector tsvector GENERATED ALWAYS AS (to_tsvector('simple', title || ' ' || document_text)) STORED,
  FOREIGN KEY (knowledge_snapshot_id, customer_id)
    REFERENCES __SOPHIA_RUNTIME_SCHEMA__.knowledge_snapshots(knowledge_snapshot_id, customer_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_knowledge_sources_customer_status
  ON __SOPHIA_RUNTIME_SCHEMA__.knowledge_sources(customer_id, status);
CREATE INDEX IF NOT EXISTS idx_knowledge_revisions_source_revision
  ON __SOPHIA_RUNTIME_SCHEMA__.knowledge_source_revisions(knowledge_source_id, revision DESC);
CREATE INDEX IF NOT EXISTS idx_knowledge_index_search
  ON __SOPHIA_RUNTIME_SCHEMA__.knowledge_index_documents USING gin(search_vector);

CREATE OR REPLACE FUNCTION __SOPHIA_RUNTIME_SCHEMA__.protect_published_knowledge_revision()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status IN ('published', 'retired') THEN
    RAISE EXCEPTION 'Published knowledge revisions are immutable';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS protect_published_knowledge_revision ON __SOPHIA_RUNTIME_SCHEMA__.knowledge_source_revisions;
CREATE TRIGGER protect_published_knowledge_revision
  BEFORE UPDATE OR DELETE ON __SOPHIA_RUNTIME_SCHEMA__.knowledge_source_revisions
  FOR EACH ROW EXECUTE FUNCTION __SOPHIA_RUNTIME_SCHEMA__.protect_published_knowledge_revision();

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'knowledge_sources', 'knowledge_source_revisions', 'knowledge_ingestion_jobs',
    'knowledge_snapshots', 'knowledge_snapshot_grants', 'knowledge_index_documents'
  ] LOOP
    EXECUTE format('ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.%I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('DROP POLICY IF EXISTS %I ON __SOPHIA_RUNTIME_SCHEMA__.%I', table_name || '_tenant_isolation', table_name);
    EXECUTE format(
      'CREATE POLICY %I ON __SOPHIA_RUNTIME_SCHEMA__.%I USING (customer_id = NULLIF(current_setting(''sophia.tenant_id'', true), '''')::uuid) WITH CHECK (customer_id = NULLIF(current_setting(''sophia.tenant_id'', true), '''')::uuid)',
      table_name || '_tenant_isolation', table_name
    );
  END LOOP;
END $$;
