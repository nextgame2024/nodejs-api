CREATE TABLE __SOPHIA_RUNTIME_SCHEMA__.student_trust_payment_reconciliation_checks (
  customer_id uuid NOT NULL,
  connection_id uuid NOT NULL,
  payment_id uuid NOT NULL,
  checked_by text NOT NULL,
  checked_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (customer_id, connection_id, payment_id),
  FOREIGN KEY (customer_id, connection_id, payment_id)
    REFERENCES __SOPHIA_RUNTIME_SCHEMA__.student_trust_receipt_payment_links(customer_id, connection_id, payment_id)
);
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.student_trust_payment_reconciliation_checks ENABLE ROW LEVEL SECURITY;
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.student_trust_payment_reconciliation_checks FORCE ROW LEVEL SECURITY;
CREATE POLICY customer_scope ON __SOPHIA_RUNTIME_SCHEMA__.student_trust_payment_reconciliation_checks
  USING (customer_id=nullif(current_setting('sophia.tenant_id',true),'')::uuid)
  WITH CHECK (customer_id=nullif(current_setting('sophia.tenant_id',true),'')::uuid);
GRANT SELECT,INSERT ON __SOPHIA_RUNTIME_SCHEMA__.student_trust_payment_reconciliation_checks TO sophia_runtime_app;
