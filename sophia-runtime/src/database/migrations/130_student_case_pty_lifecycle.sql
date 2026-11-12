-- Remove dependent PTY records before their TRUST receipts. No new DELETE grants.
CREATE OR REPLACE FUNCTION __SOPHIA_RUNTIME_SCHEMA__.purge_deleted_student_case_records(target_case uuid,token uuid) RETURNS void
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE tenant uuid:=NULLIF(current_setting('sophia.tenant_id',true),'')::uuid; job record; tab text;
BEGIN
  SELECT * INTO job FROM __SOPHIA_RUNTIME_SCHEMA__.student_case_deletions
    WHERE customer_id=tenant AND case_id=target_case AND status='provider_done' AND lease_token=token AND lease_expires_at>now() FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Confirmed case deletion required' USING ERRCODE='42501'; END IF;
  PERFORM 1 FROM __SOPHIA_RUNTIME_SCHEMA__.student_operations_cases
    WHERE customer_id=tenant AND case_id=target_case AND deleting_at IS NOT NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Case deletion scope changed'; END IF;
  DELETE FROM __SOPHIA_RUNTIME_SCHEMA__.student_commission_exports WHERE customer_id=tenant AND case_id=target_case;
  DELETE FROM __SOPHIA_RUNTIME_SCHEMA__.student_commission_drafts WHERE customer_id=tenant AND case_id=target_case;
  DELETE FROM __SOPHIA_RUNTIME_SCHEMA__.student_case_xero_invoice_exports WHERE customer_id=tenant AND case_id=target_case;
  DELETE FROM __SOPHIA_RUNTIME_SCHEMA__.student_case_invoice_draft_batches WHERE customer_id=tenant AND case_id=target_case;
  FOREACH tab IN ARRAY ARRAY['student_case_offer_fees','student_case_offer_instalments','student_case_offer_courses'] LOOP
    EXECUTE format('DELETE FROM __SOPHIA_RUNTIME_SCHEMA__.%I WHERE customer_id=$1 AND offer_id IN (SELECT offer_id FROM __SOPHIA_RUNTIME_SCHEMA__.student_case_offers WHERE customer_id=$1 AND case_id=$2)',tab) USING tenant,target_case;
  END LOOP;
  FOREACH tab IN ARRAY ARRAY['student_case_offers','student_document_reviews','student_document_analysis_results','student_document_analysis_jobs',
    'student_document_checklist_evaluations','student_operations_document_replacements','student_operations_document_deletions','student_operations_document_uploads',
    'student_operations_document_jobs','student_operations_case_documents','student_operations_case_payment_schedule','student_operations_case_invoice_links',
    'student_case_invoice_edits','student_case_invoice_removals','student_operations_case_advisors','student_operations_case_colleges','student_operations_case_checklist'] LOOP
    EXECUTE format('DELETE FROM __SOPHIA_RUNTIME_SCHEMA__.%I WHERE customer_id=$1 AND case_id=$2',tab) USING tenant,target_case;
  END LOOP;
  DELETE FROM __SOPHIA_RUNTIME_SCHEMA__.student_operations_write_requests WHERE customer_id=tenant AND response->>'caseId'=target_case::text;
  DELETE FROM __SOPHIA_RUNTIME_SCHEMA__.student_operations_cases WHERE customer_id=tenant AND case_id=target_case;
  UPDATE __SOPHIA_RUNTIME_SCHEMA__.student_case_deletions SET status='completed',targets='{}',lease_token=NULL,lease_expires_at=NULL,completed_at=now()
    WHERE customer_id=tenant AND case_id=target_case;
END $$;
