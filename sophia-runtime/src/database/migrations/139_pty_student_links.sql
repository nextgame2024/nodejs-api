-- Student identity is independent of the invoice recipient.
CREATE VIEW __SOPHIA_RUNTIME_SCHEMA__.student_invoice_link_directory WITH (security_barrier=true) AS
 SELECT c.customer_id,u.id AS user_id,u.name,u.email,u.student_id AS student_reference
 FROM __SOPHIA_RUNTIME_SCHEMA__.customers c
 JOIN public.bm_company b ON b.company_id::text=c.external_company_id AND b.workspace_profile='student_operations'
 JOIN public.users u ON u.company_id=b.company_id AND u.type='student' AND u.status='active'
 WHERE c.status='active' AND c.customer_id=NULLIF(current_setting('sophia.tenant_id',true),'')::uuid AND u.student_id IS NOT NULL;
REVOKE ALL ON __SOPHIA_RUNTIME_SCHEMA__.student_invoice_link_directory FROM PUBLIC;
GRANT SELECT ON __SOPHIA_RUNTIME_SCHEMA__.student_invoice_link_directory TO sophia_runtime_app;

CREATE FUNCTION __SOPHIA_RUNTIME_SCHEMA__.ensure_review_student_identity(requested_user uuid) RETURNS text
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE tenant uuid:=NULLIF(current_setting('sophia.tenant_id',true),'')::uuid; account record;
BEGIN
 SELECT u.company_id,u.student_id INTO account FROM public.users u
 JOIN __SOPHIA_RUNTIME_SCHEMA__.student_invoice_link_directory d ON d.customer_id=tenant AND d.user_id=u.id
 WHERE u.id=requested_user FOR UPDATE OF u;
 IF NOT FOUND THEN RAISE EXCEPTION 'Student is unavailable in this workspace'; END IF;
 PERFORM __SOPHIA_RUNTIME_SCHEMA__.ensure_student_operations_profile(requested_user);
 INSERT INTO public.bm_xero_student_identities(customer_id,company_id,student_id)
 VALUES(tenant,account.company_id,account.student_id) ON CONFLICT(customer_id,student_id) DO NOTHING;
 IF NOT EXISTS(SELECT 1 FROM public.bm_xero_student_identities WHERE customer_id=tenant AND student_id=account.student_id AND company_id=account.company_id) THEN RAISE EXCEPTION 'Student identity does not belong to this workspace'; END IF;
 RETURN account.student_id;
END $$;
REVOKE ALL ON FUNCTION __SOPHIA_RUNTIME_SCHEMA__.ensure_review_student_identity(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION __SOPHIA_RUNTIME_SCHEMA__.ensure_review_student_identity(uuid) TO sophia_runtime_app;

ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.student_college_xero_contact_links
 ADD COLUMN student_user_id uuid,
 DROP CONSTRAINT contact_review_classification,
 DROP CONSTRAINT contact_review_target,
 ADD CONSTRAINT contact_review_classification CHECK(classification IN ('college','supplier','student','other','unresolved')),
 ADD CONSTRAINT contact_review_target CHECK((classification='college')=(college_id IS NOT NULL) AND (classification='supplier')=(supplier_id IS NOT NULL) AND (classification='student')=(student_user_id IS NOT NULL));
CREATE FUNCTION __SOPHIA_RUNTIME_SCHEMA__.validate_contact_student_mapping() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.student_user_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM __SOPHIA_RUNTIME_SCHEMA__.student_invoice_link_directory
 WHERE customer_id=NEW.customer_id AND user_id=NEW.student_user_id) THEN RAISE EXCEPTION 'Student is unavailable in this workspace'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER validate_contact_student_mapping BEFORE INSERT OR UPDATE ON __SOPHIA_RUNTIME_SCHEMA__.student_college_xero_contact_links
 FOR EACH ROW EXECUTE FUNCTION __SOPHIA_RUNTIME_SCHEMA__.validate_contact_student_mapping();
