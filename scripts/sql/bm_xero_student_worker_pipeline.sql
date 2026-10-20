-- Apply as identity database owner before enabling dedicated worker mode.
-- Existing jobs are manual by default so no user-requested work is stranded.
BEGIN;
ALTER TABLE public.bm_xero_student_sync_runs ADD COLUMN IF NOT EXISTS
  trigger_type text NOT NULL DEFAULT 'manual'
  CHECK(trigger_type IN ('manual','nightly','source'));
ALTER TABLE public.bm_xero_student_sync_runs ADD COLUMN IF NOT EXISTS source_connection_id uuid;
COMMIT;
