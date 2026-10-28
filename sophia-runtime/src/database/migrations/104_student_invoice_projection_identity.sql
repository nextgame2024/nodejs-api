-- Register only an existing case's authenticated tenant/company student identity.
-- Runtime never receives direct access to the shared identity table.
CREATE FUNCTION __SOPHIA_RUNTIME_SCHEMA__.ensure_case_xero_student_identity(requested_case uuid)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE
  tenant uuid := NULLIF(current_setting('sophia.tenant_id',true),'')::uuid;
  company uuid;
  reference text;
BEGIN
  SELECT l.company_id,l.student_reference INTO company,reference
    FROM __SOPHIA_RUNTIME_SCHEMA__.student_operations_cases c
    JOIN __SOPHIA_RUNTIME_SCHEMA__.student_operations_student_user_links l USING(customer_id,student_id)
    JOIN __SOPHIA_RUNTIME_SCHEMA__.customers t ON t.customer_id=c.customer_id AND t.status='active' AND t.external_company_id=l.company_id::text
    JOIN public.bm_company b ON b.company_id=l.company_id AND b.workspace_profile='student_operations'
    JOIN public.users u ON u.id=l.user_id AND u.company_id=l.company_id AND u.student_id=l.student_reference AND u.type='student' AND u.status='active'
    WHERE c.customer_id=tenant AND c.case_id=requested_case;
  IF reference IS NULL OR (SELECT count(*) FROM __SOPHIA_RUNTIME_SCHEMA__.customers t WHERE t.status='active' AND t.external_company_id=company::text)<>1 THEN
    RAISE EXCEPTION 'Student identity mapping is unavailable';
  END IF;
  INSERT INTO public.bm_xero_student_identities(customer_id,company_id,student_id)
    VALUES(tenant,company,reference) ON CONFLICT(customer_id,student_id) DO NOTHING;
  IF NOT EXISTS(SELECT 1 FROM public.bm_xero_student_identities i WHERE i.customer_id=tenant AND i.student_id=reference AND i.company_id=company) THEN
    RAISE EXCEPTION 'Student identity mapping conflict';
  END IF;
  RETURN reference;
END;
$$;
REVOKE ALL ON FUNCTION __SOPHIA_RUNTIME_SCHEMA__.ensure_case_xero_student_identity(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION __SOPHIA_RUNTIME_SCHEMA__.ensure_case_xero_student_identity(uuid) TO sophia_runtime_app;

-- Creation receipts survive projection failures. A bounded worker can replay
-- verified data locally, or read the exact existing invoice for older receipts.
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.student_case_xero_invoice_exports
  ADD COLUMN verified_invoice jsonb,
  ADD COLUMN projection_attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN projection_next_attempt_at timestamptz DEFAULT now();
CREATE INDEX student_invoice_projection_due ON __SOPHIA_RUNTIME_SCHEMA__.student_case_xero_invoice_exports(customer_id,projection_next_attempt_at)
  WHERE status='created' AND projection_next_attempt_at IS NOT NULL;
