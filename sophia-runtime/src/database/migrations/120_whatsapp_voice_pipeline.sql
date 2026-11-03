-- Additive voice processing. No live effects or plaintext media storage.
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.assistant_message_outbox ADD COLUMN format text NOT NULL DEFAULT 'text' CHECK(format IN ('text','audio'));
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.assistant_message_outbox ADD COLUMN parent_message_id uuid;
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.assistant_message_outbox ADD CONSTRAINT assistant_message_tenant_id UNIQUE(customer_id,message_id);
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.assistant_message_outbox ADD CONSTRAINT assistant_message_parent_fk FOREIGN KEY(customer_id,parent_message_id) REFERENCES __SOPHIA_RUNTIME_SCHEMA__.assistant_message_outbox(customer_id,message_id);
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.assistant_message_outbox DROP CONSTRAINT assistant_message_outbox_customer_id_job_id_key;
CREATE UNIQUE INDEX assistant_message_outbox_job_format ON __SOPHIA_RUNTIME_SCHEMA__.assistant_message_outbox(customer_id,job_id,format) WHERE job_id IS NOT NULL;
CREATE UNIQUE INDEX assistant_message_outbox_voice_pair ON __SOPHIA_RUNTIME_SCHEMA__.assistant_message_outbox(customer_id,parent_message_id) WHERE format='audio';
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.assistant_message_outbox DROP CONSTRAINT assistant_message_outbox_state_check;
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.assistant_message_outbox ADD CONSTRAINT assistant_message_outbox_state_check CHECK(state IN ('preparing','queued','dispatching','accepted','delivered','read','failed','unknown','cancelled'));
CREATE TABLE __SOPHIA_RUNTIME_SCHEMA__.assistant_voice_jobs (
 voice_job_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),customer_id uuid NOT NULL,channel_id uuid NOT NULL,lead_id uuid NOT NULL,conversation_id uuid NOT NULL,
 kind text NOT NULL CHECK(kind IN ('transcribe','synthesize')),source_event_id bigint,message_id uuid,
 ownership_version integer NOT NULL,agent_release_id uuid NOT NULL,binding_revision integer NOT NULL,
 state text NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','working','ready','failed','cancelled')),attempts int NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 2),
 lease_id uuid,lease_until timestamptz,failure_code text,transcript_event_id bigint,
 created_at timestamptz NOT NULL DEFAULT now(),completed_at timestamptz,
 CHECK((kind='transcribe' AND source_event_id IS NOT NULL AND message_id IS NULL) OR (kind='synthesize' AND message_id IS NOT NULL AND source_event_id IS NULL)),
 UNIQUE(customer_id,source_event_id),UNIQUE(customer_id,message_id),
 FOREIGN KEY(customer_id,channel_id) REFERENCES __SOPHIA_RUNTIME_SCHEMA__.assistant_channels(customer_id,channel_id),
 FOREIGN KEY(customer_id,lead_id) REFERENCES __SOPHIA_RUNTIME_SCHEMA__.assistant_leads(customer_id,lead_id),
 FOREIGN KEY(customer_id,conversation_id,source_event_id) REFERENCES __SOPHIA_RUNTIME_SCHEMA__.assistant_lead_events(customer_id,conversation_id,event_id),
 FOREIGN KEY(customer_id,message_id) REFERENCES __SOPHIA_RUNTIME_SCHEMA__.assistant_message_outbox(customer_id,message_id),
 FOREIGN KEY(agent_release_id,customer_id) REFERENCES __SOPHIA_RUNTIME_SCHEMA__.agent_release_manifests(agent_release_id,customer_id)
);
CREATE TABLE __SOPHIA_RUNTIME_SCHEMA__.assistant_voice_assets (
 customer_id uuid NOT NULL,message_id uuid NOT NULL,ciphertext bytea,iv bytea,auth_tag bytea,key_fingerprint text NOT NULL,
 provider_media_id text,expires_at timestamptz NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(customer_id,message_id),FOREIGN KEY(customer_id,message_id) REFERENCES __SOPHIA_RUNTIME_SCHEMA__.assistant_message_outbox(customer_id,message_id),
 CHECK(ciphertext IS NULL OR octet_length(ciphertext)<=5242880),CHECK(iv IS NULL OR octet_length(iv)=12),CHECK(auth_tag IS NULL OR octet_length(auth_tag)=16)
);
CREATE INDEX assistant_voice_jobs_due ON __SOPHIA_RUNTIME_SCHEMA__.assistant_voice_jobs(customer_id,channel_id,kind,created_at) WHERE state IN ('queued','working');
CREATE INDEX assistant_voice_jobs_lead ON __SOPHIA_RUNTIME_SCHEMA__.assistant_voice_jobs(customer_id,lead_id,created_at DESC);
CREATE INDEX assistant_voice_assets_expiry ON __SOPHIA_RUNTIME_SCHEMA__.assistant_voice_assets(customer_id,expires_at) WHERE ciphertext IS NOT NULL;
DO $$ DECLARE item text; BEGIN
 FOREACH item IN ARRAY ARRAY['assistant_voice_jobs','assistant_voice_assets'] LOOP
  EXECUTE format('ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.%I ENABLE ROW LEVEL SECURITY',item);
  EXECUTE format('ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.%I FORCE ROW LEVEL SECURITY',item);
  EXECUTE format('CREATE POLICY tenant_isolation ON __SOPHIA_RUNTIME_SCHEMA__.%I USING(customer_id=NULLIF(current_setting(''sophia.tenant_id'',true),'''')::uuid) WITH CHECK(customer_id=NULLIF(current_setting(''sophia.tenant_id'',true),'''')::uuid)',item);
  EXECUTE format('REVOKE ALL ON __SOPHIA_RUNTIME_SCHEMA__.%I FROM sophia_runtime_app',item);
  EXECUTE format('GRANT SELECT,INSERT,UPDATE ON __SOPHIA_RUNTIME_SCHEMA__.%I TO sophia_runtime_app',item);
 END LOOP;
