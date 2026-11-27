CREATE TABLE __SOPHIA_RUNTIME_SCHEMA__.student_trust_reconciliation_claims (
  customer_id uuid NOT NULL,
  connection_id uuid NOT NULL,
  payment_id uuid NOT NULL,
  claim_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  claimed_by text NOT NULL,
  claimed_at timestamptz NOT NULL DEFAULT now(),
  released_at timestamptz,
  FOREIGN KEY (customer_id, connection_id, payment_id)
    REFERENCES __SOPHIA_RUNTIME_SCHEMA__.student_trust_receipt_payment_links(customer_id, connection_id, payment_id)
);
CREATE UNIQUE INDEX student_trust_one_active_reconciliation_claim
  ON __SOPHIA_RUNTIME_SCHEMA__.student_trust_reconciliation_claims(customer_id,connection_id,payment_id)
  WHERE released_at IS NULL;
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.student_trust_reconciliation_claims ENABLE ROW LEVEL SECURITY;
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.student_trust_reconciliation_claims FORCE ROW LEVEL SECURITY;
CREATE POLICY customer_scope ON __SOPHIA_RUNTIME_SCHEMA__.student_trust_reconciliation_claims
  USING (customer_id=nullif(current_setting('sophia.tenant_id',true),'')::uuid)
  WITH CHECK (customer_id=nullif(current_setting('sophia.tenant_id',true),'')::uuid);
REVOKE UPDATE,DELETE,TRUNCATE ON __SOPHIA_RUNTIME_SCHEMA__.student_trust_reconciliation_claims FROM sophia_runtime_app;
GRANT UPDATE(released_at) ON __SOPHIA_RUNTIME_SCHEMA__.student_trust_reconciliation_claims TO sophia_runtime_app;
GRANT SELECT,INSERT ON __SOPHIA_RUNTIME_SCHEMA__.student_trust_reconciliation_claims TO sophia_runtime_app;
