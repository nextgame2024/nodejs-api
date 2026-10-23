-- Run separately as owner AFTER 088_user_password_setup_state.sql.
-- Scoped to the operator-requested existing 1,068 active students. Never resets
-- passwords, changes account status or affects staff/other companies.
BEGIN;
LOCK TABLE public.users IN SHARE ROW EXCLUSIVE MODE;
DO $$
DECLARE
  requested_customer constant uuid := '33ed40a6-7f2b-407c-aab2-de76b1cb45a8';
  expected_students constant integer := 1068;
  target_company uuid;
  matched integer;
  changed integer;
BEGIN
  SELECT b.company_id INTO STRICT target_company
    FROM sophia_runtime.customers c JOIN public.bm_company b
      ON b.company_id::text=c.external_company_id
    WHERE c.customer_id=requested_customer AND c.status='active'
      AND b.workspace_profile='student_operations';
  IF (SELECT count(*) FROM sophia_runtime.customers
      WHERE status='active' AND external_company_id=target_company::text)<>1 THEN
    RAISE EXCEPTION 'Ambiguous student company mapping; no backfill applied';
  END IF;
  SELECT count(*) INTO matched FROM public.users
    WHERE company_id=target_company AND type='student' AND status='active'
      AND student_id IS NOT NULL;
  IF matched<>expected_students THEN
    RAISE EXCEPTION 'Expected % active students; found %. Review scope before changing this script. No backfill applied.', expected_students,matched;
  END IF;
  UPDATE public.users SET must_change_password=true
    WHERE company_id=target_company AND type='student' AND status='active'
      AND student_id IS NOT NULL AND must_change_password=false;
  GET DIAGNOSTICS changed=ROW_COUNT;
  RAISE NOTICE 'Password setup backfill: % students matched; % flags changed. Passwords unchanged.',matched,changed;
END;
$$;
COMMIT;
