-- One-off, owner-run repair requested 2026-10-12.
-- Keep Joselin Nicole Aburto Moya (STD-398) and move Joselin Aburto's
-- Xero identity (STD-1069) to that account. Preserve the old account as
-- archived history; do not delete Xero or user records.
-- Run only after reviewing the target accounts and with no active user sync.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DO $repair$
DECLARE
  old_student_id CONSTANT text := 'STD-1069';
  keep_student_id CONSTANT text := 'STD-398';
  old_user record;
  keep_user record;
  old_candidate record;
  customer uuid;
  n integer;
  moved_contacts integer;
  moved_invoices integer;
  moved_candidates integer;
BEGIN
  SELECT id, company_id, name, type, status
    INTO STRICT old_user
    FROM public.users WHERE student_id = old_student_id FOR UPDATE;
  SELECT id, company_id, name, type, status
    INTO STRICT keep_user
    FROM public.users WHERE student_id = keep_student_id FOR UPDATE;

  IF old_user.company_id IS DISTINCT FROM keep_user.company_id
     OR old_user.type IS DISTINCT FROM 'student'
     OR keep_user.type IS DISTINCT FROM 'student'
     OR old_user.status IS DISTINCT FROM 'active'
     OR keep_user.status IS DISTINCT FROM 'active'
     OR lower(btrim(old_user.name)) IS DISTINCT FROM 'joselin aburto'
     OR lower(btrim(keep_user.name)) IS DISTINCT FROM 'joselin nicole aburto moya' THEN
    RAISE EXCEPTION 'Student account identity or status differs from the approved repair; no changes made';
  END IF;

  SELECT c.customer_id INTO STRICT customer
    FROM sophia_runtime.customers c
    JOIN public.bm_company company ON company.company_id = old_user.company_id
    WHERE c.external_company_id = old_user.company_id::text
      AND c.status = 'active'
      AND company.workspace_profile = 'student_operations';

  -- The normal sync worker uses this lock for every scan and apply batch.
  PERFORM pg_advisory_xact_lock(hashtext('student-sync:' || customer::text));
  IF EXISTS (
    SELECT 1 FROM public.bm_xero_student_sync_runs
    WHERE customer_id = customer AND status IN ('queued', 'processing')
  ) THEN
    RAISE EXCEPTION 'A Student-user sync is active; retry this repair after it finishes';
  END IF;

  SELECT count(*) INTO n FROM public.bm_xero_student_sync_candidates
    WHERE customer_id = customer AND student_id = old_student_id;
  IF n <> 1 THEN
    RAISE EXCEPTION 'Expected exactly one STD-1069 candidate, found %; no changes made', n;
  END IF;
  SELECT * INTO STRICT old_candidate
    FROM public.bm_xero_student_sync_candidates
    WHERE customer_id = customer AND student_id = old_student_id FOR UPDATE;
  IF lower(btrim(old_candidate.display_name)) IS DISTINCT FROM 'joselin aburto'
     OR old_candidate.status IS DISTINCT FROM 'linked' THEN
    RAISE EXCEPTION 'The STD-1069 candidate does not match the approved linked Joselin Aburto record';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.bm_xero_student_sync_candidates
    WHERE customer_id = customer AND student_id = keep_student_id
      AND lower(btrim(display_name)) = 'joselin nicole aburto moya'
      AND status = 'linked'
  ) OR NOT EXISTS (
    SELECT 1 FROM public.bm_xero_student_identities
    WHERE customer_id = customer AND company_id = old_user.company_id
      AND student_id = keep_student_id
  ) THEN
    RAISE EXCEPTION 'The canonical STD-398 Xero identity is missing or differs from the approved record';
  END IF;

  -- Do not sweep any unrelated contacts or invoices merely because they
  -- happen to reference the old ID. Stop and investigate if there are any.
  IF EXISTS (
    SELECT 1 FROM public.bm_xero_student_contact_links l
    WHERE l.customer_id = customer AND l.student_id = old_student_id
      AND (l.connection_id IS DISTINCT FROM old_candidate.connection_id
           OR NOT COALESCE(l.contact_id = ANY(old_candidate.contact_ids), false))
  ) OR EXISTS (
    SELECT 1 FROM sophia_runtime.student_operations_xero_invoices i
    WHERE i.customer_id = customer AND i.student_id = old_student_id
      AND (i.xero_connection_id IS DISTINCT FROM old_candidate.connection_id
           OR NOT COALESCE(i.xero_contact_id = ANY(old_candidate.contact_ids), false))
  ) OR EXISTS (
    SELECT 1 FROM sophia_runtime.student_operations_xero_invoices i
    WHERE i.customer_id = customer
      AND i.xero_connection_id = old_candidate.connection_id
      AND i.xero_contact_id = ANY(old_candidate.contact_ids)
      AND i.student_id IS DISTINCT FROM old_student_id
  ) THEN
    RAISE EXCEPTION 'STD-1069 has unexpected or conflicting Xero associations; no changes made';
  END IF;
  SELECT count(*) INTO n FROM public.bm_xero_student_contact_links
    WHERE customer_id = customer AND student_id = old_student_id;
  IF n < 1 THEN
    RAISE EXCEPTION 'No STD-1069 contact links found; no changes made';
  END IF;
  IF EXISTS (
    SELECT contact_id FROM unnest(old_candidate.contact_ids) AS source(contact_id)
    EXCEPT
    SELECT l.contact_id FROM public.bm_xero_student_contact_links l
    WHERE l.customer_id = customer
      AND l.connection_id = old_candidate.connection_id
      AND l.student_id = old_student_id
  ) THEN
    RAISE EXCEPTION 'Not every STD-1069 source contact has an old-ID link; no changes made';
  END IF;
  SELECT count(*) INTO n FROM sophia_runtime.student_operations_xero_invoices
    WHERE customer_id = customer AND student_id = old_student_id;
  IF n < 1 THEN
    RAISE EXCEPTION 'No STD-1069 invoices found; no changes made';
  END IF;
  IF EXISTS (
    SELECT 1 FROM sophia_runtime.business_pack_entitlements
    WHERE customer_id = customer AND identity_user_id = old_user.id::text
      AND status = 'active'
  ) THEN
    RAISE EXCEPTION 'STD-1069 has an active workspace entitlement; review before archiving';
  END IF;

  UPDATE public.bm_xero_student_contact_links
    SET student_id = keep_student_id
    WHERE customer_id = customer AND student_id = old_student_id;
  GET DIAGNOSTICS moved_contacts = ROW_COUNT;
  UPDATE sophia_runtime.student_operations_xero_invoices
    SET student_id = keep_student_id
    WHERE customer_id = customer AND student_id = old_student_id;
  GET DIAGNOSTICS moved_invoices = ROW_COUNT;
  UPDATE public.bm_xero_student_sync_candidates
    SET student_id = keep_student_id, status = 'linked', reason = NULL
    WHERE customer_id = customer AND student_id = old_student_id;
  GET DIAGNOSTICS moved_candidates = ROW_COUNT;
  UPDATE public.users SET status = 'archived', updatedat = now()
    WHERE id = old_user.id AND status = 'active';
  IF NOT FOUND OR moved_candidates <> 1 THEN
    RAISE EXCEPTION 'Could not archive exactly the duplicate Student account; repair rolled back';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.bm_xero_student_contact_links
    WHERE customer_id = customer AND student_id = old_student_id
  ) OR EXISTS (
    SELECT 1 FROM sophia_runtime.student_operations_xero_invoices
    WHERE customer_id = customer AND student_id = old_student_id
  ) OR EXISTS (
    SELECT 1 FROM public.bm_xero_student_sync_candidates
    WHERE customer_id = customer AND student_id = old_student_id
  ) THEN
    RAISE EXCEPTION 'An old-ID association remains; repair rolled back';
  END IF;

  RAISE NOTICE 'Merged % contact link(s), % invoice(s), and % candidate into %. Archived duplicate %.',
    moved_contacts, moved_invoices, moved_candidates, keep_student_id, old_student_id;
END;
$repair$;

COMMIT;
