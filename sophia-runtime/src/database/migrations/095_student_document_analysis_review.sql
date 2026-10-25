ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.student_operations_write_requests
  DROP CONSTRAINT student_operations_write_requests_operation_check,
  ADD CONSTRAINT student_operations_write_requests_operation_check CHECK(operation IN
    ('student.create','student.update','case.create','case.create_student','case.update','case.link_invoice',
     'document_type.create','document_type.update','case.checklist.update','document.analysis.review','document.analysis.retry'));
CREATE INDEX student_analysis_document_latest ON __SOPHIA_RUNTIME_SCHEMA__.student_document_analysis_jobs
  (customer_id,case_id,document_id,created_at DESC,job_id DESC);
CREATE INDEX student_analysis_review_latest ON __SOPHIA_RUNTIME_SCHEMA__.student_document_reviews
  (customer_id,case_id,document_id,review_version DESC);
