ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.student_operations_xero_invoices
  ADD COLUMN payment_track text CHECK (payment_track IS NULL OR length(payment_track) <= 200),
  ADD COLUMN sent_to_contact boolean NOT NULL DEFAULT false,
  ADD COLUMN line_items jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(line_items) = 'array');

ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.student_operations_xero_sync_configurations
  ADD COLUMN invoice_detail_version smallint NOT NULL DEFAULT 0
  CHECK (invoice_detail_version BETWEEN 0 AND 1);

CREATE INDEX student_operations_xero_invoice_register
  ON __SOPHIA_RUNTIME_SCHEMA__.student_operations_xero_invoices(
    customer_id, xero_connection_id, invoice_date DESC, xero_invoice_id
  );
