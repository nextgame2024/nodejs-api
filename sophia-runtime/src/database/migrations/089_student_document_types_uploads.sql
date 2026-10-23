CREATE TABLE __SOPHIA_RUNTIME_SCHEMA__.student_operations_document_types (
  document_type_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL,
  company_id uuid NOT NULL,
  company_external_id text GENERATED ALWAYS AS (company_id::text) STORED,
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  required boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  record_version integer NOT NULL DEFAULT 1 CHECK (record_version>0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(customer_id,document_type_id),
  FOREIGN KEY(customer_id,company_external_id)
    REFERENCES __SOPHIA_RUNTIME_SCHEMA__.customers(customer_id,external_company_id)
);
CREATE UNIQUE INDEX student_document_types_active_name ON __SOPHIA_RUNTIME_SCHEMA__.student_operations_document_types
  (company_id,lower(regexp_replace(btrim(name),'[[:space:]]+',' ','g'))) WHERE status='active';
CREATE TABLE __SOPHIA_RUNTIME_SCHEMA__.student_operations_document_type_events (
  event_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL,
  document_type_id uuid NOT NULL,
  actor_identity_user_id text NOT NULL,
  event_type text NOT NULL CHECK(event_type IN ('created','updated','archived')),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(customer_id,document_type_id) REFERENCES __SOPHIA_RUNTIME_SCHEMA__.student_operations_document_types(customer_id,document_type_id)
);
CREATE TRIGGER student_document_type_events_append_only
  BEFORE UPDATE OR DELETE ON __SOPHIA_RUNTIME_SCHEMA__.student_operations_document_type_events
  FOR EACH ROW EXECUTE FUNCTION __SOPHIA_RUNTIME_SCHEMA__.protect_student_operations_student_audit_event();
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['student_operations_document_types','student_operations_document_type_events'] LOOP
    EXECUTE format('ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.%I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.%I FORCE ROW LEVEL SECURITY',t);
    EXECUTE format('CREATE POLICY tenant_isolation ON __SOPHIA_RUNTIME_SCHEMA__.%I USING (customer_id=NULLIF(current_setting(''sophia.tenant_id'',true),'''')::uuid) WITH CHECK (customer_id=NULLIF(current_setting(''sophia.tenant_id'',true),'''')::uuid)',t);
  END LOOP;
END $$;
GRANT SELECT,INSERT,UPDATE ON __SOPHIA_RUNTIME_SCHEMA__.student_operations_document_types TO sophia_runtime_app;
GRANT SELECT,INSERT ON __SOPHIA_RUNTIME_SCHEMA__.student_operations_document_type_events TO sophia_runtime_app;

ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.student_operations_case_documents
  ADD COLUMN document_type_id uuid,
  ADD CONSTRAINT student_documents_type_fk FOREIGN KEY(customer_id,document_type_id)
    REFERENCES __SOPHIA_RUNTIME_SCHEMA__.student_operations_document_types(customer_id,document_type_id);

-- Metadata only: file bytes go to Xero, never into this table. Persist provider
-- receipts before local finalization so retries cannot create new attachments.
CREATE TABLE __SOPHIA_RUNTIME_SCHEMA__.student_operations_document_uploads (
  upload_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL,
  actor_identity_user_id text NOT NULL,
  idempotency_key text NOT NULL,
  request_fingerprint text NOT NULL,
  case_id uuid NOT NULL,
  document_type_id uuid NOT NULL,
  xero_connection_id uuid NOT NULL,
  source_kind text NOT NULL CHECK(source_kind='Contacts'),
  source_id uuid NOT NULL,
  file_name text NOT NULL,
  mime_type text NOT NULL,
  size_bytes integer NOT NULL CHECK(size_bytes BETWEEN 1 AND 10485760),
  content_sha256 text NOT NULL,
  status text NOT NULL DEFAULT 'ready' CHECK(status IN ('ready','uploading','uploaded','completed')),
  lease_token uuid,
  lease_expires_at timestamptz,
  provider_attachment_id uuid,
  document_id uuid REFERENCES __SOPHIA_RUNTIME_SCHEMA__.student_operations_case_documents(document_id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(customer_id,actor_identity_user_id,idempotency_key),
  FOREIGN KEY(customer_id,case_id) REFERENCES __SOPHIA_RUNTIME_SCHEMA__.student_operations_cases(customer_id,case_id),
  FOREIGN KEY(customer_id,document_type_id) REFERENCES __SOPHIA_RUNTIME_SCHEMA__.student_operations_document_types(customer_id,document_type_id),
  FOREIGN KEY(xero_connection_id,customer_id) REFERENCES __SOPHIA_RUNTIME_SCHEMA__.xero_connections(xero_connection_id,customer_id)
);
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.student_operations_document_uploads ENABLE ROW LEVEL SECURITY;
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.student_operations_document_uploads FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON __SOPHIA_RUNTIME_SCHEMA__.student_operations_document_uploads
  USING(customer_id=NULLIF(current_setting('sophia.tenant_id',true),'')::uuid)
  WITH CHECK(customer_id=NULLIF(current_setting('sophia.tenant_id',true),'')::uuid);
GRANT SELECT,INSERT,UPDATE ON __SOPHIA_RUNTIME_SCHEMA__.student_operations_document_uploads TO sophia_runtime_app;
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.student_operations_write_requests
  DROP CONSTRAINT student_operations_write_requests_operation_check,
  ADD CONSTRAINT student_operations_write_requests_operation_check CHECK(operation IN
    ('student.create','student.update','case.create','case.create_student','case.update','case.link_invoice','document_type.create','document_type.update'));
