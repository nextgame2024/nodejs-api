CREATE TABLE __SOPHIA_RUNTIME_SCHEMA__.student_trust_bank_check_claims (
  customer_id uuid NOT NULL, connection_id uuid NOT NULL, dispatch_id uuid NOT NULL,
  attempt integer NOT NULL CHECK(attempt>0), started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(customer_id,connection_id,dispatch_id,attempt),
  FOREIGN KEY(customer_id,connection_id,dispatch_id) REFERENCES __SOPHIA_RUNTIME_SCHEMA__.student_trust_submission_confirmations
);
CREATE TABLE __SOPHIA_RUNTIME_SCHEMA__.student_trust_bank_check_results (
  customer_id uuid NOT NULL, connection_id uuid NOT NULL, dispatch_id uuid NOT NULL, attempt integer NOT NULL,
  checked_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  outcome text NOT NULL CHECK(outcome IN ('pending','reconciled','unknown','deleted','changed','missing','unavailable')),
  PRIMARY KEY(customer_id,connection_id,dispatch_id,attempt),
  FOREIGN KEY(customer_id,connection_id,dispatch_id,attempt) REFERENCES __SOPHIA_RUNTIME_SCHEMA__.student_trust_bank_check_claims
);

ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.student_trust_bank_check_claims ENABLE ROW LEVEL SECURITY;
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.student_trust_bank_check_claims FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON __SOPHIA_RUNTIME_SCHEMA__.student_trust_bank_check_claims
 USING(customer_id=nullif(current_setting('sophia.tenant_id',true),'')::uuid)
 WITH CHECK(customer_id=nullif(current_setting('sophia.tenant_id',true),'')::uuid);
REVOKE ALL ON __SOPHIA_RUNTIME_SCHEMA__.student_trust_bank_check_claims FROM sophia_runtime_app;
GRANT SELECT,INSERT ON __SOPHIA_RUNTIME_SCHEMA__.student_trust_bank_check_claims TO sophia_runtime_app;

ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.student_trust_bank_check_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.student_trust_bank_check_results FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON __SOPHIA_RUNTIME_SCHEMA__.student_trust_bank_check_results
 USING(customer_id=nullif(current_setting('sophia.tenant_id',true),'')::uuid)
 WITH CHECK(customer_id=nullif(current_setting('sophia.tenant_id',true),'')::uuid);
REVOKE ALL ON __SOPHIA_RUNTIME_SCHEMA__.student_trust_bank_check_results FROM sophia_runtime_app;
GRANT SELECT,INSERT ON __SOPHIA_RUNTIME_SCHEMA__.student_trust_bank_check_results TO sophia_runtime_app;
