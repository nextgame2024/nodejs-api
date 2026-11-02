-- Generic business messaging configuration. No provider connection or activation.
CREATE TABLE __SOPHIA_RUNTIME_SCHEMA__.lead_assistant_settings (
  customer_id uuid PRIMARY KEY REFERENCES __SOPHIA_RUNTIME_SCHEMA__.customers(customer_id) ON DELETE RESTRICT,
  revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
  draft jsonb NOT NULL CHECK(jsonb_typeof(draft)='object' AND octet_length(draft::text)<=65536),
  updated_by_identity text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE __SOPHIA_RUNTIME_SCHEMA__.lead_assistant_setting_releases (
  release_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES __SOPHIA_RUNTIME_SCHEMA__.customers(customer_id) ON DELETE RESTRICT,
  source_revision integer NOT NULL CHECK(source_revision>0),
  configuration jsonb NOT NULL CHECK(jsonb_typeof(configuration)='object' AND octet_length(configuration::text)<=65536),
  published_by_identity text NOT NULL,
  published_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(customer_id,source_revision)
);
CREATE TABLE __SOPHIA_RUNTIME_SCHEMA__.lead_assistant_settings_audit (
  event_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  customer_id uuid NOT NULL REFERENCES __SOPHIA_RUNTIME_SCHEMA__.customers(customer_id) ON DELETE RESTRICT,
  actor_identity text NOT NULL,
  action text NOT NULL CHECK(action IN ('draft_saved','published')),
  revision integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
DO $$ DECLARE item text; BEGIN
  FOREACH item IN ARRAY ARRAY['lead_assistant_settings','lead_assistant_setting_releases','lead_assistant_settings_audit'] LOOP
    EXECUTE format('ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.%I ENABLE ROW LEVEL SECURITY',item);
    EXECUTE format('ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.%I FORCE ROW LEVEL SECURITY',item);
    EXECUTE format('CREATE POLICY tenant_isolation ON __SOPHIA_RUNTIME_SCHEMA__.%I USING(customer_id=NULLIF(current_setting(''sophia.tenant_id'',true),'''')::uuid) WITH CHECK(customer_id=NULLIF(current_setting(''sophia.tenant_id'',true),'''')::uuid)',item);
  END LOOP;
END $$;
-- Override the owner's inherited default table grants from migration 010.
REVOKE ALL ON __SOPHIA_RUNTIME_SCHEMA__.lead_assistant_settings,
  __SOPHIA_RUNTIME_SCHEMA__.lead_assistant_setting_releases,
  __SOPHIA_RUNTIME_SCHEMA__.lead_assistant_settings_audit FROM sophia_runtime_app;
GRANT SELECT,INSERT,UPDATE ON __SOPHIA_RUNTIME_SCHEMA__.lead_assistant_settings TO sophia_runtime_app;
GRANT SELECT,INSERT ON __SOPHIA_RUNTIME_SCHEMA__.lead_assistant_setting_releases TO sophia_runtime_app;
GRANT INSERT ON __SOPHIA_RUNTIME_SCHEMA__.lead_assistant_settings_audit TO sophia_runtime_app;
GRANT USAGE ON SEQUENCE __SOPHIA_RUNTIME_SCHEMA__.lead_assistant_settings_audit_event_id_seq TO sophia_runtime_app;
