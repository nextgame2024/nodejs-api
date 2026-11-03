-- Conversation-bound customer cancellation and rescheduling requests. The
-- appointment identity and version are selected by the server; only an exact
-- customer confirmation can invoke the shared appointment mutation path.
CREATE TABLE __SOPHIA_RUNTIME_SCHEMA__.lead_appointment_change_requests (
 request_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),customer_id uuid NOT NULL,
 channel_id uuid NOT NULL,lead_id uuid NOT NULL,conversation_id uuid NOT NULL,
 source_event_id bigint NOT NULL,reply_job_id uuid NOT NULL,ownership_version integer NOT NULL,
 appointment_id uuid NOT NULL,expected_version integer NOT NULL CHECK(expected_version>0),
 action text NOT NULL CHECK(action IN ('reschedule','cancel')),
 advisor_identity text NOT NULL,customer_timezone text NOT NULL,
 calendar_revision integer CHECK(calendar_revision IS NULL OR calendar_revision>0),
 slots jsonb NOT NULL DEFAULT '[]'::jsonb CHECK(jsonb_typeof(slots)='array' AND jsonb_array_length(slots) BETWEEN 0 AND 3),
 selected_starts_at timestamptz,confirmation_code_hash text,
 confirmation_attempts integer NOT NULL DEFAULT 0 CHECK(confirmation_attempts BETWEEN 0 AND 5),
 status text NOT NULL CHECK(status IN ('offered','awaiting_confirmation','confirmed','expired','cancelled')),
 expires_at timestamptz NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(customer_id,request_id),UNIQUE(customer_id,conversation_id,source_event_id),
 FOREIGN KEY(customer_id,channel_id) REFERENCES __SOPHIA_RUNTIME_SCHEMA__.assistant_channels(customer_id,channel_id),
 FOREIGN KEY(customer_id,lead_id) REFERENCES __SOPHIA_RUNTIME_SCHEMA__.assistant_leads(customer_id,lead_id),
 FOREIGN KEY(customer_id,conversation_id) REFERENCES __SOPHIA_RUNTIME_SCHEMA__.assistant_lead_conversations(customer_id,conversation_id),
 FOREIGN KEY(customer_id,conversation_id,source_event_id) REFERENCES __SOPHIA_RUNTIME_SCHEMA__.assistant_lead_events(customer_id,conversation_id,event_id),
 FOREIGN KEY(customer_id,reply_job_id) REFERENCES __SOPHIA_RUNTIME_SCHEMA__.assistant_reply_jobs(customer_id,job_id),
 FOREIGN KEY(customer_id,appointment_id) REFERENCES __SOPHIA_RUNTIME_SCHEMA__.lead_appointments(customer_id,appointment_id),
 FOREIGN KEY(customer_id,advisor_identity) REFERENCES __SOPHIA_RUNTIME_SCHEMA__.lead_advisor_calendars(customer_id,advisor_identity),
 CHECK((action='cancel' AND status<>'offered' AND jsonb_array_length(slots)=0 AND calendar_revision IS NULL)
    OR (action='reschedule' AND jsonb_array_length(slots)>0 AND calendar_revision IS NOT NULL)),
 CHECK(status NOT IN ('awaiting_confirmation','confirmed') OR confirmation_code_hash IS NOT NULL),
 CHECK(action<>'reschedule' OR status NOT IN ('awaiting_confirmation','confirmed') OR selected_starts_at IS NOT NULL)
);
CREATE INDEX lead_appointment_change_requests_active
 ON __SOPHIA_RUNTIME_SCHEMA__.lead_appointment_change_requests(customer_id,conversation_id,created_at DESC)
 WHERE status IN ('offered','awaiting_confirmation');
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.assistant_message_outbox
 ADD COLUMN appointment_change_request_id uuid,
 ADD CONSTRAINT assistant_message_outbox_appointment_change_fk
 FOREIGN KEY(customer_id,appointment_change_request_id)
 REFERENCES __SOPHIA_RUNTIME_SCHEMA__.lead_appointment_change_requests(customer_id,request_id);
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.lead_appointment_change_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.lead_appointment_change_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON __SOPHIA_RUNTIME_SCHEMA__.lead_appointment_change_requests
 USING(customer_id=NULLIF(current_setting('sophia.tenant_id',true),'')::uuid)
 WITH CHECK(customer_id=NULLIF(current_setting('sophia.tenant_id',true),'')::uuid);
REVOKE ALL ON __SOPHIA_RUNTIME_SCHEMA__.lead_appointment_change_requests FROM sophia_runtime_app;
GRANT SELECT,INSERT,UPDATE ON __SOPHIA_RUNTIME_SCHEMA__.lead_appointment_change_requests TO sophia_runtime_app;

CREATE FUNCTION __SOPHIA_RUNTIME_SCHEMA__.cancel_stale_appointment_change_requests() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 UPDATE __SOPHIA_RUNTIME_SCHEMA__.lead_appointment_change_requests SET status='cancelled',updated_at=now()
 WHERE customer_id=NEW.customer_id AND conversation_id=NEW.conversation_id
 AND ownership_version<>NEW.ownership_version AND status IN ('offered','awaiting_confirmation');
 RETURN NEW;
END $$;
CREATE TRIGGER cancel_stale_appointment_change_requests AFTER UPDATE OF ownership_version
 ON __SOPHIA_RUNTIME_SCHEMA__.assistant_lead_conversations FOR EACH ROW
 EXECUTE FUNCTION __SOPHIA_RUNTIME_SCHEMA__.cancel_stale_appointment_change_requests();
