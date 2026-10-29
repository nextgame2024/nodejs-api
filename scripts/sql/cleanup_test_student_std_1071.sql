-- ONE-OFF ADMINISTRATOR MAINTENANCE: STD-1071 / CASE-1070 ONLY.
-- Not an application migration. Do not run from an application connection.
-- 1. Take a restorable database backup / branch first.
--    Let the normal Xero sync confirm INV-10587 through INV-10594 as
--    DELETED/VOIDED and the TEST2 contact as ARCHIVED before pausing writers.
--    Xero UI changes alone do not update Sophia caches; never bypass this guard.
-- 2. Pause Runtime API, shared workers and legacy student-sync cron writers.
-- 3. Run this ENTIRE file unchanged for a read-only-data preview (ROLLBACK).
-- 4. Review the counts and warnings. To permanently apply, change BOTH:
--      apply_cleanup below to true AND the final ROLLBACK to COMMIT.
--    Run the ENTIRE file again. With psql use -v ON_ERROR_STOP=1.
-- 5. Resume services, refresh the browser and use a new student/case ID.
--
-- Irreversible after COMMIT without a backup: deletes this synthetic student's
-- account, case, documents/analysis/offers/drafts/receipts, scoped idempotency
-- entries and TEST-ONLY audit history. The two append-only audit triggers are
-- suspended by name under exclusive transaction locks, then restored BEFORE
-- commit. No grants, RLS policies or session_replication_role are changed.
-- Shared colleges/advisors/types/settings/sync runs and all ID counters stay.
-- Xero's archived contact and DELETED/VOIDED invoice cache rows stay unlinked:
-- ordinary provider sync may reimport that history, but not this test account.
-- No Xero calls or external attachment/file deletion are performed.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SET LOCAL idle_in_transaction_session_timeout = '120s';
SELECT set_config('sophia.tenant_id','33ed40a6-7f2b-407c-aab2-de76b1cb45a8',true);

CREATE TEMP TABLE cleanup_target ON COMMIT DROP AS SELECT
  false AS apply_cleanup, -- CHANGE TO true ONLY AFTER REVIEWING THE PREVIEW.
  '33ed40a6-7f2b-407c-aab2-de76b1cb45a8'::uuid AS tenant_id,
  '80d5e42f-2de1-4792-86b5-54c7cdeb2660'::uuid AS company_id,
  '7af793a7-87e9-4241-b0c1-d0bd0bee6687'::uuid AS student_id,
  'cb56429a-f3cd-4242-bb27-825efbabd043'::uuid AS user_id,
  '971f2c76-1d45-4abc-bfff-52bb371f6ba4'::uuid AS case_id,
  'a10fef7f-8451-42aa-94b9-6238d1929470'::uuid AS connection_id,
  '10e416b4-f822-451f-9255-9be7ac9810a8'::uuid AS contact_id,
  'STD-1071'::text AS student_reference,
  'CASE-1070'::text AS case_reference,
  'TEST2 - Student'::text AS student_name,
  'test2@student.com'::text AS student_email;

