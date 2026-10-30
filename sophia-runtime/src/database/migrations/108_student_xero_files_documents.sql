-- New uploads use Xero Files plus a Contact association. Existing Accounting
-- attachments remain readable and replaceable through their attachment API.
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.student_operations_case_documents
  ADD COLUMN storage_provider text NOT NULL DEFAULT 'accounting_attachment'
    CHECK(storage_provider IN ('accounting_attachment','xero_files')),
  ADD COLUMN xero_file_id uuid,
  ADD COLUMN deleted_at timestamptz,
  ADD COLUMN deleted_by_identity_user_id text,
  ADD CONSTRAINT student_document_files_identity CHECK(
    (storage_provider='accounting_attachment' AND xero_file_id IS NULL) OR
    (storage_provider='xero_files' AND xero_file_id IS NOT NULL AND xero_file_id=attachment_id));

CREATE INDEX student_case_documents_visible ON __SOPHIA_RUNTIME_SCHEMA__.student_operations_case_documents
  (customer_id,case_id,discovered_at,document_id) WHERE deleted_at IS NULL;

ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.student_operations_document_uploads
  DROP CONSTRAINT student_operations_document_uploads_status_check,
  ADD CONSTRAINT student_operations_document_uploads_status_check
    CHECK(status IN ('ready','uploading','uploaded','associated','completed')),
  ADD COLUMN storage_provider text NOT NULL DEFAULT 'accounting_attachment'
    CHECK(storage_provider IN ('accounting_attachment','xero_files')),
  ADD COLUMN provider_file_id uuid,
  ADD COLUMN provider_associated_at timestamptz,
  ADD COLUMN deleted_at timestamptz;

CREATE TABLE __SOPHIA_RUNTIME_SCHEMA__.student_operations_document_deletions (
  customer_id uuid NOT NULL,
  case_id uuid NOT NULL,
  document_id uuid NOT NULL,
  actor_identity_user_id text NOT NULL,
  idempotency_key text NOT NULL,
  request_fingerprint text NOT NULL,
  status text NOT NULL DEFAULT 'ready' CHECK(status IN ('ready','deleting','provider_deleted','completed')),
  lease_token uuid,
  lease_expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(customer_id,document_id),
  UNIQUE(customer_id,actor_identity_user_id,idempotency_key),
  FOREIGN KEY(customer_id,case_id,document_id)
    REFERENCES __SOPHIA_RUNTIME_SCHEMA__.student_operations_case_documents(customer_id,case_id,document_id),
  CHECK((status='deleting')=(lease_token IS NOT NULL AND lease_expires_at IS NOT NULL))
);
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.student_operations_document_deletions ENABLE ROW LEVEL SECURITY;
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.student_operations_document_deletions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON __SOPHIA_RUNTIME_SCHEMA__.student_operations_document_deletions
  USING(customer_id=NULLIF(current_setting('sophia.tenant_id',true),'')::uuid)
  WITH CHECK(customer_id=NULLIF(current_setting('sophia.tenant_id',true),'')::uuid);
REVOKE ALL ON __SOPHIA_RUNTIME_SCHEMA__.student_operations_document_deletions FROM PUBLIC;
GRANT SELECT,INSERT,UPDATE ON __SOPHIA_RUNTIME_SCHEMA__.student_operations_document_deletions TO sophia_runtime_app;

CREATE TABLE __SOPHIA_RUNTIME_SCHEMA__.student_operations_document_replacements (
  customer_id uuid NOT NULL,
  replacement_id uuid NOT NULL,
  case_id uuid NOT NULL,
  document_id uuid NOT NULL,
  actor_identity_user_id text NOT NULL,
  idempotency_key text NOT NULL,
  request_fingerprint text NOT NULL,
  status text NOT NULL DEFAULT 'ready' CHECK(status IN ('ready','processing','uploaded','associated','committed','completed')),
  storage_provider text NOT NULL CHECK(storage_provider IN ('accounting_attachment','xero_files')),
  old_provider_file_id uuid,
  new_provider_file_id uuid,
  provider_associated_at timestamptz,
  provider_attachment_id uuid,
  file_name text NOT NULL,
  mime_type text NOT NULL,
  size_bytes bigint NOT NULL CHECK(size_bytes>0 AND size_bytes<=10485760),
  content_sha256 text NOT NULL CHECK(content_sha256~'^[a-f0-9]{64}$'),
  lease_token uuid,
  lease_expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(customer_id,replacement_id),
  UNIQUE(customer_id,actor_identity_user_id,idempotency_key),
  FOREIGN KEY(customer_id,case_id,document_id)
    REFERENCES __SOPHIA_RUNTIME_SCHEMA__.student_operations_case_documents(customer_id,case_id,document_id),
  CHECK((lease_token IS NULL)=(lease_expires_at IS NULL))
);
CREATE UNIQUE INDEX student_document_replacement_active
  ON __SOPHIA_RUNTIME_SCHEMA__.student_operations_document_replacements(customer_id,document_id)
  WHERE status<>'completed';
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.student_operations_document_replacements ENABLE ROW LEVEL SECURITY;
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.student_operations_document_replacements FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON __SOPHIA_RUNTIME_SCHEMA__.student_operations_document_replacements
  USING(customer_id=NULLIF(current_setting('sophia.tenant_id',true),'')::uuid)
  WITH CHECK(customer_id=NULLIF(current_setting('sophia.tenant_id',true),'')::uuid);
REVOKE ALL ON __SOPHIA_RUNTIME_SCHEMA__.student_operations_document_replacements FROM PUBLIC;
GRANT SELECT,INSERT,UPDATE ON __SOPHIA_RUNTIME_SCHEMA__.student_operations_document_replacements TO sophia_runtime_app;
