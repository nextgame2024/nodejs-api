-- Manual invoices reuse the durable draft/export pipeline, without an offer.
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.student_case_invoice_draft_batches ALTER COLUMN offer_id DROP NOT NULL;
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.student_case_invoice_draft_batches
  ADD CONSTRAINT student_manual_invoice_case_scope FOREIGN KEY(customer_id,case_id)
  REFERENCES __SOPHIA_RUNTIME_SCHEMA__.student_operations_cases(customer_id,case_id);
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.student_operations_write_requests
  DROP CONSTRAINT student_operations_write_requests_operation_check,
  ADD CONSTRAINT student_operations_write_requests_operation_check CHECK(operation IN (
    'student.create','student.update','case.create','case.create_student','case.update','case.link_invoice',
    'document_type.create','document_type.update','case.checklist.update','document.analysis.review',
    'document.analysis.retry','document.analysis.start','case.invoice_drafts.prepare','case.invoice_manual.prepare'
  ));
