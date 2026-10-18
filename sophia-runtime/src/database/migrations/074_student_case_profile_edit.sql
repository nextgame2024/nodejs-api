-- A case edit may update the linked student account without granting Runtime
-- broad UPDATE privileges on public.users. The tenant and case link are checked
-- inside the owner-operated function in the same transaction as the case write.
CREATE FUNCTION __SOPHIA_RUNTIME_SCHEMA__.update_student_case_profile(
  requested_case_id uuid, requested_name text, requested_email text,
  requested_mobile text, requested_phone text
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  tenant_id uuid := NULLIF(current_setting('sophia.tenant_id', true), '')::uuid;
  linked record;
BEGIN
  IF tenant_id IS NULL OR requested_name IS NULL
    OR length(btrim(requested_name)) NOT BETWEEN 1 AND 200
    OR requested_email IS NULL OR length(btrim(requested_email)) NOT BETWEEN 3 AND 320
    OR btrim(requested_email) !~* '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
    OR (requested_mobile IS NOT NULL AND length(requested_mobile) > 80)
    OR (requested_phone IS NOT NULL AND length(requested_phone) > 80) THEN
    RAISE EXCEPTION 'Invalid case profile update';
  END IF;

  SELECT l.student_id, u.id AS user_id INTO linked
    FROM __SOPHIA_RUNTIME_SCHEMA__.student_operations_cases c
    JOIN __SOPHIA_RUNTIME_SCHEMA__.student_operations_student_user_links l
      ON l.customer_id = c.customer_id AND l.student_id = c.student_id
    JOIN __SOPHIA_RUNTIME_SCHEMA__.customers tenant
      ON tenant.customer_id = c.customer_id AND tenant.status = 'active'
    JOIN public.users u
      ON u.id = l.user_id AND u.company_id::text = tenant.external_company_id
   WHERE c.customer_id = tenant_id AND c.case_id = requested_case_id
     AND u.type::text = 'student' AND u.status::text <> 'archived';
  IF NOT FOUND THEN RAISE EXCEPTION 'Case student account is unavailable'; END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('student-email:' || lower(btrim(requested_email)), 0));
  IF EXISTS (SELECT 1 FROM public.users WHERE lower(email) = lower(btrim(requested_email)) AND id <> linked.user_id) THEN
    RAISE unique_violation USING MESSAGE = 'Student email is already in use';
  END IF;

  UPDATE public.users SET name = btrim(requested_name),
    email = btrim(requested_email),
    cel = NULLIF(btrim(requested_mobile), ''),
    tel = NULLIF(btrim(requested_phone), ''), updatedat = now()
   WHERE id = linked.user_id;
  UPDATE __SOPHIA_RUNTIME_SCHEMA__.student_operations_students
     SET legal_name = btrim(requested_name), email = btrim(requested_email), updated_at = now()
   WHERE customer_id = tenant_id AND student_id = linked.student_id;
END;
$$;
REVOKE ALL ON FUNCTION __SOPHIA_RUNTIME_SCHEMA__.update_student_case_profile(uuid,text,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION __SOPHIA_RUNTIME_SCHEMA__.update_student_case_profile(uuid,text,text,text,text)
  TO sophia_runtime_app;
