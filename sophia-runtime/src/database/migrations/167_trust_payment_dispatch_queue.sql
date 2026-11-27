CREATE TABLE __SOPHIA_RUNTIME_SCHEMA__.student_trust_payment_dispatches (
  customer_id uuid NOT NULL, connection_id uuid NOT NULL, verification_id uuid NOT NULL,
  approval_revision integer NOT NULL, dispatch_id uuid NOT NULL DEFAULT gen_random_uuid(),
  request_id uuid NOT NULL, evidence_token text NOT NULL, snapshot jsonb NOT NULL,
  approver text NOT NULL, released_by text NOT NULL CHECK(released_by<>approver),
  reason text NOT NULL CHECK(length(trim(reason)) BETWEEN 1 AND 500),
  queued_at timestamptz NOT NULL DEFAULT clock_timestamp(), expires_at timestamptz NOT NULL,
  PRIMARY KEY(customer_id,connection_id,verification_id,approval_revision),
  UNIQUE(customer_id,connection_id,verification_id,request_id),
  UNIQUE(customer_id,connection_id,dispatch_id),
  FOREIGN KEY(customer_id,connection_id,verification_id,approval_revision)
    REFERENCES __SOPHIA_RUNTIME_SCHEMA__.student_trust_receipt_proposals
);
CREATE INDEX student_trust_dispatch_queue_date ON __SOPHIA_RUNTIME_SCHEMA__.student_trust_payment_dispatches
  (customer_id,connection_id,queued_at DESC,dispatch_id);
CREATE TABLE __SOPHIA_RUNTIME_SCHEMA__.student_trust_dispatch_cancellations (
  customer_id uuid NOT NULL,connection_id uuid NOT NULL,dispatch_id uuid NOT NULL,
  actor text NOT NULL,reason text NOT NULL CHECK(length(trim(reason)) BETWEEN 1 AND 500),
  cancelled_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(customer_id,connection_id,dispatch_id),
  FOREIGN KEY(customer_id,connection_id,dispatch_id)
    REFERENCES __SOPHIA_RUNTIME_SCHEMA__.student_trust_payment_dispatches(customer_id,connection_id,dispatch_id)
);
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.student_trust_payment_dispatches ENABLE ROW LEVEL SECURITY;
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.student_trust_payment_dispatches FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON __SOPHIA_RUNTIME_SCHEMA__.student_trust_payment_dispatches
 USING(customer_id=nullif(current_setting('sophia.tenant_id',true),'')::uuid)
 WITH CHECK(customer_id=nullif(current_setting('sophia.tenant_id',true),'')::uuid);
REVOKE ALL ON __SOPHIA_RUNTIME_SCHEMA__.student_trust_payment_dispatches FROM sophia_runtime_app;
GRANT SELECT,INSERT ON __SOPHIA_RUNTIME_SCHEMA__.student_trust_payment_dispatches TO sophia_runtime_app;
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.student_trust_dispatch_cancellations ENABLE ROW LEVEL SECURITY;
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.student_trust_dispatch_cancellations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON __SOPHIA_RUNTIME_SCHEMA__.student_trust_dispatch_cancellations
 USING(customer_id=nullif(current_setting('sophia.tenant_id',true),'')::uuid)
 WITH CHECK(customer_id=nullif(current_setting('sophia.tenant_id',true),'')::uuid);
REVOKE ALL ON __SOPHIA_RUNTIME_SCHEMA__.student_trust_dispatch_cancellations FROM sophia_runtime_app;
GRANT SELECT,INSERT ON __SOPHIA_RUNTIME_SCHEMA__.student_trust_dispatch_cancellations TO sophia_runtime_app;
