-- Generic lead operations. Does not connect a messaging provider or send messages.
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.lead_assistant_setting_releases ADD CONSTRAINT lead_settings_release_tenant_id UNIQUE(customer_id,release_id);
CREATE TABLE __SOPHIA_RUNTIME_SCHEMA__.assistant_leads (
  lead_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES __SOPHIA_RUNTIME_SCHEMA__.customers(customer_id) ON DELETE RESTRICT,
  display_name text NOT NULL CHECK(length(display_name) BETWEEN 1 AND 160),
  email text NOT NULL DEFAULT '' CHECK(length(email)<=320),
  phone text NOT NULL DEFAULT '' CHECK(length(phone)<=40),
  language text NOT NULL CHECK(language IN ('es','en','pt')),
  interest text NOT NULL DEFAULT '' CHECK(length(interest)<=500),
  location text NOT NULL DEFAULT '' CHECK(length(location)<=160),
  timeframe text NOT NULL DEFAULT '' CHECK(length(timeframe)<=160),
  stage text NOT NULL DEFAULT 'new' CHECK(stage IN ('new','qualifying','qualified','closed')),
  stage_reason text NOT NULL DEFAULT '' CHECK(length(stage_reason)<=1000),
  assigned_to_identity text,
  record_version integer NOT NULL DEFAULT 1 CHECK(record_version>0),
  settings_release_id uuid NOT NULL,
  source text NOT NULL DEFAULT 'manual' CHECK(source IN ('manual','whatsapp')),
  request_key uuid NOT NULL,
  request_hash text NOT NULL,
  created_by_identity text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(customer_id,settings_release_id) REFERENCES __SOPHIA_RUNTIME_SCHEMA__.lead_assistant_setting_releases(customer_id,release_id),
  UNIQUE(customer_id,lead_id),
  UNIQUE(customer_id,request_key),
  CHECK(stage NOT IN ('qualified','closed') OR length(trim(stage_reason))>0)
);
CREATE TABLE __SOPHIA_RUNTIME_SCHEMA__.assistant_lead_conversations (
  conversation_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL,
  lead_id uuid NOT NULL,
  ownership text NOT NULL DEFAULT 'paused' CHECK(ownership IN ('paused','human','human_requested','bot')),
  human_owner_identity text,
  ownership_version integer NOT NULL DEFAULT 1 CHECK(ownership_version>0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(customer_id,lead_id),
  UNIQUE(customer_id,conversation_id),
  FOREIGN KEY(customer_id,lead_id) REFERENCES __SOPHIA_RUNTIME_SCHEMA__.assistant_leads(customer_id,lead_id) ON DELETE RESTRICT,
  CHECK((ownership='human')=(human_owner_identity IS NOT NULL))
);
CREATE TABLE __SOPHIA_RUNTIME_SCHEMA__.assistant_lead_events (
  event_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  customer_id uuid NOT NULL,
  conversation_id uuid NOT NULL,
  kind text NOT NULL CHECK(kind IN ('note','lead_created','lead_updated','assignment_changed','ownership_changed','inbound_message','outbound_message')),
  body text NOT NULL DEFAULT '' CHECK(length(body)<=4000),
  actor_identity text,
  metadata jsonb NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(metadata)='object' AND octet_length(metadata::text)<=16384),
  request_key uuid,
  request_hash text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(customer_id,conversation_id,request_key),
  FOREIGN KEY(customer_id,conversation_id) REFERENCES __SOPHIA_RUNTIME_SCHEMA__.assistant_lead_conversations(customer_id,conversation_id) ON DELETE RESTRICT
);
CREATE INDEX assistant_leads_assigned ON __SOPHIA_RUNTIME_SCHEMA__.assistant_leads(customer_id,assigned_to_identity,updated_at DESC,lead_id);
CREATE INDEX assistant_leads_stage ON __SOPHIA_RUNTIME_SCHEMA__.assistant_leads(customer_id,stage,updated_at DESC,lead_id);
CREATE INDEX assistant_lead_events_thread ON __SOPHIA_RUNTIME_SCHEMA__.assistant_lead_events(customer_id,conversation_id,event_id DESC);
DO $$ DECLARE item text; BEGIN
 FOREACH item IN ARRAY ARRAY['assistant_leads','assistant_lead_conversations','assistant_lead_events'] LOOP
  EXECUTE format('ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.%I ENABLE ROW LEVEL SECURITY',item);
  EXECUTE format('ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.%I FORCE ROW LEVEL SECURITY',item);
  EXECUTE format('CREATE POLICY tenant_isolation ON __SOPHIA_RUNTIME_SCHEMA__.%I USING(customer_id=NULLIF(current_setting(''sophia.tenant_id'',true),'''')::uuid) WITH CHECK(customer_id=NULLIF(current_setting(''sophia.tenant_id'',true),'''')::uuid)',item);
 END LOOP;
END $$;
REVOKE ALL ON __SOPHIA_RUNTIME_SCHEMA__.assistant_leads,__SOPHIA_RUNTIME_SCHEMA__.assistant_lead_conversations,__SOPHIA_RUNTIME_SCHEMA__.assistant_lead_events FROM sophia_runtime_app;
GRANT SELECT,INSERT,UPDATE ON __SOPHIA_RUNTIME_SCHEMA__.assistant_leads,__SOPHIA_RUNTIME_SCHEMA__.assistant_lead_conversations TO sophia_runtime_app;
GRANT SELECT,INSERT ON __SOPHIA_RUNTIME_SCHEMA__.assistant_lead_events TO sophia_runtime_app;
GRANT USAGE ON SEQUENCE __SOPHIA_RUNTIME_SCHEMA__.assistant_lead_events_event_id_seq TO sophia_runtime_app;
