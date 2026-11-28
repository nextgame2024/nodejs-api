CREATE TABLE __SOPHIA_RUNTIME_SCHEMA__.student_college_obligations (
  customer_id uuid NOT NULL, case_id uuid NOT NULL, obligation_id uuid NOT NULL, college_id uuid NOT NULL,
  schedule_id uuid, offer_id uuid, offer_sequence integer, instalment text NOT NULL, policy_ref text NOT NULL, method text NOT NULL CHECK(method IN ('gross','net')),
  gross numeric(16,2) NOT NULL CHECK(gross>0), offset_limit numeric(16,2) NOT NULL CHECK(offset_limit>=0 AND offset_limit<gross AND (method='net' OR offset_limit=0)),
  due_on date NOT NULL, funding_on date, bill_ref text, bill_connection_id uuid, bill_invoice_id uuid, actor text NOT NULL, fingerprint text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(customer_id,case_id,obligation_id),
  FOREIGN KEY(customer_id,case_id,college_id) REFERENCES __SOPHIA_RUNTIME_SCHEMA__.student_operations_case_colleges,
  FOREIGN KEY(customer_id,schedule_id) REFERENCES __SOPHIA_RUNTIME_SCHEMA__.student_operations_case_payment_schedule(customer_id,payment_schedule_id),
  CHECK ((bill_connection_id IS NULL)=(bill_invoice_id IS NULL)),
  FOREIGN KEY(customer_id,bill_connection_id,bill_invoice_id) REFERENCES __SOPHIA_RUNTIME_SCHEMA__.student_operations_xero_invoices(customer_id,xero_connection_id,xero_invoice_id),
  CHECK ((offer_id IS NULL)=(offer_sequence IS NULL)),
  FOREIGN KEY(customer_id,offer_id,offer_sequence) REFERENCES __SOPHIA_RUNTIME_SCHEMA__.student_case_offer_instalments(customer_id,offer_id,sequence),
  UNIQUE(customer_id,offer_id,offer_sequence),
  UNIQUE(customer_id,schedule_id)
);
CREATE UNIQUE INDEX college_obligation_instalment ON __SOPHIA_RUNTIME_SCHEMA__.student_college_obligations(customer_id,case_id,college_id,lower(instalment));
CREATE INDEX college_obligation_due ON __SOPHIA_RUNTIME_SCHEMA__.student_college_obligations(customer_id,due_on,obligation_id);
CREATE TABLE __SOPHIA_RUNTIME_SCHEMA__.student_college_settlement_events (
  customer_id uuid NOT NULL, case_id uuid NOT NULL, obligation_id uuid NOT NULL, event_id uuid NOT NULL, proof_id uuid,
  kind text NOT NULL CHECK(kind IN ('direct_proof','direct_confirmation','agency_payment','applied_refund','unapplied_refund')),
  amount numeric(16,2) NOT NULL CHECK(amount>0), offset_amount numeric(16,2) NOT NULL CHECK(offset_amount>=0 AND (kind='agency_payment' OR offset_amount=0)),
  document_snapshot jsonb, occurred_on date NOT NULL, reference text NOT NULL, evidence text NOT NULL, actor text NOT NULL, fingerprint text NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(customer_id,case_id,obligation_id,event_id),
  FOREIGN KEY(customer_id,case_id,obligation_id) REFERENCES __SOPHIA_RUNTIME_SCHEMA__.student_college_obligations,
  FOREIGN KEY(customer_id,case_id,obligation_id,proof_id) REFERENCES __SOPHIA_RUNTIME_SCHEMA__.student_college_settlement_events,
  CHECK((kind='direct_confirmation')=(proof_id IS NOT NULL))
);
CREATE UNIQUE INDEX college_settlement_reference ON __SOPHIA_RUNTIME_SCHEMA__.student_college_settlement_events(customer_id,case_id,obligation_id,kind,lower(reference));
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.student_college_obligations ENABLE ROW LEVEL SECURITY;
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.student_college_obligations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON __SOPHIA_RUNTIME_SCHEMA__.student_college_obligations
  USING(customer_id=nullif(current_setting('sophia.tenant_id',true),'')::uuid)
  WITH CHECK(customer_id=nullif(current_setting('sophia.tenant_id',true),'')::uuid);
REVOKE ALL ON __SOPHIA_RUNTIME_SCHEMA__.student_college_obligations FROM sophia_runtime_app;
GRANT SELECT,INSERT ON __SOPHIA_RUNTIME_SCHEMA__.student_college_obligations TO sophia_runtime_app;
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.student_college_settlement_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.student_college_settlement_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON __SOPHIA_RUNTIME_SCHEMA__.student_college_settlement_events
  USING(customer_id=nullif(current_setting('sophia.tenant_id',true),'')::uuid)
  WITH CHECK(customer_id=nullif(current_setting('sophia.tenant_id',true),'')::uuid);
REVOKE ALL ON __SOPHIA_RUNTIME_SCHEMA__.student_college_settlement_events FROM sophia_runtime_app;
GRANT SELECT,INSERT ON __SOPHIA_RUNTIME_SCHEMA__.student_college_settlement_events TO sophia_runtime_app;
