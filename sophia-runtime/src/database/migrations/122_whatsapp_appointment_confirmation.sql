-- Conversation-bound appointment offers. A model may ask this boundary for
-- availability, but only an exact customer selection and confirmation code can
-- create an appointment through the shared scheduling transaction path.
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.assistant_reply_jobs
 ADD COLUMN response_kind text NOT NULL DEFAULT 'grounded_answer'
 CHECK(response_kind IN ('grounded_answer','appointment'));
CREATE TABLE __SOPHIA_RUNTIME_SCHEMA__.lead_appointment_offers (
 offer_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),customer_id uuid NOT NULL,
 channel_id uuid NOT NULL,lead_id uuid NOT NULL,conversation_id uuid NOT NULL,
 source_event_id bigint NOT NULL,reply_job_id uuid NOT NULL,ownership_version integer NOT NULL,
 advisor_identity text NOT NULL,customer_timezone text NOT NULL,
 calendar_revision integer NOT NULL CHECK(calendar_revision>0),
 slots jsonb NOT NULL CHECK(jsonb_typeof(slots)='array' AND jsonb_array_length(slots) BETWEEN 1 AND 3),
 selected_starts_at timestamptz,confirmation_code_hash text,confirmation_attempts integer NOT NULL DEFAULT 0 CHECK(confirmation_attempts BETWEEN 0 AND 5),
 status text NOT NULL DEFAULT 'offered' CHECK(status IN ('offered','awaiting_confirmation','confirmed','expired','cancelled')),
 appointment_id uuid,expires_at timestamptz NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(customer_id,offer_id),UNIQUE(customer_id,conversation_id,source_event_id),
 FOREIGN KEY(customer_id,channel_id) REFERENCES __SOPHIA_RUNTIME_SCHEMA__.assistant_channels(customer_id,channel_id),
 FOREIGN KEY(customer_id,lead_id) REFERENCES __SOPHIA_RUNTIME_SCHEMA__.assistant_leads(customer_id,lead_id),
 FOREIGN KEY(customer_id,conversation_id) REFERENCES __SOPHIA_RUNTIME_SCHEMA__.assistant_lead_conversations(customer_id,conversation_id),
 FOREIGN KEY(customer_id,conversation_id,source_event_id) REFERENCES __SOPHIA_RUNTIME_SCHEMA__.assistant_lead_events(customer_id,conversation_id,event_id),
 FOREIGN KEY(customer_id,reply_job_id) REFERENCES __SOPHIA_RUNTIME_SCHEMA__.assistant_reply_jobs(customer_id,job_id),
 FOREIGN KEY(customer_id,advisor_identity) REFERENCES __SOPHIA_RUNTIME_SCHEMA__.lead_advisor_calendars(customer_id,advisor_identity),
 FOREIGN KEY(customer_id,appointment_id) REFERENCES __SOPHIA_RUNTIME_SCHEMA__.lead_appointments(customer_id,appointment_id),
 CHECK((status='confirmed')=(appointment_id IS NOT NULL)),
 CHECK(status NOT IN ('awaiting_confirmation','confirmed') OR (selected_starts_at IS NOT NULL AND confirmation_code_hash IS NOT NULL))
);
CREATE INDEX lead_appointment_offers_active ON __SOPHIA_RUNTIME_SCHEMA__.lead_appointment_offers(customer_id,conversation_id,created_at DESC)
 WHERE status IN ('offered','awaiting_confirmation');
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.assistant_message_outbox
 ADD COLUMN appointment_offer_id uuid,
 ADD CONSTRAINT assistant_message_outbox_appointment_offer_fk
 FOREIGN KEY(customer_id,appointment_offer_id) REFERENCES __SOPHIA_RUNTIME_SCHEMA__.lead_appointment_offers(customer_id,offer_id);
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.lead_appointment_offers ENABLE ROW LEVEL SECURITY;
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.lead_appointment_offers FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON __SOPHIA_RUNTIME_SCHEMA__.lead_appointment_offers
 USING(customer_id=NULLIF(current_setting('sophia.tenant_id',true),'')::uuid)
 WITH CHECK(customer_id=NULLIF(current_setting('sophia.tenant_id',true),'')::uuid);
REVOKE ALL ON __SOPHIA_RUNTIME_SCHEMA__.lead_appointment_offers FROM sophia_runtime_app;
GRANT SELECT,INSERT,UPDATE ON __SOPHIA_RUNTIME_SCHEMA__.lead_appointment_offers TO sophia_runtime_app;

CREATE FUNCTION __SOPHIA_RUNTIME_SCHEMA__.cancel_stale_appointment_offers() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 UPDATE __SOPHIA_RUNTIME_SCHEMA__.lead_appointment_offers SET status='cancelled',updated_at=now()
 WHERE customer_id=NEW.customer_id AND conversation_id=NEW.conversation_id
 AND ownership_version<>NEW.ownership_version AND status IN ('offered','awaiting_confirmation');
 RETURN NEW;
END $$;
CREATE TRIGGER cancel_stale_appointment_offers AFTER UPDATE OF ownership_version
 ON __SOPHIA_RUNTIME_SCHEMA__.assistant_lead_conversations FOR EACH ROW
 EXECUTE FUNCTION __SOPHIA_RUNTIME_SCHEMA__.cancel_stale_appointment_offers();
