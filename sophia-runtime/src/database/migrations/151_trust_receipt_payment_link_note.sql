ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.student_trust_receipt_payment_links
  ADD COLUMN decision_note text
    CHECK (decision_note IS NULL OR char_length(decision_note) BETWEEN 1 AND 500);
