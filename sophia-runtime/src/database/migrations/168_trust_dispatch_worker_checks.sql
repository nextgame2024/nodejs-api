CREATE TABLE __SOPHIA_RUNTIME_SCHEMA__.student_trust_dispatch_attempts (
  customer_id uuid NOT NULL, connection_id uuid NOT NULL, dispatch_id uuid NOT NULL,
  attempt integer NOT NULL CHECK (attempt > 0), claimed_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  lease_until timestamptz NOT NULL DEFAULT statement_timestamp()+interval '2 minutes',
  PRIMARY KEY (customer_id,connection_id,dispatch_id,attempt),
  FOREIGN KEY (customer_id,connection_id,dispatch_id)
    REFERENCES __SOPHIA_RUNTIME_SCHEMA__.student_trust_payment_dispatches(customer_id,connection_id,dispatch_id)
);
CREATE TABLE __SOPHIA_RUNTIME_SCHEMA__.student_trust_dispatch_results (
  customer_id uuid NOT NULL, connection_id uuid NOT NULL, dispatch_id uuid NOT NULL, attempt integer NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('matched','review','unavailable')),
  detail text, checked_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  PRIMARY KEY (customer_id,connection_id,dispatch_id,attempt),
  FOREIGN KEY (customer_id,connection_id,dispatch_id,attempt)
    REFERENCES __SOPHIA_RUNTIME_SCHEMA__.student_trust_dispatch_attempts
);

ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.student_trust_dispatch_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.student_trust_dispatch_attempts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON __SOPHIA_RUNTIME_SCHEMA__.student_trust_dispatch_attempts
 USING(customer_id=nullif(current_setting('sophia.tenant_id',true),'')::uuid)
 WITH CHECK(customer_id=nullif(current_setting('sophia.tenant_id',true),'')::uuid);
REVOKE ALL ON __SOPHIA_RUNTIME_SCHEMA__.student_trust_dispatch_attempts FROM sophia_runtime_app;
GRANT SELECT,INSERT ON __SOPHIA_RUNTIME_SCHEMA__.student_trust_dispatch_attempts TO sophia_runtime_app;

ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.student_trust_dispatch_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.student_trust_dispatch_results FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON __SOPHIA_RUNTIME_SCHEMA__.student_trust_dispatch_results
 USING(customer_id=nullif(current_setting('sophia.tenant_id',true),'')::uuid)
 WITH CHECK(customer_id=nullif(current_setting('sophia.tenant_id',true),'')::uuid);
REVOKE ALL ON __SOPHIA_RUNTIME_SCHEMA__.student_trust_dispatch_results FROM sophia_runtime_app;
GRANT SELECT,INSERT ON __SOPHIA_RUNTIME_SCHEMA__.student_trust_dispatch_results TO sophia_runtime_app;
