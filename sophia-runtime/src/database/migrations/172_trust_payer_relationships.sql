CREATE TABLE __SOPHIA_RUNTIME_SCHEMA__.student_trust_payer_relationships (
  customer_id uuid NOT NULL, connection_id uuid NOT NULL, contact_id uuid NOT NULL,
  name_key text NOT NULL CHECK (length(name_key)>=3), revision integer NOT NULL CHECK (revision>0),
  payer_name text NOT NULL CHECK (length(btrim(payer_name)) BETWEEN 3 AND 100), relationship text NOT NULL CHECK (relationship IN ('payer','sponsor')),
  active boolean NOT NULL, reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 500), actor text NOT NULL,
  reviewed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(customer_id,connection_id,contact_id,name_key,revision),
  FOREIGN KEY(customer_id,connection_id,contact_id) REFERENCES __SOPHIA_RUNTIME_SCHEMA__.student_operations_xero_contacts(customer_id,xero_connection_id,xero_contact_id)
);
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.student_trust_payer_relationships ENABLE ROW LEVEL SECURITY;
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.student_trust_payer_relationships FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON __SOPHIA_RUNTIME_SCHEMA__.student_trust_payer_relationships
 USING(customer_id=nullif(current_setting('sophia.tenant_id',true),'')::uuid)
 WITH CHECK(customer_id=nullif(current_setting('sophia.tenant_id',true),'')::uuid);
REVOKE ALL ON __SOPHIA_RUNTIME_SCHEMA__.student_trust_payer_relationships FROM sophia_runtime_app;
GRANT SELECT,INSERT ON __SOPHIA_RUNTIME_SCHEMA__.student_trust_payer_relationships TO sophia_runtime_app;
