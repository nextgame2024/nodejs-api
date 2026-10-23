-- No provider calls or historical Contact/invoice changes. Bind on first upload.
-- Narrow tenant-filtered projection, like the advisor roster: never grant the
-- Runtime role direct access to the Business Manager identity/link tables.
CREATE VIEW __SOPHIA_RUNTIME_SCHEMA__.student_operations_student_contact_links
  WITH (security_barrier=true) AS
SELECT l.customer_id,s.student_id,l.connection_id AS xero_connection_id,l.contact_id AS xero_contact_id
  FROM public.bm_xero_student_contact_links l
  JOIN __SOPHIA_RUNTIME_SCHEMA__.student_operations_student_user_links s
    ON s.customer_id=l.customer_id AND s.student_reference=l.student_id
  JOIN __SOPHIA_RUNTIME_SCHEMA__.customers c ON c.customer_id=l.customer_id
  WHERE c.status='active' AND c.customer_id=NULLIF(current_setting('sophia.tenant_id',true),'')::uuid;
GRANT SELECT ON __SOPHIA_RUNTIME_SCHEMA__.student_operations_student_contact_links TO sophia_runtime_app;

CREATE TABLE __SOPHIA_RUNTIME_SCHEMA__.student_operations_primary_xero_contacts (
  customer_id uuid NOT NULL,
  student_id uuid NOT NULL,
  xero_connection_id uuid NOT NULL,
  xero_contact_id uuid,
  contact_number text NOT NULL,
  contact_name text NOT NULL,
  contact_email text,
  selection_method text NOT NULL CHECK(selection_method IN ('latest_invoice','linked_contact','external_reference','created')),
  lease_token uuid,
  lease_expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  linked_at timestamptz,
  PRIMARY KEY(customer_id,student_id,xero_connection_id),
  UNIQUE(customer_id,xero_connection_id,contact_number),
  UNIQUE(customer_id,xero_connection_id,xero_contact_id),
  CHECK((xero_contact_id IS NULL) = (linked_at IS NULL)),
  FOREIGN KEY(student_id,customer_id) REFERENCES __SOPHIA_RUNTIME_SCHEMA__.student_operations_students(student_id,customer_id),
  FOREIGN KEY(xero_connection_id,customer_id) REFERENCES __SOPHIA_RUNTIME_SCHEMA__.xero_connections(xero_connection_id,customer_id)
);
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.student_operations_primary_xero_contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.student_operations_primary_xero_contacts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON __SOPHIA_RUNTIME_SCHEMA__.student_operations_primary_xero_contacts
  USING(customer_id=NULLIF(current_setting('sophia.tenant_id',true),'')::uuid)
  WITH CHECK(customer_id=NULLIF(current_setting('sophia.tenant_id',true),'')::uuid);
GRANT SELECT,INSERT,UPDATE ON __SOPHIA_RUNTIME_SCHEMA__.student_operations_primary_xero_contacts TO sophia_runtime_app;
