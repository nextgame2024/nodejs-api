CREATE TABLE __SOPHIA_RUNTIME_SCHEMA__.student_trust_staged_deposits (
  customer_id uuid NOT NULL,
  connection_id uuid NOT NULL,
  deposit_id uuid NOT NULL DEFAULT gen_random_uuid(),
  staged_at timestamptz NOT NULL DEFAULT now(),
  staged_by text NOT NULL,
  account_label text NOT NULL CHECK (length(account_label) BETWEEN 1 AND 120),
  bank_transaction_id text NOT NULL CHECK (length(bank_transaction_id) BETWEEN 1 AND 150),
  received_on date NOT NULL,
  amount numeric(16,2) NOT NULL CHECK (amount > 0),
  reference text NOT NULL CHECK (length(reference) <= 150),
  statement_file_name text NOT NULL CHECK (length(statement_file_name) BETWEEN 1 AND 255),
  statement_file_sha256 text NOT NULL CHECK (statement_file_sha256 ~ '^[0-9a-f]{64}$'),
  statement_record integer NOT NULL CHECK (statement_record BETWEEN 2 AND 1001),
  PRIMARY KEY (customer_id, connection_id, deposit_id),
  FOREIGN KEY (customer_id, connection_id) REFERENCES
    __SOPHIA_RUNTIME_SCHEMA__.student_operations_xero_sync_configurations(customer_id,xero_connection_id),
  UNIQUE (customer_id,connection_id,statement_file_sha256,statement_record)
);
CREATE UNIQUE INDEX student_trust_staged_bank_identity ON __SOPHIA_RUNTIME_SCHEMA__.student_trust_staged_deposits
  (customer_id,connection_id,lower(account_label),bank_transaction_id);
CREATE INDEX student_trust_staged_date ON __SOPHIA_RUNTIME_SCHEMA__.student_trust_staged_deposits
  (customer_id,connection_id,received_on DESC,deposit_id);
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.student_trust_staged_deposits ENABLE ROW LEVEL SECURITY;
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.student_trust_staged_deposits FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON __SOPHIA_RUNTIME_SCHEMA__.student_trust_staged_deposits
  USING (customer_id=nullif(current_setting('sophia.tenant_id',true),'')::uuid)
  WITH CHECK (customer_id=nullif(current_setting('sophia.tenant_id',true),'')::uuid);
GRANT SELECT, INSERT ON __SOPHIA_RUNTIME_SCHEMA__.student_trust_staged_deposits TO sophia_runtime_app;
