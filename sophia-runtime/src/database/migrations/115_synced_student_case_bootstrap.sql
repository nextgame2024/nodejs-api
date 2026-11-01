-- The recurring identity import must not stop after creating a login. Bootstrap
-- only students with verified receivable evidence and no case of any status.
CREATE FUNCTION __SOPHIA_RUNTIME_SCHEMA__.ensure_synced_student_case(reference text,actor text) RETURNS uuid
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE tenant uuid:=NULLIF(current_setting('sophia.tenant_id',true),'')::uuid; account record; profile uuid; created_case uuid;
  latest_advisor text; advisor_ids uuid[]; college_ids uuid[]; login_advisors uuid[]; first_date date; invoice_count integer;
BEGIN
  IF tenant IS NULL OR reference!~'^STD-[0-9]+$' OR nullif(btrim(actor),'') IS NULL OR length(actor)>240 THEN
    RAISE EXCEPTION 'Verified student import context required' USING ERRCODE='22023';
  END IF;
  SELECT u.id,u.company_id INTO account FROM public.users u
    JOIN __SOPHIA_RUNTIME_SCHEMA__.customers c ON c.customer_id=tenant AND c.external_company_id=u.company_id::text AND c.status='active'
    JOIN public.bm_company b ON b.company_id=u.company_id AND b.workspace_profile='student_operations'
    WHERE u.student_id=reference AND u.type='student' AND u.status='active' FOR UPDATE OF u;
  IF NOT FOUND THEN RAISE EXCEPTION 'Student account is not eligible for case import' USING ERRCODE='23514'; END IF;
  IF EXISTS(SELECT 1 FROM __SOPHIA_RUNTIME_SCHEMA__.student_operations_student_user_links l
    JOIN __SOPHIA_RUNTIME_SCHEMA__.student_operations_cases c USING(customer_id,student_id)
    WHERE l.customer_id=tenant AND l.user_id=account.id) THEN RETURN NULL; END IF;
  IF EXISTS(SELECT 1 FROM __SOPHIA_RUNTIME_SCHEMA__.student_operations_student_user_links l
    JOIN __SOPHIA_RUNTIME_SCHEMA__.student_case_deletions d USING(customer_id,student_id)
    WHERE l.customer_id=tenant AND l.user_id=account.id) THEN RETURN NULL; END IF;
  SELECT min(invoice_date),count(*) INTO first_date,invoice_count FROM __SOPHIA_RUNTIME_SCHEMA__.student_operations_xero_invoices
    WHERE customer_id=tenant AND student_id=reference AND invoice_type='ACCREC' AND invoice_status IN ('DRAFT','SUBMITTED','AUTHORISED','PAID');
  IF invoice_count=0 THEN RETURN NULL; END IF;
  -- Reuse the same identity conflict and company checks as normal case creation.
  profile:=__SOPHIA_RUNTIME_SCHEMA__.ensure_student_operations_profile(account.id);
  PERFORM 1 FROM __SOPHIA_RUNTIME_SCHEMA__.student_operations_students WHERE customer_id=tenant AND student_id=profile FOR UPDATE;
  IF EXISTS(SELECT 1 FROM __SOPHIA_RUNTIME_SCHEMA__.student_operations_cases WHERE customer_id=tenant AND student_id=profile) THEN RETURN NULL; END IF;
  SELECT nullif(btrim(advisor_name),'') INTO latest_advisor FROM __SOPHIA_RUNTIME_SCHEMA__.student_operations_xero_invoices
    WHERE customer_id=tenant AND student_id=reference AND invoice_type='ACCREC' AND invoice_status IN ('DRAFT','SUBMITTED','AUTHORISED','PAID')
    ORDER BY invoice_date DESC NULLS LAST,xero_invoice_id DESC,xero_connection_id DESC LIMIT 1;
  SELECT array_agg(advisor_id) INTO advisor_ids FROM __SOPHIA_RUNTIME_SCHEMA__.student_operations_advisor_directory
    WHERE customer_id=tenant AND status='active' AND lower(btrim(xero_label))=lower(latest_advisor);
  IF cardinality(advisor_ids)=1 THEN
    UPDATE __SOPHIA_RUNTIME_SCHEMA__.student_operations_students SET advisor_id=advisor_ids[1],record_version=record_version+1,updated_at=now()
      WHERE customer_id=tenant AND student_id=profile AND advisor_id IS DISTINCT FROM advisor_ids[1];
    IF FOUND THEN INSERT INTO __SOPHIA_RUNTIME_SCHEMA__.student_operations_student_audit_events
      (customer_id,student_id,actor_identity_user_id,event_type,record_version,changed_fields,correlation_id)
      SELECT tenant,profile,actor,'student.updated',record_version,ARRAY['advisor_id'],'synced-case-bootstrap'
      FROM __SOPHIA_RUNTIME_SCHEMA__.student_operations_students WHERE customer_id=tenant AND student_id=profile; END IF;
  END IF;
  INSERT INTO __SOPHIA_RUNTIME_SCHEMA__.student_operations_cases
    (customer_id,student_id,case_reference,case_kind,title,current_stage,lifecycle_status,opened_on,advisor_name,migration_key)
    VALUES(tenant,profile,'CASE-'||nextval('__SOPHIA_RUNTIME_SCHEMA__.student_operations_case_number_seq')::text,'student_operations',
      'Imported student case','imported_pending_review','open',coalesce(first_date,CURRENT_DATE),latest_advisor,'synced_students_v1') RETURNING case_id INTO created_case;
  INSERT INTO __SOPHIA_RUNTIME_SCHEMA__.student_operations_case_invoice_links
    (customer_id,case_id,student_id,student_reference,xero_connection_id,xero_invoice_id,linked_by_identity)
    SELECT tenant,created_case,profile,reference,xero_connection_id,xero_invoice_id,actor
      FROM __SOPHIA_RUNTIME_SCHEMA__.student_operations_xero_invoices WHERE customer_id=tenant AND student_id=reference
      AND invoice_type='ACCREC' AND invoice_status IN ('DRAFT','SUBMITTED','AUTHORISED','PAID');
  -- Use only one unambiguous exact college match across invoice references.
  SELECT array_agg(DISTINCT b.college_id) INTO college_ids FROM public.bm_colleges b
    JOIN __SOPHIA_RUNTIME_SCHEMA__.student_operations_xero_invoices i
      ON regexp_replace(lower(b.college_name),'[^a-z0-9]','','g')=regexp_replace(lower(coalesce(nullif(btrim(i.invoice_reference),''),i.college_name)),'[^a-z0-9]','','g')
    WHERE b.company_id=account.company_id AND b.status='active' AND i.customer_id=tenant AND i.student_id=reference
      AND i.invoice_type='ACCREC' AND i.invoice_status IN ('DRAFT','SUBMITTED','AUTHORISED','PAID');
  IF cardinality(college_ids)=1 THEN
    INSERT INTO __SOPHIA_RUNTIME_SCHEMA__.student_operations_colleges(customer_id,college_id,college_name)
      SELECT tenant,b.college_id,b.college_name FROM public.bm_colleges b WHERE b.company_id=account.company_id AND b.college_id=college_ids[1]
      ON CONFLICT(customer_id,college_id) DO UPDATE SET college_name=excluded.college_name;
    INSERT INTO __SOPHIA_RUNTIME_SCHEMA__.student_operations_case_colleges(customer_id,case_id,college_id,is_primary) VALUES(tenant,created_case,college_ids[1],true);
  END IF;
  SELECT array_agg(user_id) INTO login_advisors FROM __SOPHIA_RUNTIME_SCHEMA__.student_operations_advisor_roster
    WHERE customer_id=tenant AND lower(regexp_replace(btrim(display_name),'^[sScC][0-9]+[[:space:]]+',''))=lower(regexp_replace(latest_advisor,'^[sScC][0-9]+[[:space:]]+',''));
  IF cardinality(login_advisors)=1 THEN
    INSERT INTO __SOPHIA_RUNTIME_SCHEMA__.student_operations_case_advisors(customer_id,case_id,company_id,advisor_user_id,is_primary)
      VALUES(tenant,created_case,account.company_id,login_advisors[1],true);
  END IF;
  INSERT INTO __SOPHIA_RUNTIME_SCHEMA__.student_operations_document_jobs(customer_id,case_id,xero_connection_id,source_kind,source_id)
    SELECT DISTINCT tenant,created_case,i.xero_connection_id,source.kind,source.id
    FROM __SOPHIA_RUNTIME_SCHEMA__.student_operations_xero_invoices i
    CROSS JOIN LATERAL (VALUES('Invoices',i.xero_invoice_id),('Contacts',i.xero_contact_id)) source(kind,id)
    WHERE i.customer_id=tenant AND i.student_id=reference AND i.invoice_type='ACCREC' AND i.invoice_status IN ('DRAFT','SUBMITTED','AUTHORISED','PAID') ON CONFLICT DO NOTHING;
  INSERT INTO __SOPHIA_RUNTIME_SCHEMA__.student_operations_case_activity(customer_id,case_id,actor_identity_user_id,event_type,summary,detail)
    VALUES(tenant,created_case,actor,'case.imported','Synced student case created; workflow requires review',
      jsonb_build_object('source','student-user-sync','invoiceCount',invoice_count,'collegeNeedsReview',coalesce(cardinality(college_ids),0)<>1,'advisorNeedsReview',coalesce(cardinality(advisor_ids),0)<>1));
  RETURN created_case;
END $$;
REVOKE ALL ON FUNCTION __SOPHIA_RUNTIME_SCHEMA__.ensure_synced_student_case(text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION __SOPHIA_RUNTIME_SCHEMA__.ensure_synced_student_case(text,text) TO sophia_runtime_app;
