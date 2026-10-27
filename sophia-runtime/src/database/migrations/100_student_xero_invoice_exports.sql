-- Durable, tenant-scoped execution receipts. A proposal sequence may be sent
-- to Xero at most once; uncertain provider outcomes require reconciliation and
-- are never replayed automatically after Xero's idempotency window expires.
CREATE TABLE __SOPHIA_RUNTIME_SCHEMA__.student_case_xero_invoice_exports (
  customer_id uuid NOT NULL,
  case_id uuid NOT NULL,
  batch_id uuid NOT NULL,
  sequence integer NOT NULL CHECK(sequence>0),
  xero_connection_id uuid NOT NULL,
  xero_contact_id uuid NOT NULL,
  provider_key text NOT NULL CHECK(provider_key ~ '^[a-f0-9]{64}$'),
  status text NOT NULL CHECK(status IN ('not_attempted','creating','created','review_required')),
  xero_invoice_id uuid,
  xero_invoice_number text,
  provider_status text,
  requested_by_identity_user_id text NOT NULL,
  requested_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  PRIMARY KEY(customer_id,batch_id,sequence),
  UNIQUE(customer_id,xero_connection_id,xero_invoice_id),
  UNIQUE(customer_id,provider_key),
  FOREIGN KEY(customer_id,batch_id) REFERENCES __SOPHIA_RUNTIME_SCHEMA__.student_case_invoice_draft_batches(customer_id,batch_id),
  FOREIGN KEY(xero_connection_id,customer_id) REFERENCES __SOPHIA_RUNTIME_SCHEMA__.xero_connections(xero_connection_id,customer_id),
  CHECK((status='created')=(xero_invoice_id IS NOT NULL AND completed_at IS NOT NULL))
);
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.student_case_xero_invoice_exports ENABLE ROW LEVEL SECURITY;
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.student_case_xero_invoice_exports FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON __SOPHIA_RUNTIME_SCHEMA__.student_case_xero_invoice_exports
  USING(customer_id=NULLIF(current_setting('sophia.tenant_id',true),'')::uuid)
  WITH CHECK(customer_id=NULLIF(current_setting('sophia.tenant_id',true),'')::uuid);
REVOKE ALL ON __SOPHIA_RUNTIME_SCHEMA__.student_case_xero_invoice_exports FROM PUBLIC,sophia_runtime_app;
GRANT SELECT,INSERT,UPDATE ON __SOPHIA_RUNTIME_SCHEMA__.student_case_xero_invoice_exports TO sophia_runtime_app;
CREATE INDEX student_case_xero_invoice_exports_case ON __SOPHIA_RUNTIME_SCHEMA__.student_case_xero_invoice_exports(customer_id,case_id,requested_at DESC);