-- Predicates refer to alias r and trusted constants/temp tables only. No
-- untrusted input or recursive deletion/cascade expansion is accepted.
CREATE TEMP TABLE cleanup_plan (
  position integer PRIMARY KEY, relation_name text UNIQUE NOT NULL,
  predicate text NOT NULL, preview_rows bigint, affected_rows bigint,
  operation text NOT NULL DEFAULT 'DELETE' CHECK(operation IN ('DELETE','UNLINK'))
) ON COMMIT DROP;
INSERT INTO cleanup_plan(position,relation_name,predicate) VALUES
 (10,'sophia_runtime.student_case_xero_invoice_exports','r.customer_id=(SELECT tenant_id FROM cleanup_target) AND r.case_id=(SELECT case_id FROM cleanup_target)'),
 (20,'sophia_runtime.student_case_invoice_draft_batches','r.customer_id=(SELECT tenant_id FROM cleanup_target) AND r.case_id=(SELECT case_id FROM cleanup_target)'),
 (30,'sophia_runtime.student_case_offer_fees','r.customer_id=(SELECT tenant_id FROM cleanup_target) AND r.offer_id IN (SELECT offer_id FROM cleanup_offers)'),
 (40,'sophia_runtime.student_case_offer_instalments','r.customer_id=(SELECT tenant_id FROM cleanup_target) AND r.offer_id IN (SELECT offer_id FROM cleanup_offers)'),
 (50,'sophia_runtime.student_case_offer_courses','r.customer_id=(SELECT tenant_id FROM cleanup_target) AND r.offer_id IN (SELECT offer_id FROM cleanup_offers)'),
 (60,'sophia_runtime.student_case_offers','r.customer_id=(SELECT tenant_id FROM cleanup_target) AND r.case_id=(SELECT case_id FROM cleanup_target)'),
 (70,'sophia_runtime.student_document_reviews','r.customer_id=(SELECT tenant_id FROM cleanup_target) AND r.case_id=(SELECT case_id FROM cleanup_target)'),
 (80,'sophia_runtime.student_document_analysis_results','r.customer_id=(SELECT tenant_id FROM cleanup_target) AND r.case_id=(SELECT case_id FROM cleanup_target)'),
 (90,'sophia_runtime.student_document_analysis_jobs','r.customer_id=(SELECT tenant_id FROM cleanup_target) AND r.case_id=(SELECT case_id FROM cleanup_target)'),
 (100,'sophia_runtime.student_document_checklist_evaluations','r.customer_id=(SELECT tenant_id FROM cleanup_target) AND r.case_id=(SELECT case_id FROM cleanup_target)'),
 (110,'sophia_runtime.student_operations_document_uploads','r.customer_id=(SELECT tenant_id FROM cleanup_target) AND r.case_id=(SELECT case_id FROM cleanup_target)'),
 (120,'sophia_runtime.student_operations_document_jobs','r.customer_id=(SELECT tenant_id FROM cleanup_target) AND r.case_id=(SELECT case_id FROM cleanup_target)'),
 (130,'sophia_runtime.student_operations_case_documents','r.customer_id=(SELECT tenant_id FROM cleanup_target) AND r.case_id=(SELECT case_id FROM cleanup_target)'),
 (140,'sophia_runtime.student_operations_document_sources','r.customer_id=(SELECT tenant_id FROM cleanup_target) AND r.xero_connection_id=(SELECT connection_id FROM cleanup_target) AND r.source_id IN (SELECT source_id FROM cleanup_sources)'),
 (150,'sophia_runtime.student_operations_case_payment_schedule','r.customer_id=(SELECT tenant_id FROM cleanup_target) AND r.case_id=(SELECT case_id FROM cleanup_target)'),
 (160,'sophia_runtime.student_operations_case_invoice_links','r.customer_id=(SELECT tenant_id FROM cleanup_target) AND r.case_id=(SELECT case_id FROM cleanup_target)'),
 (170,'sophia_runtime.student_operations_case_advisors','r.customer_id=(SELECT tenant_id FROM cleanup_target) AND r.case_id=(SELECT case_id FROM cleanup_target)'),
 (180,'sophia_runtime.student_operations_case_colleges','r.customer_id=(SELECT tenant_id FROM cleanup_target) AND r.case_id=(SELECT case_id FROM cleanup_target)'),
 (190,'sophia_runtime.student_operations_case_checklist','r.customer_id=(SELECT tenant_id FROM cleanup_target) AND r.case_id=(SELECT case_id FROM cleanup_target)'),
 (200,'sophia_runtime.student_operations_case_activity','r.customer_id=(SELECT tenant_id FROM cleanup_target) AND r.case_id=(SELECT case_id FROM cleanup_target)'),
 (210,'sophia_runtime.student_operations_cases','r.customer_id=(SELECT tenant_id FROM cleanup_target) AND r.case_id=(SELECT case_id FROM cleanup_target)'),
 (220,'sophia_runtime.student_operations_document_contacts','r.customer_id=(SELECT tenant_id FROM cleanup_target) AND r.student_id=(SELECT student_id FROM cleanup_target)'),
 (230,'sophia_runtime.student_operations_primary_xero_contacts','r.customer_id=(SELECT tenant_id FROM cleanup_target) AND r.student_id=(SELECT student_id FROM cleanup_target)'),
 (240,'sophia_runtime.student_operations_xero_candidate_reviews','r.customer_id=(SELECT tenant_id FROM cleanup_target) AND r.student_id=(SELECT student_id FROM cleanup_target)'),
 (250,'sophia_runtime.student_operations_write_requests','r.customer_id=(SELECT tenant_id FROM cleanup_target) AND (r.student_id=(SELECT student_id FROM cleanup_target) OR EXISTS(SELECT 1 FROM jsonb_each_text(coalesce(r.response,''{}''::jsonb)) entry WHERE entry.key IN (''caseId'',''studentId'',''batchId'',''documentId'',''jobId'',''resultId'',''offerId'') AND entry.value IN (SELECT record_id FROM cleanup_record_ids)))'),
 (260,'sophia_runtime.student_operations_student_audit_events','r.customer_id=(SELECT tenant_id FROM cleanup_target) AND r.student_id=(SELECT student_id FROM cleanup_target)'),
 (270,'sophia_runtime.student_operations_student_user_links','r.customer_id=(SELECT tenant_id FROM cleanup_target) AND r.student_id=(SELECT student_id FROM cleanup_target)'),
 (280,'sophia_runtime.student_operations_students','r.customer_id=(SELECT tenant_id FROM cleanup_target) AND r.student_id=(SELECT student_id FROM cleanup_target)'),
 (290,'public.bm_xero_student_contact_links','r.customer_id=(SELECT tenant_id FROM cleanup_target) AND r.student_id=(SELECT student_reference FROM cleanup_target)'),
 (300,'public.bm_xero_student_sync_candidates','r.customer_id=(SELECT tenant_id FROM cleanup_target) AND (r.student_id=(SELECT student_reference FROM cleanup_target) OR (r.connection_id=(SELECT connection_id FROM cleanup_target) AND cardinality(r.contact_ids)>0 AND r.contact_ids <@ ARRAY[(SELECT contact_id FROM cleanup_target)]))'),
 (305,'sophia_runtime.student_operations_xero_invoices','r.customer_id=(SELECT tenant_id FROM cleanup_target) AND r.xero_connection_id=(SELECT connection_id FROM cleanup_target) AND r.xero_invoice_id IN (SELECT xero_invoice_id FROM cleanup_invoices)'),
 (310,'public.bm_xero_student_identities','r.customer_id=(SELECT tenant_id FROM cleanup_target) AND r.company_id=(SELECT company_id FROM cleanup_target) AND r.student_id=(SELECT student_reference FROM cleanup_target)'),
 (400,'public.users','r.id=(SELECT user_id FROM cleanup_target) AND r.company_id=(SELECT company_id FROM cleanup_target)');
