CREATE TABLE __SOPHIA_RUNTIME_SCHEMA__.student_trust_payment_submissions (
  customer_id uuid NOT NULL,connection_id uuid NOT NULL,dispatch_id uuid NOT NULL,
  verification_id uuid NOT NULL,started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(customer_id,connection_id,dispatch_id), UNIQUE(customer_id,connection_id,verification_id),
  FOREIGN KEY(customer_id,connection_id,dispatch_id) REFERENCES __SOPHIA_RUNTIME_SCHEMA__.student_trust_payment_dispatches(customer_id,connection_id,dispatch_id),
  FOREIGN KEY(customer_id,connection_id,verification_id) REFERENCES __SOPHIA_RUNTIME_SCHEMA__.student_trust_receipt_verifications(customer_id,connection_id,verification_id)
);
CREATE TABLE __SOPHIA_RUNTIME_SCHEMA__.student_trust_submission_confirmations (
  customer_id uuid NOT NULL,connection_id uuid NOT NULL,dispatch_id uuid NOT NULL,payment_id uuid NOT NULL,
  verified_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(customer_id,connection_id,dispatch_id), UNIQUE(customer_id,connection_id,payment_id),
  FOREIGN KEY(customer_id,connection_id,dispatch_id) REFERENCES __SOPHIA_RUNTIME_SCHEMA__.student_trust_payment_submissions
);

ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.student_trust_payment_submissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.student_trust_payment_submissions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON __SOPHIA_RUNTIME_SCHEMA__.student_trust_payment_submissions
 USING(customer_id=nullif(current_setting('sophia.tenant_id',true),'')::uuid)
 WITH CHECK(customer_id=nullif(current_setting('sophia.tenant_id',true),'')::uuid);
REVOKE ALL ON __SOPHIA_RUNTIME_SCHEMA__.student_trust_payment_submissions FROM sophia_runtime_app;
GRANT SELECT,INSERT ON __SOPHIA_RUNTIME_SCHEMA__.student_trust_payment_submissions TO sophia_runtime_app;

ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.student_trust_submission_confirmations ENABLE ROW LEVEL SECURITY;
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.student_trust_submission_confirmations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON __SOPHIA_RUNTIME_SCHEMA__.student_trust_submission_confirmations
 USING(customer_id=nullif(current_setting('sophia.tenant_id',true),'')::uuid)
 WITH CHECK(customer_id=nullif(current_setting('sophia.tenant_id',true),'')::uuid);
REVOKE ALL ON __SOPHIA_RUNTIME_SCHEMA__.student_trust_submission_confirmations FROM sophia_runtime_app;
GRANT SELECT,INSERT ON __SOPHIA_RUNTIME_SCHEMA__.student_trust_submission_confirmations TO sophia_runtime_app;
CREATE TABLE __SOPHIA_RUNTIME_SCHEMA__.student_trust_submission_acknowledgements (
  customer_id uuid NOT NULL,connection_id uuid NOT NULL,dispatch_id uuid NOT NULL,payment_id uuid NOT NULL,
  received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(customer_id,connection_id,dispatch_id), UNIQUE(customer_id,connection_id,payment_id),
  FOREIGN KEY(customer_id,connection_id,dispatch_id) REFERENCES __SOPHIA_RUNTIME_SCHEMA__.student_trust_payment_submissions
);

ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.student_trust_submission_acknowledgements ENABLE ROW LEVEL SECURITY;
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.student_trust_submission_acknowledgements FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON __SOPHIA_RUNTIME_SCHEMA__.student_trust_submission_acknowledgements
 USING(customer_id=nullif(current_setting('sophia.tenant_id',true),'')::uuid)
 WITH CHECK(customer_id=nullif(current_setting('sophia.tenant_id',true),'')::uuid);
REVOKE ALL ON __SOPHIA_RUNTIME_SCHEMA__.student_trust_submission_acknowledgements FROM sophia_runtime_app;
GRANT SELECT,INSERT ON __SOPHIA_RUNTIME_SCHEMA__.student_trust_submission_acknowledgements TO sophia_runtime_app;
