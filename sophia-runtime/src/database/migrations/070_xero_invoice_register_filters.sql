CREATE INDEX student_operations_xero_invoice_status_date
  ON __SOPHIA_RUNTIME_SCHEMA__.student_operations_xero_invoices
    (customer_id, xero_connection_id, invoice_status, invoice_date DESC, xero_invoice_id)
  WHERE invoice_type IN ('ACCREC', 'ACCRECCREDIT', 'RECEIVE-PREPAYMENT', 'RECEIVE-OVERPAYMENT');

CREATE INDEX student_operations_xero_invoice_payment_track
  ON __SOPHIA_RUNTIME_SCHEMA__.student_operations_xero_invoices
    (customer_id, xero_connection_id, lower(btrim(payment_track)), invoice_date DESC, xero_invoice_id)
  WHERE payment_track IS NOT NULL
    AND invoice_type IN ('ACCREC', 'ACCRECCREDIT', 'RECEIVE-PREPAYMENT', 'RECEIVE-OVERPAYMENT');
