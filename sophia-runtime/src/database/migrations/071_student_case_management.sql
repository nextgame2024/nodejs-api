-- Case management extends the existing tenant-isolated case foundation.
CREATE SEQUENCE __SOPHIA_RUNTIME_SCHEMA__.student_operations_case_number_seq;
GRANT USAGE ON SEQUENCE __SOPHIA_RUNTIME_SCHEMA__.student_operations_case_number_seq TO sophia_runtime_app;
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.student_operations_cases
  ADD COLUMN course_name text CHECK (course_name IS NULL OR length(course_name) <= 200),
  ADD COLUMN advisor_name text CHECK (advisor_name IS NULL OR length(advisor_name) <= 200),
  ADD COLUMN migration_key text;
CREATE UNIQUE INDEX student_operations_case_migration_once
  ON __SOPHIA_RUNTIME_SCHEMA__.student_operations_cases(customer_id, student_id, migration_key)
  WHERE migration_key IS NOT NULL;
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.student_operations_write_requests
  DROP CONSTRAINT student_operations_write_requests_operation_check,
  ADD CONSTRAINT student_operations_write_requests_operation_check
    CHECK (operation IN ('student.create','student.update','case.create','case.update','case.link_invoice'));

-- Authoritative college directory stays in Business Manager; this narrow view
-- exposes only the current tenant's eligible IDs/names to Runtime.
CREATE VIEW __SOPHIA_RUNTIME_SCHEMA__.student_operations_college_directory
  WITH (security_barrier = true) AS
SELECT c.customer_id, b.college_id, b.college_name
  FROM __SOPHIA_RUNTIME_SCHEMA__.customers c
  JOIN public.bm_colleges b ON b.company_id::text = c.external_company_id
 WHERE c.status = 'active' AND b.status = 'active'
   AND c.customer_id = NULLIF(current_setting('sophia.tenant_id', true), '')::uuid;
GRANT SELECT ON __SOPHIA_RUNTIME_SCHEMA__.student_operations_college_directory TO sophia_runtime_app;

CREATE TABLE __SOPHIA_RUNTIME_SCHEMA__.student_operations_case_documents (
  document_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL,
  case_id uuid NOT NULL,
  xero_connection_id uuid NOT NULL,
  source_kind text NOT NULL CHECK (source_kind IN ('Invoices','CreditNotes','Contacts')),
  source_id uuid NOT NULL,
  attachment_id uuid NOT NULL,
  file_name text NOT NULL CHECK (length(file_name) BETWEEN 1 AND 255),
  mime_type text NOT NULL CHECK (length(mime_type) BETWEEN 1 AND 200),
  size_bytes bigint NOT NULL CHECK (size_bytes BETWEEN 0 AND 26214400),
  discovered_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (customer_id, case_id, xero_connection_id, source_kind, source_id, attachment_id),
  FOREIGN KEY (customer_id, case_id) REFERENCES __SOPHIA_RUNTIME_SCHEMA__.student_operations_cases(customer_id, case_id),
  FOREIGN KEY (xero_connection_id, customer_id) REFERENCES __SOPHIA_RUNTIME_SCHEMA__.xero_connections(xero_connection_id, customer_id)
);
CREATE INDEX student_operations_case_documents_case
  ON __SOPHIA_RUNTIME_SCHEMA__.student_operations_case_documents(customer_id, case_id, discovered_at, document_id);
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.student_operations_case_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.student_operations_case_documents FORCE ROW LEVEL SECURITY;
CREATE POLICY student_operations_case_documents_tenant ON __SOPHIA_RUNTIME_SCHEMA__.student_operations_case_documents
  USING (customer_id = NULLIF(current_setting('sophia.tenant_id', true), '')::uuid)
  WITH CHECK (customer_id = NULLIF(current_setting('sophia.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE ON __SOPHIA_RUNTIME_SCHEMA__.student_operations_case_documents TO sophia_runtime_app;

-- One durable discovery task per case/source. A worker processes
-- bounded tasks; page reads never enumerate attachments against Xero.
CREATE TABLE __SOPHIA_RUNTIME_SCHEMA__.student_operations_document_jobs (
  job_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL,
  case_id uuid NOT NULL,
  xero_connection_id uuid NOT NULL,
  source_kind text NOT NULL CHECK (source_kind IN ('Invoices','CreditNotes','Contacts')),
  source_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','processing','succeeded','failed')),
  attempts integer NOT NULL DEFAULT 0,
  lease_token uuid,
  lease_expires_at timestamptz,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  error_code text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(customer_id, case_id, xero_connection_id, source_kind, source_id),
  FOREIGN KEY(customer_id, case_id) REFERENCES __SOPHIA_RUNTIME_SCHEMA__.student_operations_cases(customer_id, case_id),
  FOREIGN KEY(xero_connection_id, customer_id) REFERENCES __SOPHIA_RUNTIME_SCHEMA__.xero_connections(xero_connection_id, customer_id)
);
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.student_operations_document_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.student_operations_document_jobs FORCE ROW LEVEL SECURITY;
CREATE POLICY student_operations_document_jobs_tenant ON __SOPHIA_RUNTIME_SCHEMA__.student_operations_document_jobs
  USING (customer_id = NULLIF(current_setting('sophia.tenant_id', true), '')::uuid)
  WITH CHECK (customer_id = NULLIF(current_setting('sophia.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE ON __SOPHIA_RUNTIME_SCHEMA__.student_operations_document_jobs TO sophia_runtime_app;
CREATE INDEX student_operations_document_jobs_due ON __SOPHIA_RUNTIME_SCHEMA__.student_operations_document_jobs(customer_id, status, next_attempt_at);
