-- Preserve historical case rows while enforcing the new workflow for every
-- newly selected stage. The imported stage is reserved for migration rows.
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.student_operations_cases
  DROP CONSTRAINT student_operations_cases_lifecycle_status_check;

ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.student_operations_cases
  ADD CONSTRAINT student_operations_cases_lifecycle_status_check
  CHECK (lifecycle_status IN (
    'open', 'pre_sale', 'on_hold', 'payment_overdue', 'collections',
    'payment_done', 'closed', 'completed', 'cancelled'
  ));

ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.student_operations_cases
  ALTER COLUMN current_stage SET DEFAULT 'documents_requested',
  ALTER COLUMN lifecycle_status SET DEFAULT 'pre_sale';

ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.student_operations_cases
  ADD CONSTRAINT student_operations_cases_stage_status_check
  CHECK (
    (current_stage = 'imported_pending_review'
      AND lifecycle_status = 'open' AND migration_key IS NOT NULL)
    OR (current_stage IN ('documents_requested', 'checklist_complete')
      AND lifecycle_status = 'pre_sale')
    OR (current_stage = 'awaiting_payment'
      AND lifecycle_status IN ('pre_sale', 'on_hold'))
    OR (current_stage IN ('payment_received', 'invoices_created')
      AND lifecycle_status = 'open')
    OR (current_stage = 'payment_monitoring'
      AND lifecycle_status IN ('payment_overdue', 'collections', 'payment_done'))
    OR (current_stage = 'payments_complete' AND lifecycle_status = 'closed')
    OR current_stage IN (
      'new_application', 'pre_payment_audit', 'student_payment_received',
      'reconciliation', 'cover_letter', 'college_payment',
      'collections', 'commission_recovery', 'completed'
    )
  );
