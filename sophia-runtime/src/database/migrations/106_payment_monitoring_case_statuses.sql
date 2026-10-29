-- Definition/constraint change only. No case backfill or record updates.
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.student_operations_cases
  DROP CONSTRAINT student_operations_cases_stage_status_check,
  DROP CONSTRAINT student_operations_cases_lifecycle_status_check;
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.student_operations_cases
  ADD CONSTRAINT student_operations_cases_lifecycle_status_check CHECK(lifecycle_status IN (
    'open','pre_sale','on_hold','awaiting_payment','payment_received','payment_overdue','collections','payment_done','closed','completed','cancelled'));

ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.student_operations_cases
  ADD CONSTRAINT student_operations_cases_stage_status_check CHECK (
    (current_stage='imported_pending_review' AND lifecycle_status='open' AND migration_key IS NOT NULL)
    OR (current_stage='documents_requested' AND lifecycle_status IN ('pre_sale','on_hold'))
    OR (current_stage='checklist_complete' AND lifecycle_status='pre_sale')
    OR (current_stage='awaiting_payment' AND lifecycle_status IN ('pre_sale','on_hold'))
    OR (current_stage='payment_monitoring' AND lifecycle_status IN ('awaiting_payment','payment_received','payment_overdue','collections','payment_done'))
    OR (current_stage='payments_complete' AND lifecycle_status='closed')
    OR current_stage IN ('new_application','pre_payment_audit','student_payment_received','reconciliation','cover_letter','college_payment','collections','commission_recovery','completed')
  );
