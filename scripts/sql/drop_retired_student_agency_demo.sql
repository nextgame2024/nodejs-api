BEGIN;

-- Permanently retire the former migration-guidance/consultation demonstration.
-- Deliberately avoid CASCADE: an unexpected external dependency must fail closed.
DROP TABLE IF EXISTS public.bm_student_consultation_deliveries;
DROP TABLE IF EXISTS public.bm_student_consultation_bookings;
DROP TABLE IF EXISTS public.bm_student_consultation_slots;
DROP TABLE IF EXISTS public.bm_student_advisers;
DROP TABLE IF EXISTS public.bm_student_source_snapshots;
DROP TABLE IF EXISTS public.bm_student_agency_knowledge;

COMMIT;
