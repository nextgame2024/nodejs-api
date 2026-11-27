CREATE TABLE __SOPHIA_RUNTIME_SCHEMA__.student_trust_residual_reviews (
  customer_id uuid NOT NULL, connection_id uuid NOT NULL, deposit_id uuid NOT NULL,
  reservation_revision integer NOT NULL, revision integer NOT NULL CHECK (revision>0),
  request_id uuid NOT NULL, student_id uuid, student_name text, student_reference text,
  amount numeric(16,2) NOT NULL CHECK (amount>0),
  reason text NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 500),
  reviewer text NOT NULL, recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(customer_id,connection_id,deposit_id,reservation_revision,revision),
  UNIQUE(customer_id,connection_id,deposit_id,request_id),
  CHECK ((student_id IS NULL)=(student_name IS NULL)),
  FOREIGN KEY(customer_id,connection_id,deposit_id,reservation_revision)
    REFERENCES __SOPHIA_RUNTIME_SCHEMA__.student_trust_split_events
);
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.student_trust_residual_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.student_trust_residual_reviews FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON __SOPHIA_RUNTIME_SCHEMA__.student_trust_residual_reviews
 USING (customer_id=nullif(current_setting('sophia.tenant_id',true),'')::uuid)
 WITH CHECK (customer_id=nullif(current_setting('sophia.tenant_id',true),'')::uuid);
REVOKE ALL ON __SOPHIA_RUNTIME_SCHEMA__.student_trust_residual_reviews FROM sophia_runtime_app;
GRANT SELECT,INSERT ON __SOPHIA_RUNTIME_SCHEMA__.student_trust_residual_reviews TO sophia_runtime_app;
