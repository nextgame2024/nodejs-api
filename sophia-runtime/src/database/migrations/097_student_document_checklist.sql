-- Local-only reconciliation cursor/evidence; no provider calls or historical classification.
CREATE TABLE __SOPHIA_RUNTIME_SCHEMA__.student_document_checklist_evaluations (
  customer_id uuid NOT NULL,
  case_id uuid NOT NULL,
  evidence jsonb NOT NULL CHECK(jsonb_typeof(evidence)='array'),
  checked_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(customer_id,case_id),
  FOREIGN KEY(customer_id,case_id) REFERENCES __SOPHIA_RUNTIME_SCHEMA__.student_operations_cases(customer_id,case_id)
);
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.student_document_checklist_evaluations ENABLE ROW LEVEL SECURITY;
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.student_document_checklist_evaluations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON __SOPHIA_RUNTIME_SCHEMA__.student_document_checklist_evaluations
  USING(customer_id=NULLIF(current_setting('sophia.tenant_id',true),'')::uuid)
  WITH CHECK(customer_id=NULLIF(current_setting('sophia.tenant_id',true),'')::uuid);
REVOKE ALL ON __SOPHIA_RUNTIME_SCHEMA__.student_document_checklist_evaluations FROM PUBLIC,sophia_runtime_app;
GRANT SELECT,INSERT,UPDATE ON __SOPHIA_RUNTIME_SCHEMA__.student_document_checklist_evaluations TO sophia_runtime_app;
CREATE INDEX student_document_checklist_due ON __SOPHIA_RUNTIME_SCHEMA__.student_document_checklist_evaluations(customer_id,checked_at,case_id);
CREATE INDEX student_document_authoritative_type ON __SOPHIA_RUNTIME_SCHEMA__.student_operations_case_documents
  (customer_id,case_id,document_type_id,discovered_at DESC,document_id DESC) WHERE document_type_id IS NOT NULL;
