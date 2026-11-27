ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.student_trust_receipt_verifications
  ADD COLUMN imported_payment_amount numeric(16,2)
  CHECK (imported_payment_amount > 0 AND imported_payment_amount <= amount);
