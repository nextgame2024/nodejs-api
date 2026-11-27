CREATE TABLE __SOPHIA_RUNTIME_SCHEMA__.student_trust_invoice_match_decisions (
  customer_id uuid NOT NULL,
  connection_id uuid NOT NULL,
  deposit_id uuid NOT NULL,
  invoice_id uuid NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  request_id uuid NOT NULL,
  request_hash text NOT NULL,
  decision text NOT NULL CHECK (decision IN ('accepted','dismissed')),
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 500),
  reviewed_by text NOT NULL,
  reviewed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  rule_version integer NOT NULL,
  evidence_token text NOT NULL,
  evidence jsonb NOT NULL,
  PRIMARY KEY (customer_id,connection_id,deposit_id,revision),
  UNIQUE (customer_id,connection_id,deposit_id,request_id),
  FOREIGN KEY (customer_id,connection_id,deposit_id) REFERENCES __SOPHIA_RUNTIME_SCHEMA__.student_trust_staged_deposits,
  FOREIGN KEY (customer_id,connection_id,invoice_id) REFERENCES __SOPHIA_RUNTIME_SCHEMA__.student_operations_xero_invoices(customer_id,xero_connection_id,xero_invoice_id)
);
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.student_trust_invoice_match_decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.student_trust_invoice_match_decisions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON __SOPHIA_RUNTIME_SCHEMA__.student_trust_invoice_match_decisions
 USING (customer_id=nullif(current_setting('sophia.tenant_id',true),'')::uuid)
 WITH CHECK (customer_id=nullif(current_setting('sophia.tenant_id',true),'')::uuid);
REVOKE UPDATE,DELETE,TRUNCATE ON __SOPHIA_RUNTIME_SCHEMA__.student_trust_invoice_match_decisions FROM sophia_runtime_app;
GRANT SELECT,INSERT ON __SOPHIA_RUNTIME_SCHEMA__.student_trust_invoice_match_decisions TO sophia_runtime_app;
