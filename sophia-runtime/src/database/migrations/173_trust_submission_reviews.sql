CREATE TABLE __SOPHIA_RUNTIME_SCHEMA__.student_trust_submission_reviews (
  customer_id uuid NOT NULL, connection_id uuid NOT NULL, dispatch_id uuid NOT NULL,
  revision integer NOT NULL CHECK (revision > 0), request_id uuid NOT NULL,
  action text NOT NULL CHECK (action IN ('investigate','close')),
  evidence text NOT NULL CHECK (length(btrim(evidence)) BETWEEN 1 AND 1000),
  actor text NOT NULL, recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (customer_id,connection_id,dispatch_id,revision),
  UNIQUE (customer_id,connection_id,dispatch_id,request_id),
  FOREIGN KEY (customer_id,connection_id,dispatch_id) REFERENCES __SOPHIA_RUNTIME_SCHEMA__.student_trust_payment_submissions
);
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.student_trust_submission_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.student_trust_submission_reviews FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON __SOPHIA_RUNTIME_SCHEMA__.student_trust_submission_reviews
 USING(customer_id=nullif(current_setting('sophia.tenant_id',true),'')::uuid)
 WITH CHECK(customer_id=nullif(current_setting('sophia.tenant_id',true),'')::uuid);
REVOKE ALL ON __SOPHIA_RUNTIME_SCHEMA__.student_trust_submission_reviews FROM sophia_runtime_app;
GRANT SELECT,INSERT ON __SOPHIA_RUNTIME_SCHEMA__.student_trust_submission_reviews TO sophia_runtime_app;
