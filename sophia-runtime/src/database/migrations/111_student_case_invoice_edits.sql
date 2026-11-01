CREATE TABLE __SOPHIA_RUNTIME_SCHEMA__.student_case_invoice_edits (
  customer_id uuid NOT NULL,
  case_id uuid NOT NULL,
  xero_connection_id uuid NOT NULL,
  xero_invoice_id uuid NOT NULL,
  actor_identity_user_id text NOT NULL,
  idempotency_key text NOT NULL,
  request_hash text NOT NULL,
  expected_fingerprint text NOT NULL,
  desired jsonb NOT NULL,
  completed boolean NOT NULL DEFAULT false,
  failed boolean NOT NULL DEFAULT false,
  lease_token uuid,
  lease_expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(customer_id,xero_connection_id,xero_invoice_id),
  FOREIGN KEY(customer_id,case_id) REFERENCES __SOPHIA_RUNTIME_SCHEMA__.student_operations_cases(customer_id,case_id),
  CHECK((lease_token IS NULL)=(lease_expires_at IS NULL))
);
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.student_case_invoice_edits ENABLE ROW LEVEL SECURITY;
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.student_case_invoice_edits FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON __SOPHIA_RUNTIME_SCHEMA__.student_case_invoice_edits
  USING(customer_id=NULLIF(current_setting('sophia.tenant_id',true),'')::uuid)
  WITH CHECK(customer_id=NULLIF(current_setting('sophia.tenant_id',true),'')::uuid);
REVOKE ALL ON __SOPHIA_RUNTIME_SCHEMA__.student_case_invoice_edits FROM PUBLIC,sophia_runtime_app;
GRANT SELECT,INSERT,UPDATE ON __SOPHIA_RUNTIME_SCHEMA__.student_case_invoice_edits TO sophia_runtime_app;
