CREATE TABLE __SOPHIA_RUNTIME_SCHEMA__.appointment_email_outbox (
 customer_id uuid NOT NULL,
 appointment_id uuid NOT NULL,
 appointment_version integer NOT NULL,
 recipient text NOT NULL,
 payload jsonb NOT NULL,
 attempts integer NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 5),
 available_at timestamptz NOT NULL DEFAULT now(),
 sent_at timestamptz,
 cancelled_at timestamptz,
 PRIMARY KEY(customer_id,appointment_id,appointment_version,recipient),
 FOREIGN KEY(customer_id,appointment_id) REFERENCES __SOPHIA_RUNTIME_SCHEMA__.lead_appointments(customer_id,appointment_id)
);
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.appointment_email_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.appointment_email_outbox FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON __SOPHIA_RUNTIME_SCHEMA__.appointment_email_outbox USING(customer_id=NULLIF(current_setting('sophia.tenant_id',true),'')::uuid) WITH CHECK(customer_id=NULLIF(current_setting('sophia.tenant_id',true),'')::uuid);
GRANT SELECT,INSERT,UPDATE ON __SOPHIA_RUNTIME_SCHEMA__.appointment_email_outbox TO sophia_runtime_app;
CREATE INDEX appointment_email_pending ON __SOPHIA_RUNTIME_SCHEMA__.appointment_email_outbox(customer_id,available_at) WHERE sent_at IS NULL AND cancelled_at IS NULL;
