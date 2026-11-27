ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.student_trust_receipt_verifications
  ADD COLUMN payment_purpose text
    CHECK (payment_purpose IS NULL OR char_length(payment_purpose) BETWEEN 1 AND 240);
