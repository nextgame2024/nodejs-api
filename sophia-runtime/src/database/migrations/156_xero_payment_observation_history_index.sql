CREATE INDEX student_xero_payment_observation_history_idx
  ON __SOPHIA_RUNTIME_SCHEMA__.student_xero_payment_observations
  (customer_id, xero_connection_id, xero_invoice_id, payment_id, first_seen_at DESC, observation_id DESC);
