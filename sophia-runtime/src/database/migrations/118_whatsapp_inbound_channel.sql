-- Receive-only official WhatsApp channel. Secrets remain in deployment secret storage.
CREATE TABLE __SOPHIA_RUNTIME_SCHEMA__.assistant_channels (
 channel_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 customer_id uuid NOT NULL REFERENCES __SOPHIA_RUNTIME_SCHEMA__.customers(customer_id),
 profile_id text NOT NULL CHECK(length(profile_id) BETWEEN 1 AND 80),
 phone_number_id text NOT NULL CHECK(phone_number_id ~ '^[0-9]{5,30}$'),
 business_account_id text NOT NULL CHECK(business_account_id ~ '^[0-9]{5,30}$'),
 enabled boolean NOT NULL DEFAULT false,
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
 updated_by_identity text NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT now(),
 last_received_at timestamptz,
 UNIQUE(customer_id,profile_id), UNIQUE(customer_id,channel_id)
);
CREATE TABLE __SOPHIA_RUNTIME_SCHEMA__.assistant_channel_receipts (
 receipt_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 customer_id uuid NOT NULL,
 channel_id uuid NOT NULL,
 event_key text NOT NULL CHECK(length(event_key)<=512),
 event jsonb NOT NULL CHECK(jsonb_typeof(event)='object' AND octet_length(event::text)<=32768),
 state text NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','processed','failed')),
 attempts integer NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 8),
 available_at timestamptz NOT NULL DEFAULT now(),
 received_at timestamptz NOT NULL DEFAULT now(),
 processed_at timestamptz,
 failure_code text CHECK(failure_code IS NULL OR failure_code IN ('processing_failed','configuration_required')),
 UNIQUE(customer_id,channel_id,event_key),
 FOREIGN KEY(customer_id,channel_id) REFERENCES __SOPHIA_RUNTIME_SCHEMA__.assistant_channels(customer_id,channel_id)
);
CREATE INDEX assistant_channel_receipts_pending ON __SOPHIA_RUNTIME_SCHEMA__.assistant_channel_receipts(customer_id,channel_id,available_at,receipt_id) WHERE state='queued';
CREATE TABLE __SOPHIA_RUNTIME_SCHEMA__.assistant_channel_contacts (
 customer_id uuid NOT NULL,
 channel_id uuid NOT NULL,
 sender_id text NOT NULL CHECK(sender_id ~ '^[0-9]{7,20}$'),
 lead_id uuid NOT NULL,
 last_inbound_at timestamptz,
 opted_out boolean NOT NULL DEFAULT false,
 PRIMARY KEY(customer_id,channel_id,sender_id),
 FOREIGN KEY(customer_id,channel_id) REFERENCES __SOPHIA_RUNTIME_SCHEMA__.assistant_channels(customer_id,channel_id),
 FOREIGN KEY(customer_id,lead_id) REFERENCES __SOPHIA_RUNTIME_SCHEMA__.assistant_leads(customer_id,lead_id),
 UNIQUE(customer_id,lead_id)
);
DO $$ DECLARE item text; BEGIN
 FOREACH item IN ARRAY ARRAY['assistant_channels','assistant_channel_receipts','assistant_channel_contacts'] LOOP
  EXECUTE format('ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.%I ENABLE ROW LEVEL SECURITY',item);
  EXECUTE format('ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.%I FORCE ROW LEVEL SECURITY',item);
  EXECUTE format('CREATE POLICY tenant_isolation ON __SOPHIA_RUNTIME_SCHEMA__.%I USING(customer_id=NULLIF(current_setting(''sophia.tenant_id'',true),'''')::uuid) WITH CHECK(customer_id=NULLIF(current_setting(''sophia.tenant_id'',true),'''')::uuid)',item);
 END LOOP;
END $$;
REVOKE ALL ON __SOPHIA_RUNTIME_SCHEMA__.assistant_channels,__SOPHIA_RUNTIME_SCHEMA__.assistant_channel_receipts,__SOPHIA_RUNTIME_SCHEMA__.assistant_channel_contacts FROM sophia_runtime_app;
GRANT SELECT,INSERT,UPDATE ON __SOPHIA_RUNTIME_SCHEMA__.assistant_channels,__SOPHIA_RUNTIME_SCHEMA__.assistant_channel_receipts,__SOPHIA_RUNTIME_SCHEMA__.assistant_channel_contacts TO sophia_runtime_app;
GRANT USAGE ON SEQUENCE __SOPHIA_RUNTIME_SCHEMA__.assistant_channel_receipts_receipt_id_seq TO sophia_runtime_app;
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.lead_assistant_settings_audit DROP CONSTRAINT lead_assistant_settings_audit_action_check;
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.lead_assistant_settings_audit ADD CONSTRAINT lead_assistant_settings_audit_action_check CHECK(action IN ('draft_saved','published','channel_updated'));

CREATE INDEX assistant_channel_receipts_attention ON __SOPHIA_RUNTIME_SCHEMA__.assistant_channel_receipts(customer_id,state,received_at) WHERE state IN ('queued','failed');
