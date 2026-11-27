ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.student_trust_receipt_verifications
  ADD COLUMN statement_file_name text,
  ADD COLUMN statement_file_sha256 text,
  ADD COLUMN statement_record integer,
  ADD CONSTRAINT trust_receipt_statement_source_complete CHECK (
    num_nonnulls(statement_file_name, statement_file_sha256, statement_record) = 0 OR (
      num_nonnulls(statement_file_name, statement_file_sha256, statement_record) = 3
      AND length(statement_file_name) BETWEEN 1 AND 255
      AND statement_file_sha256 ~ '^[0-9a-f]{64}$'
      AND statement_record BETWEEN 2 AND 1001
      AND nullif(btrim(bank_transaction_id), '') IS NOT NULL
    )
  );

CREATE UNIQUE INDEX student_trust_receipt_statement_record
  ON __SOPHIA_RUNTIME_SCHEMA__.student_trust_receipt_verifications
  (customer_id, connection_id, statement_file_sha256, statement_record)
  WHERE statement_file_sha256 IS NOT NULL;
