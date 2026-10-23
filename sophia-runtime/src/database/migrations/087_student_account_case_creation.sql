-- Add student + first case share the Runtime tenant transaction. Do not grant
-- the application role direct access to identity accounts or their counter.
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.student_operations_write_requests
  DROP CONSTRAINT student_operations_write_requests_operation_check,
  ADD CONSTRAINT student_operations_write_requests_operation_check
    CHECK (operation IN ('student.create','student.update','case.create','case.create_student','case.update','case.link_invoice'));

CREATE FUNCTION __SOPHIA_RUNTIME_SCHEMA__.create_student_case_account(
  requested_name text, requested_email text, requested_mobile text, requested_phone text
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  tenant_id uuid := NULLIF(current_setting('sophia.tenant_id', true), '')::uuid;
  company uuid;
  account_id uuid := gen_random_uuid();
  profile_id uuid;
  next_number bigint;
  reference text;
BEGIN
  IF tenant_id IS NULL OR requested_name IS NULL
    OR length(btrim(requested_name)) NOT BETWEEN 1 AND 200
    OR requested_email IS NULL OR length(btrim(requested_email)) NOT BETWEEN 3 AND 320
    OR btrim(requested_email) !~* '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
    OR (requested_mobile IS NOT NULL AND length(requested_mobile)>80)
    OR (requested_phone IS NOT NULL AND length(requested_phone)>80) THEN
    RAISE EXCEPTION 'Invalid student account details';
  END IF;
  SELECT b.company_id INTO company
    FROM __SOPHIA_RUNTIME_SCHEMA__.customers c JOIN public.bm_company b
      ON b.company_id::text=c.external_company_id
   WHERE c.customer_id=tenant_id AND c.status='active' AND b.workspace_profile='student_operations';
  IF NOT FOUND OR (SELECT count(*) FROM __SOPHIA_RUNTIME_SCHEMA__.customers c
    WHERE c.status='active' AND c.external_company_id=company::text)<>1 THEN
    RAISE EXCEPTION 'Student company mapping is unavailable';
  END IF;
  -- Same lock as case profile email updates. Never attach a new student to an
  -- existing login by matching an email/name, especially across companies.
  PERFORM pg_advisory_xact_lock(hashtextextended('student-email:' || lower(btrim(requested_email)),0));
  IF EXISTS(SELECT 1 FROM public.users WHERE lower(btrim(email))=lower(btrim(requested_email))) THEN
    RAISE unique_violation USING MESSAGE='Student email is already in use';
  END IF;
  UPDATE public.bm_student_id_counter SET last_value=last_value+1 WHERE id=true RETURNING last_value INTO next_number;
  IF NOT FOUND THEN RAISE EXCEPTION 'Student number allocator unavailable'; END IF;
  reference:='STD-' || next_number::text;
  -- No shared/default password, invitation or emailed credential. A random
  -- unknown secret is hashed; any future login onboarding is separate work.
  INSERT INTO public.users(id,company_id,name,email,username,password,type,status,student_id,image,bio,cel,tel)
    VALUES(account_id,company,btrim(requested_name),lower(btrim(requested_email)),
      'student_' || replace(account_id::text,'-',''),
      public.crypt(gen_random_uuid()::text || gen_random_uuid()::text,public.gen_salt('bf',10)),
      'student','active',reference,'','',NULLIF(btrim(requested_mobile),''),NULLIF(btrim(requested_phone),''));
  INSERT INTO __SOPHIA_RUNTIME_SCHEMA__.student_operations_students(customer_id,student_reference,legal_name,email)
    VALUES(tenant_id,reference,btrim(requested_name),lower(btrim(requested_email))) RETURNING student_id INTO profile_id;
  INSERT INTO __SOPHIA_RUNTIME_SCHEMA__.student_operations_student_user_links(customer_id,student_id,company_id,user_id,student_reference)
    VALUES(tenant_id,profile_id,company,account_id,reference);
  RETURN account_id;
END;
$$;
REVOKE ALL ON FUNCTION __SOPHIA_RUNTIME_SCHEMA__.create_student_case_account(text,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION __SOPHIA_RUNTIME_SCHEMA__.create_student_case_account(text,text,text,text) TO sophia_runtime_app;
