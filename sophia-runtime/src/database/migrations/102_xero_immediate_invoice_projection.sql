-- Invoices created interactively are confirmed before a register sync exists.
-- A later Xero sync replaces this null with its durable sync-run provenance.
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.student_operations_xero_invoices
  ALTER COLUMN last_seen_sync_run_id DROP NOT NULL;

