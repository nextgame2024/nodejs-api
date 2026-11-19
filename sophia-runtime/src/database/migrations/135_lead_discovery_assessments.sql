-- Internal discovery assessment and a staff-owned follow-up, never a send queue.
CREATE TABLE __SOPHIA_RUNTIME_SCHEMA__.assistant_lead_assessments (
  customer_id uuid NOT NULL,
  lead_id uuid NOT NULL,
  facts jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(facts)='object' AND octet_length(facts::text)<=16384),
  assessment jsonb NOT NULL CHECK (jsonb_typeof(assessment)='object' AND octet_length(assessment::text)<=16384),
  conversation_id uuid NOT NULL,
  source_event_id bigint NOT NULL,
  FOREIGN KEY(customer_id,conversation_id,source_event_id) REFERENCES __SOPHIA_RUNTIME_SCHEMA__.assistant_lead_events(customer_id,conversation_id,event_id),
  revision integer NOT NULL DEFAULT 1 CHECK (revision>0),
  follow_up_status text NOT NULL DEFAULT 'pending' CHECK (follow_up_status IN ('pending','completed','dismissed')),
  follow_up_due_at timestamptz NOT NULL,
  follow_up_updated_by text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(customer_id,lead_id),
  FOREIGN KEY(customer_id,lead_id) REFERENCES __SOPHIA_RUNTIME_SCHEMA__.assistant_leads(customer_id,lead_id) ON DELETE CASCADE
);
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.assistant_lead_assessments ENABLE ROW LEVEL SECURITY;
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.assistant_lead_assessments FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON __SOPHIA_RUNTIME_SCHEMA__.assistant_lead_assessments
 USING(customer_id=nullif(current_setting('sophia.tenant_id',true),'')::uuid)
 WITH CHECK(customer_id=nullif(current_setting('sophia.tenant_id',true),'')::uuid);
REVOKE ALL ON __SOPHIA_RUNTIME_SCHEMA__.assistant_lead_assessments FROM sophia_runtime_app;
GRANT SELECT,INSERT,UPDATE ON __SOPHIA_RUNTIME_SCHEMA__.assistant_lead_assessments TO sophia_runtime_app;
CREATE INDEX assistant_lead_assessment_follow_up ON __SOPHIA_RUNTIME_SCHEMA__.assistant_lead_assessments(customer_id,follow_up_due_at,lead_id) WHERE follow_up_status='pending';

CREATE TABLE __SOPHIA_RUNTIME_SCHEMA__.assistant_follow_up_requests (
  request_id uuid NOT NULL DEFAULT gen_random_uuid(),customer_id uuid NOT NULL,lead_id uuid NOT NULL,
  conversation_id uuid NOT NULL,channel_id uuid NOT NULL,consent_event_id bigint NOT NULL,
  ownership_version integer NOT NULL,reply_job_id uuid,
  FOREIGN KEY(customer_id,reply_job_id) REFERENCES __SOPHIA_RUNTIME_SCHEMA__.assistant_reply_jobs(customer_id,job_id),
  state text NOT NULL DEFAULT 'scheduled' CHECK(state IN ('scheduled','queued','cancelled')),
  due_at timestamptz NOT NULL DEFAULT now()+interval '2 hours',
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(customer_id,request_id),UNIQUE(customer_id,conversation_id,consent_event_id),
  FOREIGN KEY(customer_id,lead_id) REFERENCES __SOPHIA_RUNTIME_SCHEMA__.assistant_leads(customer_id,lead_id) ON DELETE CASCADE,
  FOREIGN KEY(customer_id,conversation_id,consent_event_id) REFERENCES __SOPHIA_RUNTIME_SCHEMA__.assistant_lead_events(customer_id,conversation_id,event_id),
  FOREIGN KEY(customer_id,channel_id) REFERENCES __SOPHIA_RUNTIME_SCHEMA__.assistant_channels(customer_id,channel_id)
);
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.assistant_follow_up_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.assistant_follow_up_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON __SOPHIA_RUNTIME_SCHEMA__.assistant_follow_up_requests
 USING(customer_id=NULLIF(current_setting('sophia.tenant_id',true),'')::uuid)
 WITH CHECK(customer_id=NULLIF(current_setting('sophia.tenant_id',true),'')::uuid);
REVOKE ALL ON __SOPHIA_RUNTIME_SCHEMA__.assistant_follow_up_requests FROM sophia_runtime_app;
GRANT SELECT,INSERT,UPDATE ON __SOPHIA_RUNTIME_SCHEMA__.assistant_follow_up_requests TO sophia_runtime_app;
CREATE INDEX assistant_follow_up_due ON __SOPHIA_RUNTIME_SCHEMA__.assistant_follow_up_requests(customer_id,channel_id,due_at) WHERE state='scheduled';
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.assistant_message_outbox ADD COLUMN follow_up_request_id uuid;
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.assistant_message_outbox ADD FOREIGN KEY(customer_id,follow_up_request_id)
 REFERENCES __SOPHIA_RUNTIME_SCHEMA__.assistant_follow_up_requests(customer_id,request_id);
CREATE UNIQUE INDEX assistant_follow_up_single_send ON __SOPHIA_RUNTIME_SCHEMA__.assistant_message_outbox(customer_id,follow_up_request_id) WHERE follow_up_request_id IS NOT NULL;
