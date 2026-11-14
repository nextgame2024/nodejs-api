-- Form definitions only; no public collection or messaging side effects.
CREATE TABLE __SOPHIA_RUNTIME_SCHEMA__.lead_form_types (
 customer_id uuid NOT NULL REFERENCES __SOPHIA_RUNTIME_SCHEMA__.customers(customer_id),
 id uuid NOT NULL DEFAULT gen_random_uuid(),
 name text NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 80),
 deleted_at timestamptz,
 PRIMARY KEY(customer_id,id)
);
CREATE UNIQUE INDEX lead_form_types_name ON __SOPHIA_RUNTIME_SCHEMA__.lead_form_types(customer_id,lower(name));
CREATE TABLE __SOPHIA_RUNTIME_SCHEMA__.lead_forms (
 customer_id uuid NOT NULL REFERENCES __SOPHIA_RUNTIME_SCHEMA__.customers(customer_id),
 id uuid NOT NULL,
 name text NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 160),
 type_id uuid NOT NULL,
 blocks jsonb NOT NULL CHECK(jsonb_typeof(blocks)='array' AND jsonb_array_length(blocks) BETWEEN 1 AND 100 AND octet_length(blocks::text)<=220000),
 version integer NOT NULL DEFAULT 1 CHECK(version>0),
 updated_at timestamptz NOT NULL DEFAULT now(),
 created_by_identity text NOT NULL,
 PRIMARY KEY(customer_id,id),
 FOREIGN KEY(customer_id,type_id) REFERENCES __SOPHIA_RUNTIME_SCHEMA__.lead_form_types(customer_id,id)
);
CREATE INDEX lead_forms_list ON __SOPHIA_RUNTIME_SCHEMA__.lead_forms(customer_id,updated_at DESC,id);
CREATE TABLE __SOPHIA_RUNTIME_SCHEMA__.lead_forms_audit (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 customer_id uuid NOT NULL REFERENCES __SOPHIA_RUNTIME_SCHEMA__.customers(customer_id),
 actor_identity text NOT NULL,
 entity_id uuid NOT NULL,
 action text NOT NULL CHECK(action IN ('form_saved','form_deleted','type_created','type_deleted')),
 created_at timestamptz NOT NULL DEFAULT now()
);
DO $$ DECLARE item text; BEGIN
 FOREACH item IN ARRAY ARRAY['lead_form_types','lead_forms','lead_forms_audit'] LOOP
  EXECUTE format('ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.%I ENABLE ROW LEVEL SECURITY',item);
  EXECUTE format('ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.%I FORCE ROW LEVEL SECURITY',item);
  EXECUTE format('CREATE POLICY tenant_isolation ON __SOPHIA_RUNTIME_SCHEMA__.%I USING(customer_id=NULLIF(current_setting(''sophia.tenant_id'',true),'''')::uuid) WITH CHECK(customer_id=NULLIF(current_setting(''sophia.tenant_id'',true),'''')::uuid)',item);
 END LOOP;
END $$;
REVOKE ALL ON __SOPHIA_RUNTIME_SCHEMA__.lead_form_types,__SOPHIA_RUNTIME_SCHEMA__.lead_forms,__SOPHIA_RUNTIME_SCHEMA__.lead_forms_audit FROM sophia_runtime_app;
GRANT SELECT,INSERT,UPDATE ON __SOPHIA_RUNTIME_SCHEMA__.lead_form_types TO sophia_runtime_app;
GRANT SELECT,INSERT,UPDATE,DELETE ON __SOPHIA_RUNTIME_SCHEMA__.lead_forms TO sophia_runtime_app;
GRANT SELECT,INSERT ON __SOPHIA_RUNTIME_SCHEMA__.lead_forms_audit TO sophia_runtime_app;