UPDATE cleanup_plan SET operation='UNLINK' WHERE position=305;

-- Own authentication records may be cascade children of the synthetic account.
-- Every other unexpected referencing row (including unrelated projects or
-- ownership of a company) causes a refusal, not cascading deletion/nulling.
DO $$ DECLARE tab text; n integer:=320; BEGIN
  FOREACH tab IN ARRAY ARRAY['password_reset_tokens','user_mfa_factors','user_security_audit_events'] LOOP
    IF to_regclass('public.'||tab) IS NOT NULL THEN
      INSERT INTO cleanup_plan(position,relation_name,predicate) VALUES(n,'public.'||tab,'r.user_id=(SELECT user_id FROM cleanup_target)'); n:=n+10;
    END IF;
  END LOOP;
END $$;

CREATE TEMP TABLE cleanup_offers ON COMMIT DROP AS SELECT offer_id FROM sophia_runtime.student_case_offers
 WHERE customer_id=(SELECT tenant_id FROM cleanup_target) AND case_id=(SELECT case_id FROM cleanup_target);
CREATE TEMP TABLE cleanup_batches ON COMMIT DROP AS SELECT batch_id FROM sophia_runtime.student_case_invoice_draft_batches
 WHERE customer_id=(SELECT tenant_id FROM cleanup_target) AND case_id=(SELECT case_id FROM cleanup_target);
