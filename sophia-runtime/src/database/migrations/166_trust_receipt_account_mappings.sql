CREATE TABLE __SOPHIA_RUNTIME_SCHEMA__.student_trust_receipt_account_mappings (
  customer_id uuid NOT NULL, xero_connection_id uuid NOT NULL,
  revision integer NOT NULL CHECK(revision>0), request_id uuid NOT NULL,
  catalogue_revision integer NOT NULL, organisation_id text NOT NULL,
  receipt_label text, account_id uuid, account_name text,
  actor text NOT NULL, reason text NOT NULL CHECK(length(trim(reason)) BETWEEN 1 AND 500),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(customer_id,xero_connection_id,revision),
  UNIQUE(customer_id,xero_connection_id,request_id),
  FOREIGN KEY(customer_id,xero_connection_id) REFERENCES __SOPHIA_RUNTIME_SCHEMA__.student_operations_xero_sync_configurations(customer_id,xero_connection_id),
  CHECK((account_id IS NULL)=(receipt_label IS NULL) AND (account_id IS NULL)=(account_name IS NULL))
);
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.student_trust_receipt_account_mappings ENABLE ROW LEVEL SECURITY;
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.student_trust_receipt_account_mappings FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON __SOPHIA_RUNTIME_SCHEMA__.student_trust_receipt_account_mappings
 USING(customer_id=nullif(current_setting('sophia.tenant_id',true),'')::uuid)
 WITH CHECK(customer_id=nullif(current_setting('sophia.tenant_id',true),'')::uuid);
REVOKE ALL ON __SOPHIA_RUNTIME_SCHEMA__.student_trust_receipt_account_mappings FROM sophia_runtime_app;
GRANT SELECT,INSERT ON __SOPHIA_RUNTIME_SCHEMA__.student_trust_receipt_account_mappings TO sophia_runtime_app;
