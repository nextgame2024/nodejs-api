CREATE TABLE __SOPHIA_RUNTIME_SCHEMA__.student_trust_split_events (
  customer_id uuid NOT NULL, connection_id uuid NOT NULL, deposit_id uuid NOT NULL,
  revision integer NOT NULL CHECK (revision > 0), request_id uuid NOT NULL, request_hash text NOT NULL,
  action text NOT NULL CHECK (action IN ('reserve','release')),
  reason text NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 500),
  actor text NOT NULL, recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(), plan jsonb,
  CHECK ((action='reserve')=(plan IS NOT NULL)),
  PRIMARY KEY (customer_id,connection_id,deposit_id,revision),
  UNIQUE (customer_id,connection_id,deposit_id,request_id),
  FOREIGN KEY (customer_id,connection_id,deposit_id) REFERENCES __SOPHIA_RUNTIME_SCHEMA__.student_trust_staged_deposits
);
CREATE TABLE __SOPHIA_RUNTIME_SCHEMA__.student_trust_split_allocations (
  customer_id uuid NOT NULL, connection_id uuid NOT NULL, deposit_id uuid NOT NULL, revision integer NOT NULL,
  invoice_id uuid NOT NULL, amount numeric(16,2) NOT NULL CHECK (amount>0),
  PRIMARY KEY(customer_id,connection_id,deposit_id,invoice_id),
  FOREIGN KEY(customer_id,connection_id,deposit_id,revision) REFERENCES __SOPHIA_RUNTIME_SCHEMA__.student_trust_split_events,
  FOREIGN KEY(customer_id,connection_id,invoice_id) REFERENCES __SOPHIA_RUNTIME_SCHEMA__.student_operations_xero_invoices(customer_id,xero_connection_id,xero_invoice_id)
);
CREATE INDEX student_trust_split_invoice_idx ON __SOPHIA_RUNTIME_SCHEMA__.student_trust_split_allocations(customer_id,connection_id,invoice_id);
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.student_trust_split_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.student_trust_split_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON __SOPHIA_RUNTIME_SCHEMA__.student_trust_split_events
 USING (customer_id=nullif(current_setting('sophia.tenant_id',true),'')::uuid)
 WITH CHECK (customer_id=nullif(current_setting('sophia.tenant_id',true),'')::uuid);
REVOKE ALL ON __SOPHIA_RUNTIME_SCHEMA__.student_trust_split_events FROM sophia_runtime_app;
GRANT SELECT,INSERT ON __SOPHIA_RUNTIME_SCHEMA__.student_trust_split_events TO sophia_runtime_app;
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.student_trust_split_allocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.student_trust_split_allocations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON __SOPHIA_RUNTIME_SCHEMA__.student_trust_split_allocations
 USING (customer_id=nullif(current_setting('sophia.tenant_id',true),'')::uuid)
 WITH CHECK (customer_id=nullif(current_setting('sophia.tenant_id',true),'')::uuid);
REVOKE ALL ON __SOPHIA_RUNTIME_SCHEMA__.student_trust_split_allocations FROM sophia_runtime_app;
GRANT SELECT,INSERT,DELETE ON __SOPHIA_RUNTIME_SCHEMA__.student_trust_split_allocations TO sophia_runtime_app;
