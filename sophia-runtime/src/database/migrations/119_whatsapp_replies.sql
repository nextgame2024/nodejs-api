ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.assistant_lead_events ADD CONSTRAINT assistant_lead_event_tenant_id UNIQUE(customer_id,conversation_id,event_id);
CREATE TABLE __SOPHIA_RUNTIME_SCHEMA__.assistant_reply_bindings (
 customer_id uuid NOT NULL, channel_id uuid NOT NULL, agent_release_id uuid NOT NULL,
 mode text NOT NULL DEFAULT 'review' CHECK(mode IN ('review','automatic')),revision integer NOT NULL DEFAULT 1,
 updated_by_identity text NOT NULL,updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(customer_id,channel_id),
 FOREIGN KEY(customer_id,channel_id) REFERENCES __SOPHIA_RUNTIME_SCHEMA__.assistant_channels(customer_id,channel_id),
 FOREIGN KEY(agent_release_id,customer_id) REFERENCES __SOPHIA_RUNTIME_SCHEMA__.agent_release_manifests(agent_release_id,customer_id)
);
CREATE TABLE __SOPHIA_RUNTIME_SCHEMA__.assistant_reply_jobs (
 job_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),customer_id uuid NOT NULL,channel_id uuid NOT NULL,lead_id uuid NOT NULL,
 conversation_id uuid NOT NULL,source_event_id bigint NOT NULL,
 agent_release_id uuid NOT NULL,ownership_version integer NOT NULL,binding_revision integer NOT NULL DEFAULT 1 CHECK(binding_revision>0),requested_by_identity text,
 state text NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','working','ready','needs_human','cancelled','failed')),
 lease_id uuid,lease_until timestamptz,attempts integer NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 2),
 answer text CHECK(length(answer)<=4000),sources jsonb NOT NULL DEFAULT '[]' CHECK(jsonb_typeof(sources)='array' AND jsonb_array_length(sources)<=5),usage jsonb NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(usage)='object' AND octet_length(usage::text)<=16384),
 created_at timestamptz NOT NULL DEFAULT now(),completed_at timestamptz,
 FOREIGN KEY(customer_id,conversation_id,source_event_id) REFERENCES __SOPHIA_RUNTIME_SCHEMA__.assistant_lead_events(customer_id,conversation_id,event_id),
 UNIQUE(customer_id,job_id),UNIQUE(customer_id,conversation_id,source_event_id,ownership_version,binding_revision),
 FOREIGN KEY(customer_id,channel_id) REFERENCES __SOPHIA_RUNTIME_SCHEMA__.assistant_channels(customer_id,channel_id),
 FOREIGN KEY(customer_id,lead_id) REFERENCES __SOPHIA_RUNTIME_SCHEMA__.assistant_leads(customer_id,lead_id),
 FOREIGN KEY(customer_id,conversation_id) REFERENCES __SOPHIA_RUNTIME_SCHEMA__.assistant_lead_conversations(customer_id,conversation_id),
 FOREIGN KEY(agent_release_id,customer_id) REFERENCES __SOPHIA_RUNTIME_SCHEMA__.agent_release_manifests(agent_release_id,customer_id)
);
CREATE TABLE __SOPHIA_RUNTIME_SCHEMA__.assistant_message_outbox (
 message_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),customer_id uuid NOT NULL,channel_id uuid NOT NULL,lead_id uuid NOT NULL,
 conversation_id uuid NOT NULL,ownership_version integer NOT NULL,actor_identity text,body text NOT NULL CHECK(length(trim(body)) BETWEEN 1 AND 4000),
 request_key uuid NOT NULL,request_hash text NOT NULL,job_id uuid,
 state text NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','dispatching','accepted','delivered','read','failed','unknown','cancelled')),
 attempts integer NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 5),available_at timestamptz NOT NULL DEFAULT now(),
 dispatch_id uuid,dispatch_until timestamptz,provider_message_id text,safe_code text,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(customer_id,channel_id,request_key),UNIQUE(customer_id,channel_id,provider_message_id),UNIQUE(customer_id,job_id),
 FOREIGN KEY(customer_id,channel_id) REFERENCES __SOPHIA_RUNTIME_SCHEMA__.assistant_channels(customer_id,channel_id),
 FOREIGN KEY(customer_id,lead_id) REFERENCES __SOPHIA_RUNTIME_SCHEMA__.assistant_leads(customer_id,lead_id),
 FOREIGN KEY(customer_id,conversation_id) REFERENCES __SOPHIA_RUNTIME_SCHEMA__.assistant_lead_conversations(customer_id,conversation_id),
 FOREIGN KEY(customer_id,job_id) REFERENCES __SOPHIA_RUNTIME_SCHEMA__.assistant_reply_jobs(customer_id,job_id)
);
CREATE INDEX assistant_reply_jobs_due ON __SOPHIA_RUNTIME_SCHEMA__.assistant_reply_jobs(customer_id,channel_id,created_at) WHERE state IN ('queued','working');
CREATE INDEX assistant_message_outbox_due ON __SOPHIA_RUNTIME_SCHEMA__.assistant_message_outbox(customer_id,channel_id,available_at,created_at) WHERE state IN ('queued','dispatching');
DO $$ DECLARE item text; BEGIN
 FOREACH item IN ARRAY ARRAY['assistant_reply_bindings','assistant_reply_jobs','assistant_message_outbox'] LOOP
  EXECUTE format('ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.%I ENABLE ROW LEVEL SECURITY',item);
  EXECUTE format('ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.%I FORCE ROW LEVEL SECURITY',item);
  EXECUTE format('CREATE POLICY tenant_isolation ON __SOPHIA_RUNTIME_SCHEMA__.%I USING(customer_id=NULLIF(current_setting(''sophia.tenant_id'',true),'''')::uuid) WITH CHECK(customer_id=NULLIF(current_setting(''sophia.tenant_id'',true),'''')::uuid)',item);
  EXECUTE format('REVOKE ALL ON __SOPHIA_RUNTIME_SCHEMA__.%I FROM sophia_runtime_app',item);
  EXECUTE format('GRANT SELECT,INSERT,UPDATE ON __SOPHIA_RUNTIME_SCHEMA__.%I TO sophia_runtime_app',item);
 END LOOP;
