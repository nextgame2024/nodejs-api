CREATE TABLE __SOPHIA_RUNTIME_SCHEMA__.student_trust_receipt_verifications (
  customer_id uuid NOT NULL,
  connection_id uuid NOT NULL,
  invoice_id uuid NOT NULL,
  verification_id uuid NOT NULL,
  verified_by text NOT NULL,
  verified_at timestamptz NOT NULL DEFAULT now(),
  received_on date NOT NULL,
  account_label text NOT NULL,
  reference text NOT NULL,
  amount numeric(16,2) NOT NULL CHECK (amount > 0),
  invoice_due_at_verification numeric(18,4) NOT NULL,
  evidence bytea CHECK (octet_length(evidence) BETWEEN 1 AND 5242880),
  evidence_type text CHECK (evidence_type IN ('image/png','image/jpeg')),
  payload_hash text NOT NULL,
  PRIMARY KEY (customer_id, verification_id),
  FOREIGN KEY (customer_id,connection_id,invoice_id) REFERENCES
    __SOPHIA_RUNTIME_SCHEMA__.student_operations_xero_invoices(customer_id,xero_connection_id,xero_invoice_id),
  CHECK ((evidence IS NULL) = (evidence_type IS NULL))
);
CREATE INDEX student_trust_receipts_invoice ON __SOPHIA_RUNTIME_SCHEMA__.student_trust_receipt_verifications
  (customer_id,connection_id,invoice_id,verified_at DESC);
CREATE UNIQUE INDEX student_trust_receipts_repeat ON __SOPHIA_RUNTIME_SCHEMA__.student_trust_receipt_verifications
  (customer_id,connection_id,invoice_id,received_on,amount,lower(account_label),lower(reference));
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.student_trust_receipt_verifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.student_trust_receipt_verifications FORCE ROW LEVEL SECURITY;
CREATE POLICY customer_scope ON __SOPHIA_RUNTIME_SCHEMA__.student_trust_receipt_verifications
  USING (customer_id=nullif(current_setting('sophia.tenant_id',true),'')::uuid)
  WITH CHECK (customer_id=nullif(current_setting('sophia.tenant_id',true),'')::uuid);
GRANT SELECT,INSERT ON __SOPHIA_RUNTIME_SCHEMA__.student_trust_receipt_verifications TO sophia_runtime_app;
