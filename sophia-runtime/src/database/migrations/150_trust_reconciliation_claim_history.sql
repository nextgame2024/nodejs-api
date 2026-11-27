CREATE INDEX student_trust_reconciliation_claim_history
  ON __SOPHIA_RUNTIME_SCHEMA__.student_trust_reconciliation_claims
  (customer_id, connection_id, payment_id, claimed_at DESC, claim_id DESC);
