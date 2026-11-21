-- Review-only directory includes closed records. Operational college eligibility is unchanged.
CREATE VIEW __SOPHIA_RUNTIME_SCHEMA__.student_contact_review_directory WITH (security_barrier=true) AS
 SELECT c.customer_id,b.college_id AS id,b.college_name AS name,'college'::text AS kind,b.status::text AS status,b.trading_name,b.acronym
 FROM __SOPHIA_RUNTIME_SCHEMA__.customers c JOIN public.bm_colleges b ON b.company_id::text=c.external_company_id
 WHERE c.status='active' AND c.customer_id=NULLIF(current_setting('sophia.tenant_id',true),'')::uuid
 UNION ALL
 SELECT c.customer_id,b.supplier_id,b.supplier_name,'supplier',b.status::text,NULL::text,NULL::text
 FROM __SOPHIA_RUNTIME_SCHEMA__.customers c JOIN public.bm_suppliers b ON b.company_id::text=c.external_company_id
 WHERE c.status='active' AND c.customer_id=NULLIF(current_setting('sophia.tenant_id',true),'')::uuid;
REVOKE ALL ON __SOPHIA_RUNTIME_SCHEMA__.student_contact_review_directory FROM PUBLIC;
GRANT SELECT ON __SOPHIA_RUNTIME_SCHEMA__.student_contact_review_directory TO sophia_runtime_app;

ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.student_college_xero_contact_links ADD COLUMN supplier_id uuid;
-- Locate the original expression checks independently of PostgreSQL-generated names.
DO $$ DECLARE c record; BEGIN
 FOR c IN SELECT conname FROM pg_constraint WHERE conrelid='__SOPHIA_RUNTIME_SCHEMA__.student_college_xero_contact_links'::regclass
 AND contype='c' AND pg_get_constraintdef(oid) LIKE '%classification%' LOOP
 EXECUTE format('ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.student_college_xero_contact_links DROP CONSTRAINT %I',c.conname);
 END LOOP;
END $$;
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.student_college_xero_contact_links
 ADD CONSTRAINT contact_review_classification CHECK(classification IN ('college','supplier','other','unresolved')),
 ADD CONSTRAINT contact_review_target CHECK((classification='college')=(college_id IS NOT NULL) AND (classification='supplier')=(supplier_id IS NOT NULL));
CREATE OR REPLACE FUNCTION __SOPHIA_RUNTIME_SCHEMA__.validate_college_xero_mapping() RETURNS trigger
LANGUAGE plpgsql AS $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM __SOPHIA_RUNTIME_SCHEMA__.student_operations_xero_sync_configurations
 WHERE customer_id=NEW.customer_id AND xero_connection_id=NEW.xero_connection_id AND organisation_role='operating') THEN
 RAISE EXCEPTION 'Contact mapping requires an operating organisation'; END IF;
 IF NEW.college_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM __SOPHIA_RUNTIME_SCHEMA__.student_contact_review_directory
 WHERE customer_id=NEW.customer_id AND id=NEW.college_id AND kind='college') THEN RAISE EXCEPTION 'College is not available in this workspace'; END IF;
 IF NEW.supplier_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM __SOPHIA_RUNTIME_SCHEMA__.student_contact_review_directory
 WHERE customer_id=NEW.customer_id AND id=NEW.supplier_id AND kind='supplier') THEN RAISE EXCEPTION 'Supplier is not available in this workspace'; END IF;
 RETURN NEW;
END $$;

-- Narrow owner bridge, like the existing BM projection bridges: no direct table grants,
-- no caller-supplied company. Creation participates in the mapping/audit transaction.
CREATE FUNCTION __SOPHIA_RUNTIME_SCHEMA__.create_contact_review_record(kind text, details jsonb, actor text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE company uuid; result uuid; record_name text=btrim(details->>'name'); record_status text; actor_id uuid;
BEGIN
 SELECT external_company_id::uuid INTO company FROM __SOPHIA_RUNTIME_SCHEMA__.customers
 WHERE customer_id=NULLIF(current_setting('sophia.tenant_id',true),'')::uuid AND status='active';
 IF company IS NULL OR kind NOT IN ('college','supplier') OR record_name IS NULL OR length(record_name) NOT BETWEEN 1 AND 200 THEN
 RAISE EXCEPTION 'Invalid review record'; END IF;
 SELECT id INTO actor_id FROM public.users WHERE id::text=actor AND company_id=company AND status::text<>'archived';
 IF actor_id IS NULL THEN RAISE EXCEPTION 'Review author is unavailable'; END IF;
 record_status=CASE WHEN (details->>'closed')::boolean THEN 'archived' ELSE 'active' END;
 PERFORM pg_advisory_xact_lock(hashtextextended('review-create:'||company::text||':'||kind||':'||lower(record_name),0));
 IF kind='college' THEN
 IF EXISTS(SELECT 1 FROM public.bm_colleges WHERE company_id=company AND lower(btrim(college_name))=lower(record_name)) THEN
 RAISE EXCEPTION 'A college with this name already exists. Select it from the list.' USING ERRCODE='23505'; END IF;
 INSERT INTO public.bm_colleges(company_id,college_name,email,tel,notes,status)
 VALUES(company,record_name,NULLIF(details->>'email',''),NULLIF(details->>'phone',''),NULLIF(details->>'notes',''),record_status) RETURNING college_id INTO result;
 ELSE
 IF EXISTS(SELECT 1 FROM public.bm_suppliers WHERE company_id=company AND lower(btrim(supplier_name))=lower(record_name)) THEN
 RAISE EXCEPTION 'A supplier with this name already exists. Select it from the list.' USING ERRCODE='23505'; END IF;
 IF COALESCE(details->>'supplierType','services') NOT IN ('services','products') THEN RAISE EXCEPTION 'Invalid supplier type'; END IF;
 INSERT INTO public.bm_suppliers(supplier_id,user_id,company_id,supplier_name,email,tel,notes,status,supplier_type)
 VALUES(gen_random_uuid(),actor_id,company,record_name,NULLIF(details->>'email',''),NULLIF(details->>'phone',''),NULLIF(details->>'notes',''),record_status::public.bm_record_status,COALESCE(details->>'supplierType','services')) RETURNING supplier_id INTO result;
 END IF;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION __SOPHIA_RUNTIME_SCHEMA__.create_contact_review_record(text,jsonb,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION __SOPHIA_RUNTIME_SCHEMA__.create_contact_review_record(text,jsonb,text) TO sophia_runtime_app;
