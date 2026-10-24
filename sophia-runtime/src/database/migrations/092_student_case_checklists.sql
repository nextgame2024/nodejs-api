-- Each checklist belongs to a case, not a Contact or student account.
CREATE TABLE __SOPHIA_RUNTIME_SCHEMA__.student_operations_case_checklist (
  customer_id uuid NOT NULL,
  case_id uuid NOT NULL,
  checklist_status text NOT NULL DEFAULT 'pre_sale' CHECK(checklist_status='pre_sale'),
  item_key text NOT NULL CHECK(item_key IN ('signed_engagement_letter','invoice_loo_consistency','document_completeness','pending_track_status')),
  completed boolean NOT NULL DEFAULT false,
  record_version integer NOT NULL DEFAULT 1 CHECK(record_version>0),
  actor_identity_user_id text NOT NULL,
  actor_kind text NOT NULL CHECK(actor_kind IN ('user','automation')),
  actor_name text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(customer_id,case_id,checklist_status,item_key),
  FOREIGN KEY(customer_id,case_id) REFERENCES __SOPHIA_RUNTIME_SCHEMA__.student_operations_cases(customer_id,case_id)
);
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.student_operations_case_checklist ENABLE ROW LEVEL SECURITY;
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.student_operations_case_checklist FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON __SOPHIA_RUNTIME_SCHEMA__.student_operations_case_checklist
  USING(customer_id=NULLIF(current_setting('sophia.tenant_id',true),'')::uuid)
  WITH CHECK(customer_id=NULLIF(current_setting('sophia.tenant_id',true),'')::uuid);
REVOKE ALL ON __SOPHIA_RUNTIME_SCHEMA__.student_operations_case_checklist FROM PUBLIC,sophia_runtime_app;
GRANT SELECT,INSERT,UPDATE ON __SOPHIA_RUNTIME_SCHEMA__.student_operations_case_checklist TO sophia_runtime_app;
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.student_operations_write_requests
  DROP CONSTRAINT student_operations_write_requests_operation_check,
  ADD CONSTRAINT student_operations_write_requests_operation_check CHECK(operation IN
    ('student.create','student.update','case.create','case.create_student','case.update','case.link_invoice','document_type.create','document_type.update','case.checklist.update'));
