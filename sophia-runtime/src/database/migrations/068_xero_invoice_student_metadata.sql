ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.student_operations_xero_invoices
  ADD COLUMN invoice_reference text CHECK (invoice_reference IS NULL OR length(invoice_reference) <= 500),
  ADD COLUMN concept text CHECK (concept IS NULL OR length(concept) <= 1000),
  ADD COLUMN advisor_name text CHECK (advisor_name IS NULL OR length(advisor_name) <= 200),
  ADD COLUMN college_name text CHECK (college_name IS NULL OR length(college_name) <= 200);

ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.student_operations_xero_sync_configurations
  ADD COLUMN invoice_metadata_version smallint NOT NULL DEFAULT 0
  CHECK (invoice_metadata_version BETWEEN 0 AND 1);
