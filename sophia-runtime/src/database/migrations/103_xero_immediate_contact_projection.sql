-- A verified interactive Contact receipt precedes the first register sync.
-- Keep the existing tenant FK, RLS and grants; nightly sync supplies provenance.
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.student_operations_xero_contacts
  ALTER COLUMN last_seen_sync_run_id DROP NOT NULL;
