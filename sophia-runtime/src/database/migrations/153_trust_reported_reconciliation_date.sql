ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.student_trust_payment_reconciliation_checks
  ADD COLUMN reported_reconciled_on date
    CHECK (reported_reconciled_on <= (checked_at AT TIME ZONE 'Australia/Brisbane')::date);
