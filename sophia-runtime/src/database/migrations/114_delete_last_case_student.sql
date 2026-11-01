-- A completed permanent deletion of the last case also removes its student.
-- Only explicit deletion receipts qualify; ordinary no-case students remain.
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.student_case_deletions ADD COLUMN student_deleted_at timestamptz;
DO $$ DECLARE fk text; BEGIN
  SELECT conname INTO STRICT fk FROM pg_constraint WHERE conrelid='__SOPHIA_RUNTIME_SCHEMA__.student_operations_student_audit_events'::regclass
    AND confrelid='__SOPHIA_RUNTIME_SCHEMA__.student_operations_students'::regclass AND contype='f';
  EXECUTE format('ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.student_operations_student_audit_events DROP CONSTRAINT %I',fk);
END $$;
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.student_operations_student_audit_events ADD CONSTRAINT student_audit_profile_fk
 FOREIGN KEY(student_id,customer_id) REFERENCES __SOPHIA_RUNTIME_SCHEMA__.student_operations_students(student_id,customer_id) ON DELETE CASCADE;
CREATE FUNCTION __SOPHIA_RUNTIME_SCHEMA__.protect_deleted_student_audit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' AND pg_trigger_depth()>1 AND NOT EXISTS(
    SELECT 1 FROM __SOPHIA_RUNTIME_SCHEMA__.student_operations_students WHERE customer_id=OLD.customer_id AND student_id=OLD.student_id
  ) THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'Student audit events are append-only';
END $$;
DROP TRIGGER protect_student_operations_student_audit_event ON __SOPHIA_RUNTIME_SCHEMA__.student_operations_student_audit_events;
CREATE TRIGGER protect_student_operations_student_audit_event BEFORE UPDATE OR DELETE ON __SOPHIA_RUNTIME_SCHEMA__.student_operations_student_audit_events
 FOR EACH ROW EXECUTE FUNCTION __SOPHIA_RUNTIME_SCHEMA__.protect_deleted_student_audit();