END $$;
CREATE OR REPLACE FUNCTION __SOPHIA_RUNTIME_SCHEMA__.cancel_stale_assistant_replies() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 UPDATE __SOPHIA_RUNTIME_SCHEMA__.assistant_message_outbox SET state='cancelled',safe_code='ownership_changed',updated_at=now()
 WHERE customer_id=NEW.customer_id AND conversation_id=NEW.conversation_id AND ownership_version<>NEW.ownership_version AND state IN ('queued','preparing');
 UPDATE __SOPHIA_RUNTIME_SCHEMA__.assistant_reply_jobs SET state='cancelled',completed_at=now()
 WHERE customer_id=NEW.customer_id AND conversation_id=NEW.conversation_id AND ownership_version<>NEW.ownership_version AND state IN ('queued','working','ready');
 UPDATE __SOPHIA_RUNTIME_SCHEMA__.assistant_voice_jobs SET state='cancelled',completed_at=now()
 WHERE customer_id=NEW.customer_id AND conversation_id=NEW.conversation_id AND ownership_version<>NEW.ownership_version AND kind='synthesize' AND state IN ('queued','working');
 RETURN NEW;
END $$;

ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.assistant_message_outbox DROP CONSTRAINT assistant_message_outbox_body_check;
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.assistant_message_outbox ADD CONSTRAINT assistant_message_outbox_body_check CHECK(length(trim(body)) BETWEEN 1 AND 4096);
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.assistant_message_outbox ADD CONSTRAINT assistant_message_pair_format CHECK((format='text' AND parent_message_id IS NULL) OR (format='audio' AND parent_message_id IS NOT NULL));
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.assistant_voice_jobs ADD CONSTRAINT assistant_voice_jobs_tenant_id UNIQUE(customer_id,voice_job_id);
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.assistant_message_outbox ADD COLUMN voice_failure_job_id uuid;
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.assistant_message_outbox ADD CONSTRAINT assistant_message_voice_failure_fk FOREIGN KEY(customer_id,voice_failure_job_id) REFERENCES __SOPHIA_RUNTIME_SCHEMA__.assistant_voice_jobs(customer_id,voice_job_id);
CREATE UNIQUE INDEX assistant_message_voice_failure_once ON __SOPHIA_RUNTIME_SCHEMA__.assistant_message_outbox(customer_id,voice_failure_job_id) WHERE voice_failure_job_id IS NOT NULL;
-- The customer-facing text may append the short AI-voice disclosure to a
-- 4000-character answer. Keep timeline storage aligned with the outbox bound.
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.assistant_lead_events DROP CONSTRAINT assistant_lead_events_body_check;
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.assistant_lead_events ADD CONSTRAINT assistant_lead_events_body_check CHECK(length(body)<=4096);
