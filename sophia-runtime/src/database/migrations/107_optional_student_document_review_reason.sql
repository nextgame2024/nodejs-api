ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.student_document_reviews
  ALTER COLUMN reason DROP NOT NULL;

ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.student_document_reviews
  DROP CONSTRAINT IF EXISTS student_document_reviews_reason_check;

ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.student_document_reviews
  ADD CONSTRAINT student_document_reviews_reason_length
  CHECK(reason IS NULL OR length(reason) BETWEEN 1 AND 500);