CREATE FUNCTION __SOPHIA_RUNTIME_SCHEMA__.purge_orphaned_case_student(target_case uuid) RETURNS boolean
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE tenant uuid:=NULLIF(current_setting('sophia.tenant_id',true),'')::uuid; job record; student record; fk record; joined text; referenced boolean; tab text;
BEGIN
  SELECT * INTO job FROM __SOPHIA_RUNTIME_SCHEMA__.student_case_deletions WHERE customer_id=tenant AND case_id=target_case AND status='completed' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Completed case deletion required' USING ERRCODE='42501'; END IF;
  IF job.student_deleted_at IS NOT NULL THEN RETURN true; END IF;
  SELECT p.student_id,l.user_id,l.company_id,l.student_reference INTO student
    FROM __SOPHIA_RUNTIME_SCHEMA__.student_operations_students p
    JOIN __SOPHIA_RUNTIME_SCHEMA__.student_operations_student_user_links l USING(customer_id,student_id)
    JOIN __SOPHIA_RUNTIME_SCHEMA__.customers c ON c.customer_id=p.customer_id AND c.external_company_id=l.company_id::text
    JOIN public.users u ON u.id=l.user_id AND u.company_id=l.company_id AND u.student_id=l.student_reference AND u.type='student'
    WHERE p.customer_id=tenant AND p.student_id=job.student_id FOR UPDATE OF p,u;
  IF NOT FOUND THEN RETURN false; END IF;
  IF EXISTS(SELECT 1 FROM __SOPHIA_RUNTIME_SCHEMA__.student_operations_cases WHERE customer_id=tenant AND student_id=student.student_id) THEN RETURN false; END IF;
  -- Do not delete an identity carrying unrelated financial obligations.
  IF EXISTS(SELECT 1 FROM __SOPHIA_RUNTIME_SCHEMA__.student_operations_xero_invoices WHERE customer_id=tenant AND student_id=student.student_reference
    AND (invoice_status NOT IN ('DELETED','VOIDED') OR amount_paid IS DISTINCT FROM 0::numeric)) THEN
    RAISE EXCEPTION 'Student has unresolved invoices outside the deleted case' USING ERRCODE='23503';
  END IF;
  IF to_regclass('__SOPHIA_RUNTIME_SCHEMA__.student_operations_xero_candidate_reviews') IS NOT NULL THEN
    DELETE FROM __SOPHIA_RUNTIME_SCHEMA__.student_operations_xero_candidate_reviews WHERE customer_id=tenant AND student_id=student.student_id;
  END IF;
  DELETE FROM __SOPHIA_RUNTIME_SCHEMA__.student_operations_document_contacts WHERE customer_id=tenant AND student_id=student.student_id;
  DELETE FROM __SOPHIA_RUNTIME_SCHEMA__.student_operations_primary_xero_contacts WHERE customer_id=tenant AND student_id=student.student_id;
  DELETE FROM __SOPHIA_RUNTIME_SCHEMA__.student_operations_write_requests WHERE customer_id=tenant AND
    (student_id=student.student_id OR response->>'studentId'=student.student_id::text OR response->>'userId'=student.user_id::text);
  DELETE FROM public.bm_xero_student_contact_links WHERE customer_id=tenant AND student_id=student.student_reference;
  IF to_regclass('public.bm_xero_student_sync_candidates') IS NOT NULL THEN
    EXECUTE 'DELETE FROM public.bm_xero_student_sync_candidates WHERE customer_id=$1 AND student_id=$2' USING tenant,student.student_reference;
  END IF;
  -- Retain immutable provider facts without an identity that could recreate the
  -- deleted user. The same policy is used by the administrator cleanup scripts.
  UPDATE __SOPHIA_RUNTIME_SCHEMA__.student_operations_xero_invoices SET student_id=NULL WHERE customer_id=tenant AND student_id=student.student_reference;
  DELETE FROM public.bm_xero_student_identities WHERE customer_id=tenant AND company_id=student.company_id AND student_id=student.student_reference;
  DELETE FROM __SOPHIA_RUNTIME_SCHEMA__.student_operations_student_user_links WHERE customer_id=tenant AND student_id=student.student_id;
  FOR fk IN SELECT c.conrelid,c.conkey,c.confkey FROM pg_constraint c WHERE c.contype='f' AND c.confrelid='__SOPHIA_RUNTIME_SCHEMA__.student_operations_students'::regclass LOOP
    IF fk.conrelid='__SOPHIA_RUNTIME_SCHEMA__.student_operations_student_audit_events'::regclass THEN CONTINUE; END IF;
    SELECT string_agg(format('child.%I=parent.%I',a.attname,b.attname),' AND ' ORDER BY k.n) INTO joined
      FROM unnest(fk.conkey,fk.confkey) WITH ORDINALITY k(child_key,parent_key,n)
      JOIN pg_attribute a ON a.attrelid=fk.conrelid AND a.attnum=k.child_key
      JOIN pg_attribute b ON b.attrelid='__SOPHIA_RUNTIME_SCHEMA__.student_operations_students'::regclass AND b.attnum=k.parent_key;
    EXECUTE format('SELECT EXISTS(SELECT 1 FROM %s child JOIN __SOPHIA_RUNTIME_SCHEMA__.student_operations_students parent ON %s WHERE parent.customer_id=$1 AND parent.student_id=$2)',fk.conrelid::regclass,joined)
      INTO referenced USING tenant,student.student_id;
    IF referenced THEN RAISE EXCEPTION 'Student has related records outside the deleted case' USING ERRCODE='23503'; END IF;
  END LOOP;
  DELETE FROM __SOPHIA_RUNTIME_SCHEMA__.student_operations_students WHERE customer_id=tenant AND student_id=student.student_id;
  -- Authentication children are owned by this account. Refuse any unexpected
  -- referencing business row, including CASCADE FKs, instead of deleting it.
  FOR fk IN SELECT c.oid,c.conrelid,c.conkey,c.confkey FROM pg_constraint c WHERE c.contype='f' AND c.confrelid='public.users'::regclass LOOP
    SELECT string_agg(format('child.%I=parent.%I',a.attname,b.attname),' AND ' ORDER BY k.n) INTO joined
      FROM unnest(fk.conkey,fk.confkey) WITH ORDINALITY k(child_key,parent_key,n)
      JOIN pg_attribute a ON a.attrelid=fk.conrelid AND a.attnum=k.child_key
      JOIN pg_attribute b ON b.attrelid='public.users'::regclass AND b.attnum=k.parent_key;
    EXECUTE format('SELECT EXISTS(SELECT 1 FROM %s child JOIN public.users parent ON %s WHERE parent.id=$1 AND parent.company_id=$2)',fk.conrelid::regclass,joined)
      INTO referenced USING student.user_id,student.company_id;
    IF referenced AND fk.conrelid::regclass::text NOT IN ('password_reset_tokens','user_mfa_factors','user_security_audit_events','public.password_reset_tokens','public.user_mfa_factors','public.user_security_audit_events') THEN
      RAISE EXCEPTION 'Student has related records outside the deleted case' USING ERRCODE='23503';
    END IF;
  END LOOP;
  FOREACH tab IN ARRAY ARRAY['password_reset_tokens','user_mfa_factors','user_security_audit_events'] LOOP
    IF to_regclass('public.'||tab) IS NOT NULL THEN EXECUTE format('DELETE FROM public.%I WHERE user_id=$1',tab) USING student.user_id; END IF;
  END LOOP;
  DELETE FROM public.users WHERE id=student.user_id AND company_id=student.company_id AND student_id=student.student_reference AND type='student';
  UPDATE __SOPHIA_RUNTIME_SCHEMA__.student_case_deletions SET student_deleted_at=now()
    WHERE customer_id=tenant AND student_id=student.student_id AND status='completed';
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION __SOPHIA_RUNTIME_SCHEMA__.purge_orphaned_case_student(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION __SOPHIA_RUNTIME_SCHEMA__.purge_orphaned_case_student(uuid) TO sophia_runtime_app;

-- Extend the existing tenant/token-checked graph purge without changing its
-- signature or allowing Runtime to call the intermediate case-only function.
ALTER FUNCTION __SOPHIA_RUNTIME_SCHEMA__.purge_deleted_student_case(uuid,uuid) RENAME TO purge_deleted_student_case_records;
REVOKE ALL ON FUNCTION __SOPHIA_RUNTIME_SCHEMA__.purge_deleted_student_case_records(uuid,uuid) FROM PUBLIC,sophia_runtime_app;
CREATE FUNCTION __SOPHIA_RUNTIME_SCHEMA__.purge_deleted_student_case(target_case uuid,token uuid) RETURNS void
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
BEGIN
  PERFORM __SOPHIA_RUNTIME_SCHEMA__.purge_deleted_student_case_records(target_case,token);
  PERFORM __SOPHIA_RUNTIME_SCHEMA__.purge_orphaned_case_student(target_case);
END $$;
REVOKE ALL ON FUNCTION __SOPHIA_RUNTIME_SCHEMA__.purge_deleted_student_case(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION __SOPHIA_RUNTIME_SCHEMA__.purge_deleted_student_case(uuid,uuid) TO sophia_runtime_app;

-- Repair only students left by earlier explicit permanent deletions. Do not
-- remove ordinary students who have never had a case or still have any case.
DO $$ DECLARE r record; previous_tenant text:=current_setting('sophia.tenant_id',true); BEGIN
  FOR r IN SELECT DISTINCT ON(d.customer_id,d.student_id) d.customer_id,d.case_id
    FROM __SOPHIA_RUNTIME_SCHEMA__.student_case_deletions d
    JOIN __SOPHIA_RUNTIME_SCHEMA__.student_operations_students p ON p.customer_id=d.customer_id AND p.student_id=d.student_id
    WHERE d.status='completed' AND NOT EXISTS(SELECT 1 FROM __SOPHIA_RUNTIME_SCHEMA__.student_operations_cases c WHERE c.customer_id=d.customer_id AND c.student_id=d.student_id)
    ORDER BY d.customer_id,d.student_id,d.completed_at DESC LOOP
    PERFORM set_config('sophia.tenant_id',r.customer_id::text,true);
    PERFORM __SOPHIA_RUNTIME_SCHEMA__.purge_orphaned_case_student(r.case_id);
  END LOOP;
  PERFORM set_config('sophia.tenant_id',coalesce(previous_tenant,''),true);
END $$;