CREATE TEMP TABLE cleanup_invoices ON COMMIT DROP AS SELECT xero_invoice_id,sequence,xero_invoice_number FROM sophia_runtime.student_case_xero_invoice_exports
 WHERE customer_id=(SELECT tenant_id FROM cleanup_target) AND case_id=(SELECT case_id FROM cleanup_target);
CREATE TEMP TABLE cleanup_sources ON COMMIT DROP AS SELECT contact_id AS source_id FROM cleanup_target
 UNION SELECT xero_invoice_id FROM cleanup_invoices;
CREATE TEMP TABLE cleanup_record_ids ON COMMIT DROP AS SELECT case_id::text AS record_id FROM cleanup_target
 UNION SELECT student_id::text FROM cleanup_target UNION SELECT batch_id::text FROM cleanup_batches
 UNION SELECT offer_id::text FROM cleanup_offers
 UNION SELECT document_id::text FROM sophia_runtime.student_operations_case_documents WHERE customer_id=(SELECT tenant_id FROM cleanup_target) AND case_id=(SELECT case_id FROM cleanup_target)
 UNION SELECT job_id::text FROM sophia_runtime.student_document_analysis_jobs WHERE customer_id=(SELECT tenant_id FROM cleanup_target) AND case_id=(SELECT case_id FROM cleanup_target)
 UNION SELECT result_id::text FROM sophia_runtime.student_document_analysis_results WHERE customer_id=(SELECT tenant_id FROM cleanup_target) AND case_id=(SELECT case_id FROM cleanup_target);

