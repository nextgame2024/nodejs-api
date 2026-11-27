CREATE TABLE __SOPHIA_RUNTIME_SCHEMA__.student_trust_split_line_allocations (
  customer_id uuid NOT NULL,
  connection_id uuid NOT NULL,
  deposit_id uuid NOT NULL,
  invoice_id uuid NOT NULL,
  line_id uuid NOT NULL,
  amount numeric(16,2) NOT NULL CHECK (amount > 0),
  PRIMARY KEY(customer_id,connection_id,invoice_id,line_id,deposit_id),
  FOREIGN KEY(customer_id,connection_id,deposit_id,invoice_id)
    REFERENCES __SOPHIA_RUNTIME_SCHEMA__.student_trust_split_allocations ON DELETE CASCADE
);
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.student_trust_split_line_allocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.student_trust_split_line_allocations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON __SOPHIA_RUNTIME_SCHEMA__.student_trust_split_line_allocations
 USING (customer_id=nullif(current_setting('sophia.tenant_id',true),'')::uuid)
 WITH CHECK (customer_id=nullif(current_setting('sophia.tenant_id',true),'')::uuid);
REVOKE ALL ON __SOPHIA_RUNTIME_SCHEMA__.student_trust_split_line_allocations FROM sophia_runtime_app;
GRANT SELECT,INSERT ON __SOPHIA_RUNTIME_SCHEMA__.student_trust_split_line_allocations TO sophia_runtime_app;
