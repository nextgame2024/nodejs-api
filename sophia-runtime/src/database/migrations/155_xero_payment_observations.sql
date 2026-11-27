CREATE TABLE __SOPHIA_RUNTIME_SCHEMA__.student_xero_payment_observations (
  observation_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL,
  xero_connection_id uuid NOT NULL,
  xero_invoice_id uuid NOT NULL,
  payment_id uuid NOT NULL,
  amount numeric NOT NULL CHECK (amount >= 0),
  currency_code text,
  payment_date date,
  is_reconciled boolean,
  first_seen_run_id uuid NOT NULL,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (customer_id, xero_connection_id, xero_invoice_id)
    REFERENCES __SOPHIA_RUNTIME_SCHEMA__.student_operations_xero_invoices(customer_id, xero_connection_id, xero_invoice_id)
    ON DELETE CASCADE,
  UNIQUE NULLS NOT DISTINCT (customer_id, xero_connection_id, xero_invoice_id, payment_id, amount, currency_code, payment_date, is_reconciled)
);
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.student_xero_payment_observations ENABLE ROW LEVEL SECURITY;
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.student_xero_payment_observations FORCE ROW LEVEL SECURITY;
CREATE POLICY customer_scope ON __SOPHIA_RUNTIME_SCHEMA__.student_xero_payment_observations
  USING (customer_id=nullif(current_setting('sophia.tenant_id',true),'')::uuid)
  WITH CHECK (customer_id=nullif(current_setting('sophia.tenant_id',true),'')::uuid);
REVOKE ALL ON __SOPHIA_RUNTIME_SCHEMA__.student_xero_payment_observations FROM sophia_runtime_app;
GRANT SELECT, INSERT ON __SOPHIA_RUNTIME_SCHEMA__.student_xero_payment_observations TO sophia_runtime_app;
