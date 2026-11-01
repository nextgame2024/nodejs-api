-- Permanent case deletion is a durable saga. The small receipt survives purge
-- so a lost HTTP response can be retried without recreating provider writes.
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.student_operations_cases ADD COLUMN deleting_at timestamptz;
CREATE INDEX student_case_archive_order ON __SOPHIA_RUNTIME_SCHEMA__.student_operations_cases(customer_id,student_id,(archived_at IS NOT NULL),created_at DESC,case_id);
CREATE TABLE __SOPHIA_RUNTIME_SCHEMA__.student_case_deletions (
  customer_id uuid NOT NULL,
  case_id uuid NOT NULL,
  student_id uuid NOT NULL,
  actor_identity_user_id text NOT NULL,
  idempotency_key text NOT NULL,
  record_version integer NOT NULL,
  status text NOT NULL DEFAULT 'processing' CHECK(status IN ('processing','provider_done','completed')),
  targets jsonb NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(targets)='object'),
  lease_token uuid,
  lease_expires_at timestamptz,
  completed_at timestamptz,
  PRIMARY KEY(customer_id,case_id),
  UNIQUE(customer_id,actor_identity_user_id,idempotency_key),
  CHECK((lease_token IS NULL)=(lease_expires_at IS NULL))
);
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.student_case_deletions ENABLE ROW LEVEL SECURITY;
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.student_case_deletions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON __SOPHIA_RUNTIME_SCHEMA__.student_case_deletions
 USING(customer_id=NULLIF(current_setting('sophia.tenant_id',true),'')::uuid)
 WITH CHECK(customer_id=NULLIF(current_setting('sophia.tenant_id',true),'')::uuid);
REVOKE ALL ON __SOPHIA_RUNTIME_SCHEMA__.student_case_deletions FROM PUBLIC;
GRANT SELECT,INSERT,UPDATE ON __SOPHIA_RUNTIME_SCHEMA__.student_case_deletions TO sophia_runtime_app;
-- The application still cannot delete audit rows directly. Allow only the FK
-- cascade from the narrowly authorized purge below; ordinary audit is immutable.
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.student_operations_case_activity
 DROP CONSTRAINT student_operations_case_activity_customer_id_case_id_fkey,
 ADD CONSTRAINT student_operations_case_activity_customer_id_case_id_fkey
 FOREIGN KEY(customer_id,case_id) REFERENCES __SOPHIA_RUNTIME_SCHEMA__.student_operations_cases(customer_id,case_id) ON DELETE CASCADE;
CREATE FUNCTION __SOPHIA_RUNTIME_SCHEMA__.protect_case_activity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' AND pg_trigger_depth()>1 AND NOT EXISTS(
    SELECT 1 FROM __SOPHIA_RUNTIME_SCHEMA__.student_operations_cases WHERE customer_id=OLD.customer_id AND case_id=OLD.case_id
  ) THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'Case activity is append-only';
END $$;
DROP TRIGGER student_operations_case_activity_append_only ON __SOPHIA_RUNTIME_SCHEMA__.student_operations_case_activity;
CREATE TRIGGER student_operations_case_activity_append_only BEFORE UPDATE OR DELETE ON __SOPHIA_RUNTIME_SCHEMA__.student_operations_case_activity
 FOR EACH ROW EXECUTE FUNCTION __SOPHIA_RUNTIME_SCHEMA__.protect_case_activity();

-- No table DELETE grants, global trigger disabling or RLS bypass for Runtime.
-- Explicit tenant predicates remain mandatory inside this owner function.
CREATE FUNCTION __SOPHIA_RUNTIME_SCHEMA__.purge_deleted_student_case(target_case uuid,token uuid) RETURNS void
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE tenant uuid:=NULLIF(current_setting('sophia.tenant_id',true),'')::uuid; job record; tab text;
BEGIN
  SELECT * INTO job FROM __SOPHIA_RUNTIME_SCHEMA__.student_case_deletions
    WHERE customer_id=tenant AND case_id=target_case AND status='provider_done' AND lease_token=token AND lease_expires_at>now() FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Confirmed case deletion required' USING ERRCODE='42501'; END IF;
  PERFORM 1 FROM __SOPHIA_RUNTIME_SCHEMA__.student_operations_cases
    WHERE customer_id=tenant AND case_id=target_case AND deleting_at IS NOT NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Case deletion scope changed'; END IF;
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
REVOKE ALL ON FUNCTION __SOPHIA_RUNTIME_SCHEMA__.purge_deleted_student_case(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION __SOPHIA_RUNTIME_SCHEMA__.purge_deleted_student_case(uuid,uuid) TO sophia_runtime_app;
