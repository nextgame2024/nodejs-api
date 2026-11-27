CREATE TABLE __SOPHIA_RUNTIME_SCHEMA__.student_trust_receipt_proposals (
  customer_id uuid NOT NULL, connection_id uuid NOT NULL, verification_id uuid NOT NULL,
  revision integer NOT NULL CHECK (revision>0), request_id uuid NOT NULL,
  action text NOT NULL CHECK (action IN ('prepare','approve','withdraw')),
  evidence_token text NOT NULL, snapshot jsonb NOT NULL, actor text NOT NULL,
  reason text NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 500),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(), expires_at timestamptz NOT NULL,
  PRIMARY KEY(customer_id,connection_id,verification_id,revision),
  UNIQUE(customer_id,connection_id,verification_id,request_id),
  FOREIGN KEY(customer_id,connection_id,verification_id)
    REFERENCES __SOPHIA_RUNTIME_SCHEMA__.student_trust_receipt_verifications(customer_id,connection_id,verification_id)
);
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.student_trust_receipt_proposals ENABLE ROW LEVEL SECURITY;
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.student_trust_receipt_proposals FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON __SOPHIA_RUNTIME_SCHEMA__.student_trust_receipt_proposals
 USING (customer_id=nullif(current_setting('sophia.tenant_id',true),'')::uuid)
 WITH CHECK (customer_id=nullif(current_setting('sophia.tenant_id',true),'')::uuid);
REVOKE ALL ON __SOPHIA_RUNTIME_SCHEMA__.student_trust_receipt_proposals FROM sophia_runtime_app;
GRANT SELECT,INSERT ON __SOPHIA_RUNTIME_SCHEMA__.student_trust_receipt_proposals TO sophia_runtime_app;
