-- Add document-only destinations; never change the student's billing primary.
CREATE TABLE __SOPHIA_RUNTIME_SCHEMA__.student_operations_document_contacts (
  storage_contact_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL,
  student_id uuid NOT NULL,
  xero_connection_id uuid NOT NULL,
  xero_contact_id uuid,
  kind text NOT NULL CHECK(kind IN ('linked','overflow')),
  sequence_number integer CHECK(sequence_number BETWEEN 2 AND 999999),
  contact_number text,
  contact_name text,
  lease_token uuid,
  lease_expires_at timestamptz,
  capacity_full boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  linked_at timestamptz,
  UNIQUE(customer_id,storage_contact_id),
  UNIQUE(customer_id,xero_connection_id,xero_contact_id),
  UNIQUE(customer_id,student_id,xero_connection_id,sequence_number),
  UNIQUE(customer_id,xero_connection_id,contact_number),
  CHECK(kind='overflow' OR xero_contact_id IS NOT NULL),
  CHECK(kind='linked' OR (sequence_number IS NOT NULL AND contact_number IS NOT NULL AND contact_name IS NOT NULL)),
  FOREIGN KEY(student_id,customer_id) REFERENCES __SOPHIA_RUNTIME_SCHEMA__.student_operations_students(student_id,customer_id),
  FOREIGN KEY(xero_connection_id,customer_id) REFERENCES __SOPHIA_RUNTIME_SCHEMA__.xero_connections(xero_connection_id,customer_id)
);
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.student_operations_document_contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.student_operations_document_contacts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON __SOPHIA_RUNTIME_SCHEMA__.student_operations_document_contacts
  USING(customer_id=NULLIF(current_setting('sophia.tenant_id',true),'')::uuid)
  WITH CHECK(customer_id=NULLIF(current_setting('sophia.tenant_id',true),'')::uuid);
GRANT SELECT,INSERT,UPDATE ON __SOPHIA_RUNTIME_SCHEMA__.student_operations_document_contacts TO sophia_runtime_app;
REVOKE DELETE ON __SOPHIA_RUNTIME_SCHEMA__.student_operations_document_contacts FROM sophia_runtime_app;
REVOKE ALL ON __SOPHIA_RUNTIME_SCHEMA__.student_operations_document_contacts FROM PUBLIC;

ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.student_operations_document_uploads
  ADD COLUMN storage_contact_id uuid,
  ADD COLUMN destination_state text NOT NULL DEFAULT 'unallocated' CHECK(destination_state IN ('unallocated','reserved','attempted')),
  ADD CONSTRAINT student_upload_storage_contact_fk FOREIGN KEY(customer_id,storage_contact_id)
    REFERENCES __SOPHIA_RUNTIME_SCHEMA__.student_operations_document_contacts(customer_id,storage_contact_id);
-- An old request may already have reached Xero. It must never be rerouted.
UPDATE __SOPHIA_RUNTIME_SCHEMA__.student_operations_document_uploads
  SET destination_state='attempted' WHERE status<>'ready';
CREATE INDEX student_upload_capacity_reservations ON __SOPHIA_RUNTIME_SCHEMA__.student_operations_document_uploads
  (customer_id,xero_connection_id,source_id) WHERE destination_state IN ('reserved','attempted');
REVOKE DELETE ON __SOPHIA_RUNTIME_SCHEMA__.student_operations_document_uploads FROM sophia_runtime_app;
