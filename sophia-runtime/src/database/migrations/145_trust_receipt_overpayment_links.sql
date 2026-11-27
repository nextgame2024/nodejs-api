CREATE TABLE __SOPHIA_RUNTIME_SCHEMA__.student_trust_receipt_overpayment_links (
  customer_id uuid NOT NULL,
  connection_id uuid NOT NULL,
  verification_id uuid NOT NULL,
  overpayment_id uuid NOT NULL,
  excess_amount numeric(16,2) NOT NULL CHECK (excess_amount > 0),
  linked_by text NOT NULL,
  linked_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (customer_id, verification_id),
  UNIQUE (customer_id, connection_id, overpayment_id),
  FOREIGN KEY (customer_id, connection_id, verification_id)
    REFERENCES __SOPHIA_RUNTIME_SCHEMA__.student_trust_receipt_verifications(customer_id, connection_id, verification_id)
);
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.student_trust_receipt_overpayment_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.student_trust_receipt_overpayment_links FORCE ROW LEVEL SECURITY;
CREATE POLICY customer_scope ON __SOPHIA_RUNTIME_SCHEMA__.student_trust_receipt_overpayment_links
  USING (customer_id=nullif(current_setting('sophia.tenant_id',true),'')::uuid)
  WITH CHECK (customer_id=nullif(current_setting('sophia.tenant_id',true),'')::uuid);
GRANT SELECT,INSERT ON __SOPHIA_RUNTIME_SCHEMA__.student_trust_receipt_overpayment_links TO sophia_runtime_app;