END $$;
-- Ownership changes cancel undispatched work. Dispatch already in flight cannot
-- be recalled; preserve it for explicit delivery reconciliation.
CREATE FUNCTION __SOPHIA_RUNTIME_SCHEMA__.cancel_stale_assistant_replies() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 UPDATE __SOPHIA_RUNTIME_SCHEMA__.assistant_message_outbox SET state='cancelled',safe_code='ownership_changed',updated_at=now()
 WHERE customer_id=NEW.customer_id AND conversation_id=NEW.conversation_id AND ownership_version<>NEW.ownership_version AND state='queued';
 UPDATE __SOPHIA_RUNTIME_SCHEMA__.assistant_reply_jobs SET state='cancelled',completed_at=now()
 WHERE customer_id=NEW.customer_id AND conversation_id=NEW.conversation_id AND ownership_version<>NEW.ownership_version AND state IN ('queued','working','ready');
 RETURN NEW;
END $$;
CREATE TRIGGER cancel_stale_assistant_replies AFTER UPDATE OF ownership_version ON __SOPHIA_RUNTIME_SCHEMA__.assistant_lead_conversations FOR EACH ROW EXECUTE FUNCTION __SOPHIA_RUNTIME_SCHEMA__.cancel_stale_assistant_replies();

CREATE INDEX assistant_reply_jobs_lead ON __SOPHIA_RUNTIME_SCHEMA__.assistant_reply_jobs(customer_id,lead_id,created_at DESC,job_id);
CREATE INDEX assistant_message_outbox_lead ON __SOPHIA_RUNTIME_SCHEMA__.assistant_message_outbox(customer_id,lead_id,created_at DESC,message_id);