CREATE OR REPLACE FUNCTION pg_temp.cleanup_preflight() RETURNS void LANGUAGE plpgsql AS $preflight$
DECLARE t record; p record; f record; n bigint; join_sql text; outside_scope boolean;
BEGIN
  SELECT * INTO STRICT t FROM cleanup_target;
  IF current_user='sophia_runtime_app' THEN RAISE EXCEPTION 'Use a separately approved administrator maintenance connection; do not change application grants.'; END IF;
  IF (SELECT count(*) FROM sophia_runtime.customers WHERE customer_id=t.tenant_id AND external_company_id=t.company_id::text)<>1
    OR (SELECT count(*) FROM public.users WHERE id=t.user_id AND company_id=t.company_id AND student_id=t.student_reference AND type::text='student' AND name=t.student_name AND lower(email)=t.student_email)<>1
    OR (SELECT count(*) FROM sophia_runtime.student_operations_students WHERE customer_id=t.tenant_id AND student_id=t.student_id AND legal_name=t.student_name AND lower(email)=t.student_email)<>1
    OR (SELECT count(*) FROM sophia_runtime.student_operations_student_user_links WHERE customer_id=t.tenant_id AND student_id=t.student_id AND user_id=t.user_id AND company_id=t.company_id AND student_reference=t.student_reference)<>1
    OR (SELECT count(*) FROM sophia_runtime.student_operations_cases WHERE customer_id=t.tenant_id AND student_id=t.student_id)<>1
    OR (SELECT count(*) FROM sophia_runtime.student_operations_cases WHERE customer_id=t.tenant_id AND case_id=t.case_id AND student_id=t.student_id AND case_reference=t.case_reference)<>1
  THEN RAISE EXCEPTION 'Target identity/case changed, is missing, or has extra cases. Nothing may be deleted.'; END IF;
  IF (SELECT count(*) FROM cleanup_invoices)<>8 OR (SELECT count(DISTINCT xero_invoice_id) FROM cleanup_invoices)<>8
    OR EXISTS(SELECT 1 FROM cleanup_invoices WHERE sequence NOT BETWEEN 1 AND 8 OR xero_invoice_number IS DISTINCT FROM 'INV-'||(10586+sequence)::text)
    OR (SELECT count(DISTINCT sequence) FROM cleanup_invoices)<>8
    OR EXISTS(SELECT 1 FROM sophia_runtime.student_case_xero_invoice_exports WHERE customer_id=t.tenant_id AND case_id=t.case_id AND (status<>'created' OR xero_connection_id<>t.connection_id OR xero_contact_id<>t.contact_id))
  THEN RAISE EXCEPTION 'Expected exactly INV-10587 through INV-10594 with confirmed receipts for the test contact.'; END IF;
  IF (SELECT count(*) FROM sophia_runtime.student_operations_xero_invoices WHERE customer_id=t.tenant_id AND xero_connection_id=t.connection_id AND xero_invoice_id IN (SELECT xero_invoice_id FROM cleanup_invoices) AND xero_contact_id=t.contact_id AND invoice_status IN ('DELETED','VOIDED') AND amount_paid=0 AND (student_id IS NULL OR student_id=t.student_reference))<>8
    OR (SELECT count(*) FROM sophia_runtime.student_operations_xero_contacts WHERE customer_id=t.tenant_id AND xero_connection_id=t.connection_id AND xero_contact_id=t.contact_id AND contact_status='ARCHIVED')<>1
  THEN RAISE EXCEPTION 'Sync must first confirm all eight invoices deleted/voided, no payments, and the contact archived.'; END IF;
  IF EXISTS(SELECT 1 FROM sophia_runtime.student_operations_xero_invoices WHERE customer_id=t.tenant_id AND student_id=t.student_reference AND (xero_connection_id<>t.connection_id OR xero_invoice_id NOT IN (SELECT xero_invoice_id FROM cleanup_invoices)))
    OR EXISTS(SELECT 1 FROM public.bm_xero_student_sync_candidates WHERE customer_id=t.tenant_id AND connection_id=t.connection_id AND t.contact_id=ANY(contact_ids) AND (NOT contact_ids <@ ARRAY[t.contact_id] OR student_id IS NOT NULL AND student_id<>t.student_reference))
    OR EXISTS(SELECT 1 FROM sophia_runtime.student_operations_primary_xero_contacts WHERE customer_id=t.tenant_id AND student_id=t.student_id AND (xero_connection_id<>t.connection_id OR xero_contact_id IS DISTINCT FROM t.contact_id))
    OR EXISTS(SELECT 1 FROM sophia_runtime.student_operations_primary_xero_contacts WHERE customer_id=t.tenant_id AND xero_connection_id=t.connection_id AND xero_contact_id=t.contact_id AND student_id<>t.student_id)
    OR EXISTS(SELECT 1 FROM sophia_runtime.student_operations_document_contacts WHERE customer_id=t.tenant_id AND student_id=t.student_id AND (xero_connection_id<>t.connection_id OR xero_contact_id IS DISTINCT FROM t.contact_id))
    OR EXISTS(SELECT 1 FROM sophia_runtime.student_operations_document_contacts WHERE customer_id=t.tenant_id AND xero_connection_id=t.connection_id AND xero_contact_id=t.contact_id AND student_id<>t.student_id)
    OR EXISTS(SELECT 1 FROM public.bm_xero_student_contact_links WHERE customer_id=t.tenant_id AND connection_id=t.connection_id AND contact_id=t.contact_id AND student_id<>t.student_reference)
    OR EXISTS(SELECT 1 FROM sophia_runtime.student_operations_case_invoice_links WHERE customer_id=t.tenant_id AND xero_connection_id=t.connection_id AND xero_invoice_id IN (SELECT xero_invoice_id FROM cleanup_invoices) AND case_id<>t.case_id)
    OR EXISTS(SELECT 1 FROM sophia_runtime.student_operations_document_jobs WHERE customer_id=t.tenant_id AND xero_connection_id=t.connection_id AND source_id IN (SELECT source_id FROM cleanup_sources) AND case_id<>t.case_id)
    OR EXISTS(SELECT 1 FROM sophia_runtime.student_operations_case_documents WHERE customer_id=t.tenant_id AND xero_connection_id=t.connection_id AND source_id IN (SELECT source_id FROM cleanup_sources) AND case_id<>t.case_id)
  THEN RAISE EXCEPTION 'Unexpected extra/shared invoice or document contact/source. Review before cleanup.'; END IF;
  IF EXISTS(SELECT 1 FROM sophia_runtime.student_operations_xero_sync_runs WHERE customer_id=t.tenant_id AND xero_connection_id=t.connection_id AND status IN ('queued','processing'))
    OR EXISTS(SELECT 1 FROM sophia_runtime.student_document_analysis_jobs WHERE customer_id=t.tenant_id AND case_id=t.case_id AND status='processing')
    OR EXISTS(SELECT 1 FROM sophia_runtime.student_operations_document_uploads WHERE customer_id=t.tenant_id AND case_id=t.case_id AND status='uploading')
  THEN RAISE EXCEPTION 'A relevant job is active/queued. Pause writers and wait for completion first.'; END IF;
  FOR p IN SELECT * FROM cleanup_plan ORDER BY position LOOP
    IF to_regclass(p.relation_name) IS NULL THEN RAISE EXCEPTION 'Required table missing: %',p.relation_name; END IF;
    IF NOT has_table_privilege(current_user,p.relation_name,CASE WHEN p.operation='UNLINK' THEN 'UPDATE' ELSE 'DELETE' END) THEN RAISE EXCEPTION 'Administrator lacks required write access on %. No permissions are changed by this script.',p.relation_name; END IF;
    EXECUTE format('SELECT count(*) FROM %s r WHERE %s',p.relation_name,p.predicate) INTO n;
    IF p.preview_rows IS NOT NULL AND p.preview_rows<>n THEN RAISE EXCEPTION 'Scope changed since preview for %. Rerun after pausing writers.',p.relation_name; END IF;
    UPDATE cleanup_plan SET preview_rows=n WHERE position=p.position;
    -- Detect FK children not in the plan, including ON DELETE CASCADE/SET NULL.
    FOR f IN SELECT conrelid::regclass AS child,conkey,confkey FROM pg_constraint WHERE contype='f' AND confrelid=to_regclass(p.relation_name) LOOP
      SELECT string_agg(format('ch.%I=r.%I',a.attname,b.attname),' AND ' ORDER BY k.ord) INTO join_sql
        FROM unnest(f.conkey,f.confkey) WITH ORDINALITY k(child_key,parent_key,ord)
        JOIN pg_attribute a ON a.attrelid=f.child AND a.attnum=k.child_key
        JOIN pg_attribute b ON b.attrelid=to_regclass(p.relation_name) AND b.attnum=k.parent_key;
      EXECUTE format('SELECT EXISTS(SELECT 1 FROM %s ch JOIN %s r ON %s WHERE (%s) AND NOT (%s))',f.child,p.relation_name,join_sql,p.predicate,
        coalesce((SELECT replace(predicate,'r.','ch.') FROM cleanup_plan WHERE to_regclass(relation_name)=f.child),'false')) INTO outside_scope;
      IF outside_scope THEN RAISE EXCEPTION 'Unplanned referencing row in % for %. Nothing may cascade outside the plan.',f.child,p.relation_name; END IF;
    END LOOP;
  END LOOP;
  IF (SELECT count(*) FROM pg_trigger WHERE (tgrelid='sophia_runtime.student_operations_case_activity'::regclass AND tgname='student_operations_case_activity_append_only'
      OR tgrelid='sophia_runtime.student_operations_student_audit_events'::regclass AND tgname='protect_student_operations_student_audit_event') AND tgenabled='O')<>2
  THEN RAISE EXCEPTION 'Expected audit protections are missing or not enabled. Refusing cleanup.'; END IF;
