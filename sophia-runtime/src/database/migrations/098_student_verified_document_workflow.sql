-- Keep the stable checklist_complete key; its public label is Verified Documents.
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.student_operations_cases
  ADD COLUMN document_review_hold boolean NOT NULL DEFAULT false;
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.student_operations_cases
  DROP CONSTRAINT student_operations_cases_stage_status_check,
  ADD CONSTRAINT student_operations_cases_stage_status_check CHECK (
    (current_stage='imported_pending_review' AND lifecycle_status='open' AND migration_key IS NOT NULL)
    OR (current_stage='documents_requested' AND lifecycle_status IN ('pre_sale','on_hold'))
    OR (current_stage='checklist_complete' AND lifecycle_status='pre_sale')
    OR (current_stage='awaiting_payment' AND lifecycle_status IN ('pre_sale','on_hold'))
    OR (current_stage IN ('payment_received','invoices_created') AND lifecycle_status='open')
    OR (current_stage='payment_monitoring' AND lifecycle_status IN ('payment_overdue','collections','payment_done'))
    OR (current_stage='payments_complete' AND lifecycle_status='closed')
    OR current_stage IN ('new_application','pre_payment_audit','student_payment_received','reconciliation','cover_letter','college_payment','collections','commission_recovery','completed')
  );

-- These are immutable Sophia proposals, not Xero invoices or receivables.
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.student_case_offers
  ADD CONSTRAINT student_case_offer_case_scope UNIQUE(customer_id,case_id,offer_id);
CREATE TABLE __SOPHIA_RUNTIME_SCHEMA__.student_case_invoice_draft_batches (
  customer_id uuid NOT NULL,
  case_id uuid NOT NULL,
  offer_id uuid NOT NULL,
  batch_id uuid NOT NULL DEFAULT gen_random_uuid(),
  advisor_id uuid NOT NULL,
  advisor_label text NOT NULL,
  snapshot jsonb NOT NULL CHECK(jsonb_typeof(snapshot)='object'),
  actor_identity_user_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(customer_id,batch_id),
  UNIQUE(customer_id,case_id,offer_id),
  FOREIGN KEY(customer_id,case_id,offer_id) REFERENCES __SOPHIA_RUNTIME_SCHEMA__.student_case_offers(customer_id,case_id,offer_id),
  FOREIGN KEY(customer_id,advisor_id) REFERENCES __SOPHIA_RUNTIME_SCHEMA__.student_operations_advisor_directory(customer_id,advisor_id)
);
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.student_case_invoice_draft_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.student_case_invoice_draft_batches FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON __SOPHIA_RUNTIME_SCHEMA__.student_case_invoice_draft_batches
  USING(customer_id=NULLIF(current_setting('sophia.tenant_id',true),'')::uuid)
  WITH CHECK(customer_id=NULLIF(current_setting('sophia.tenant_id',true),'')::uuid);
REVOKE ALL ON __SOPHIA_RUNTIME_SCHEMA__.student_case_invoice_draft_batches FROM PUBLIC,sophia_runtime_app;
GRANT SELECT,INSERT ON __SOPHIA_RUNTIME_SCHEMA__.student_case_invoice_draft_batches TO sophia_runtime_app;
CREATE INDEX student_case_invoice_draft_lookup ON __SOPHIA_RUNTIME_SCHEMA__.student_case_invoice_draft_batches(customer_id,case_id,created_at DESC);
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.student_operations_write_requests
  DROP CONSTRAINT student_operations_write_requests_operation_check,
  ADD CONSTRAINT student_operations_write_requests_operation_check CHECK(operation IN (
    'student.create','student.update','case.create','case.create_student','case.update','case.link_invoice',
    'document_type.create','document_type.update','case.checklist.update','document.analysis.review',
    'document.analysis.retry','document.analysis.start','case.invoice_drafts.prepare'
  ));
