CREATE TABLE __SOPHIA_RUNTIME_SCHEMA__.lead_form_publications (
 customer_id uuid NOT NULL REFERENCES __SOPHIA_RUNTIME_SCHEMA__.customers(customer_id),
 id uuid NOT NULL DEFAULT gen_random_uuid(),
 form_id uuid NOT NULL,
 form_version integer NOT NULL,
 name text NOT NULL,
 blocks jsonb NOT NULL,
 business_name text NOT NULL,
 published_by_identity text NOT NULL,
 active boolean NOT NULL DEFAULT true,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(customer_id,id),
 FOREIGN KEY(customer_id,form_id) REFERENCES __SOPHIA_RUNTIME_SCHEMA__.lead_forms(customer_id,id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX lead_form_publication_active ON __SOPHIA_RUNTIME_SCHEMA__.lead_form_publications(customer_id,form_id) WHERE active;
CREATE TABLE __SOPHIA_RUNTIME_SCHEMA__.lead_form_submissions (
 customer_id uuid NOT NULL,
 id uuid NOT NULL DEFAULT gen_random_uuid(),
 publication_id uuid NOT NULL,
 lead_id uuid NOT NULL,
 request_key uuid NOT NULL,
 request_hash text NOT NULL,
 answers jsonb NOT NULL CHECK(octet_length(answers::text)<=200000),
 result jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(customer_id,id),
 UNIQUE(customer_id,publication_id,request_key),
 FOREIGN KEY(customer_id,lead_id) REFERENCES __SOPHIA_RUNTIME_SCHEMA__.assistant_leads(customer_id,lead_id)
 -- Keep submitted data when a form/publication is deleted. The captured result includes its name.
);
CREATE INDEX lead_form_submissions_publication ON __SOPHIA_RUNTIME_SCHEMA__.lead_form_submissions(customer_id,publication_id,created_at DESC);
DO $$ DECLARE item text; BEGIN
 FOREACH item IN ARRAY ARRAY['lead_form_publications','lead_form_submissions'] LOOP
 EXECUTE format('ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.%I ENABLE ROW LEVEL SECURITY',item);
 EXECUTE format('ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.%I FORCE ROW LEVEL SECURITY',item);
 EXECUTE format('CREATE POLICY tenant_isolation ON __SOPHIA_RUNTIME_SCHEMA__.%I USING(customer_id=NULLIF(current_setting(''sophia.tenant_id'',true),'''')::uuid) WITH CHECK(customer_id=NULLIF(current_setting(''sophia.tenant_id'',true),'''')::uuid)',item);
 EXECUTE format('REVOKE ALL ON __SOPHIA_RUNTIME_SCHEMA__.%I FROM sophia_runtime_app',item);
 END LOOP;
END $$;
GRANT SELECT,INSERT,UPDATE ON __SOPHIA_RUNTIME_SCHEMA__.lead_form_publications TO sophia_runtime_app;
GRANT SELECT,INSERT ON __SOPHIA_RUNTIME_SCHEMA__.lead_form_submissions TO sophia_runtime_app;
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.assistant_leads DROP CONSTRAINT assistant_leads_source_check;
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.assistant_leads ADD CONSTRAINT assistant_leads_source_check CHECK(source IN ('manual','whatsapp','form'));
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.lead_forms_audit DROP CONSTRAINT lead_forms_audit_action_check;
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.lead_forms_audit ADD CONSTRAINT lead_forms_audit_action_check CHECK(action IN ('form_saved','form_deleted','type_created','type_deleted','form_published','form_unpublished'));
