CREATE TABLE __SOPHIA_RUNTIME_SCHEMA__.student_xero_webhook_resources (
  customer_id uuid NOT NULL, xero_connection_id uuid NOT NULL,
  category text NOT NULL CHECK(category IN ('INVOICE','CONTACT')),
  resource_id uuid NOT NULL, event_at timestamptz NOT NULL, refreshed_at timestamptz,
  PRIMARY KEY(customer_id,xero_connection_id,category,resource_id),
  FOREIGN KEY(customer_id,xero_connection_id) REFERENCES __SOPHIA_RUNTIME_SCHEMA__.student_operations_xero_sync_configurations(customer_id,xero_connection_id)
);
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.student_xero_webhook_resources ENABLE ROW LEVEL SECURITY;
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.student_xero_webhook_resources FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON __SOPHIA_RUNTIME_SCHEMA__.student_xero_webhook_resources
  USING(customer_id=nullif(current_setting('sophia.tenant_id',true),'')::uuid)
  WITH CHECK(customer_id=nullif(current_setting('sophia.tenant_id',true),'')::uuid);
REVOKE ALL ON __SOPHIA_RUNTIME_SCHEMA__.student_xero_webhook_resources FROM sophia_runtime_app;
GRANT SELECT,INSERT,UPDATE ON __SOPHIA_RUNTIME_SCHEMA__.student_xero_webhook_resources TO sophia_runtime_app;
CREATE TABLE __SOPHIA_RUNTIME_SCHEMA__.student_xero_import_resources (
  customer_id uuid NOT NULL, xero_connection_id uuid NOT NULL,
  kind text NOT NULL CHECK(kind IN ('Payments','BatchPayments','BankAccounts','BankTransactions')),
  resource_id uuid NOT NULL, detail jsonb, checked_at timestamptz,
  due_at timestamptz NOT NULL DEFAULT now(), lease_id uuid,
  page integer NOT NULL DEFAULT 1 CHECK(page>0), since_at timestamptz, sweep_started_at timestamptz,
  PRIMARY KEY(customer_id,xero_connection_id,kind,resource_id),
  FOREIGN KEY(customer_id,xero_connection_id) REFERENCES __SOPHIA_RUNTIME_SCHEMA__.student_operations_xero_sync_configurations(customer_id,xero_connection_id)
);
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.student_xero_import_resources ENABLE ROW LEVEL SECURITY;
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.student_xero_import_resources FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON __SOPHIA_RUNTIME_SCHEMA__.student_xero_import_resources
  USING(customer_id=nullif(current_setting('sophia.tenant_id',true),'')::uuid)
  WITH CHECK(customer_id=nullif(current_setting('sophia.tenant_id',true),'')::uuid);
REVOKE ALL ON __SOPHIA_RUNTIME_SCHEMA__.student_xero_import_resources FROM sophia_runtime_app;
GRANT SELECT,INSERT,UPDATE ON __SOPHIA_RUNTIME_SCHEMA__.student_xero_import_resources TO sophia_runtime_app;
CREATE INDEX student_xero_import_due ON __SOPHIA_RUNTIME_SCHEMA__.student_xero_import_resources(customer_id,due_at) WHERE kind<>'BankTransactions';

-- The tenant worker discovers historical payment IDs under the runtime role and RLS.
CREATE INDEX student_xero_import_payment_source ON __SOPHIA_RUNTIME_SCHEMA__.student_xero_payment_observations(customer_id,xero_connection_id,payment_id);
