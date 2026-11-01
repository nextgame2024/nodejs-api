ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.student_operations_cases
  ADD COLUMN archived_at timestamptz,
  ADD COLUMN archive_previous_workflow jsonb;
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.student_operations_cases
  DROP CONSTRAINT student_operations_cases_stage_status_check,
  ADD CONSTRAINT student_operations_cases_stage_status_check CHECK (
    (current_stage='imported_pending_review' AND lifecycle_status='open' AND migration_key IS NOT NULL)
    OR (current_stage='documents_requested' AND lifecycle_status IN ('pre_sale','on_hold'))
    OR (current_stage='checklist_complete' AND lifecycle_status='pre_sale')
    OR (current_stage='awaiting_payment' AND lifecycle_status IN ('pre_sale','on_hold'))
    OR (current_stage='payment_monitoring' AND lifecycle_status IN ('awaiting_payment','payment_received','payment_overdue','collections','payment_done'))
    OR (current_stage='payments_complete' AND lifecycle_status='closed')
    OR (current_stage='terminated' AND lifecycle_status='closed')
    OR current_stage IN ('new_application','pre_payment_audit','student_payment_received','reconciliation','cover_letter','college_payment','collections','commission_recovery','completed')
  ),
  ADD CONSTRAINT student_case_archive_workflow CHECK (
    (archived_at IS NULL AND archive_previous_workflow IS NULL AND current_stage<>'terminated') OR
    (archived_at IS NOT NULL AND current_stage='terminated' AND lifecycle_status='closed' AND
      archive_previous_workflow IS NOT NULL AND jsonb_typeof(archive_previous_workflow)='object')
  );
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.student_operations_write_requests
  DROP CONSTRAINT student_operations_write_requests_operation_check,
  ADD CONSTRAINT student_operations_write_requests_operation_check CHECK(operation IN (
    'student.create','student.update','case.create','case.create_student','case.update','case.link_invoice',
    'document_type.create','document_type.update','case.checklist.update','document.analysis.review',
    'document.analysis.retry','document.analysis.start','case.invoice_drafts.prepare','case.invoice_manual.prepare',
    'case.archive','case.restore'
  ));
