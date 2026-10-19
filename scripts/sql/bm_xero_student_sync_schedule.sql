-- Apply as owner after bm_xero_student_user_sync.sql and Runtime migration 078.
BEGIN;
ALTER TABLE public.bm_xero_student_sync_config
  ADD COLUMN IF NOT EXISTS next_nightly_at timestamptz NOT NULL DEFAULT
    (((now() AT TIME ZONE 'Australia/Brisbane')::date + 1 + time '02:00') AT TIME ZONE 'Australia/Brisbane');
UPDATE public.bm_xero_student_sync_config SET automatic=true;
COMMIT;