END $preflight$;
SELECT pg_temp.cleanup_preflight();

SELECT operation,relation_name,preview_rows FROM cleanup_plan ORDER BY position;
SELECT 'KEEP: shared settings/counters, sync history, archived Xero contact and deleted/voided invoice mirrors. DELETE: only the scoped synthetic test history, including its audit events.' AS review_notice;

DO $apply$
DECLARE p record; n bigint;
BEGIN
  IF NOT (SELECT apply_cleanup FROM cleanup_target) THEN RAISE NOTICE 'PREVIEW ONLY. No persistent data changed. Final ROLLBACK remains mandatory until explicitly applying.'; RETURN; END IF;
  -- A DBA maintenance operation, never a runtime privilege escalation. These
  -- transaction locks fence all writes to the exact tables while audit triggers
  -- are suspended. Failure or ROLLBACK restores both triggers and all data.
  FOR p IN SELECT * FROM cleanup_plan ORDER BY relation_name LOOP
    EXECUTE format('LOCK TABLE %s IN ACCESS EXCLUSIVE MODE',p.relation_name);
  END LOOP;
  -- Repeat the complete guard (including unexpected cascade children) while
  -- parents are locked. New FK references cannot race the subsequent deletion.
  PERFORM pg_temp.cleanup_preflight();
  ALTER TABLE sophia_runtime.student_operations_case_activity DISABLE TRIGGER student_operations_case_activity_append_only;
  ALTER TABLE sophia_runtime.student_operations_student_audit_events DISABLE TRIGGER protect_student_operations_student_audit_event;
  FOR p IN SELECT * FROM cleanup_plan ORDER BY position LOOP
    -- UNLINK occurs only after case invoice links are gone, before deleting the
    -- Business Manager identity referenced by the provider-cache student_id FK.
    IF p.operation='UNLINK' THEN
      EXECUTE format('UPDATE %s r SET student_id=NULL,updated_at=now() WHERE %s',p.relation_name,p.predicate);
    ELSE
      EXECUTE format('DELETE FROM %s r WHERE %s',p.relation_name,p.predicate);
    END IF;
    GET DIAGNOSTICS n=ROW_COUNT;
    IF n<>p.preview_rows THEN RAISE EXCEPTION 'Row count changed for %: expected %, got %. Transaction must roll back.',p.relation_name,p.preview_rows,n; END IF;
    UPDATE cleanup_plan SET affected_rows=n WHERE position=p.position;
  END LOOP;
  ALTER TABLE sophia_runtime.student_operations_case_activity ENABLE TRIGGER student_operations_case_activity_append_only;
  ALTER TABLE sophia_runtime.student_operations_student_audit_events ENABLE TRIGGER protect_student_operations_student_audit_event;
  IF EXISTS(SELECT 1 FROM public.users WHERE id=(SELECT user_id FROM cleanup_target))
    OR EXISTS(SELECT 1 FROM sophia_runtime.student_operations_cases WHERE customer_id=(SELECT tenant_id FROM cleanup_target) AND case_id=(SELECT case_id FROM cleanup_target))
    OR EXISTS(SELECT 1 FROM sophia_runtime.student_operations_students WHERE customer_id=(SELECT tenant_id FROM cleanup_target) AND student_id=(SELECT student_id FROM cleanup_target))
  THEN RAISE EXCEPTION 'Final verification failed; transaction must roll back.'; END IF;
  RAISE NOTICE 'Scoped deletions verified and audit triggers restored. Changes are NOT permanent unless the final statement is COMMIT.';
END $apply$;

SELECT operation,relation_name,preview_rows,affected_rows FROM cleanup_plan ORDER BY position;
DROP FUNCTION pg_temp.cleanup_preflight();
-- SAFETY DEFAULT: keep ROLLBACK for every preview. Only change after backup,
-- pausing writers, reviewing the plan and setting apply_cleanup=true above.
ROLLBACK;
