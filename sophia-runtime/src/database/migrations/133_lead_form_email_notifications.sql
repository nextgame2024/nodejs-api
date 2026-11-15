ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.lead_forms ADD COLUMN emails text NOT NULL DEFAULT '';
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.lead_form_publications ADD COLUMN emails text NOT NULL DEFAULT '';
CREATE TABLE __SOPHIA_RUNTIME_SCHEMA__.lead_form_email_outbox (
 customer_id uuid NOT NULL REFERENCES __SOPHIA_RUNTIME_SCHEMA__.customers(customer_id),
 submission_id uuid NOT NULL,
 recipient text NOT NULL,
 payload jsonb NOT NULL,
 attempts integer NOT NULL DEFAULT 0,
 available_at timestamptz NOT NULL DEFAULT now(),
 sent_at timestamptz,
 PRIMARY KEY(customer_id,submission_id,recipient),
 FOREIGN KEY(customer_id,submission_id) REFERENCES __SOPHIA_RUNTIME_SCHEMA__.lead_form_submissions(customer_id,id)
);
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.lead_form_email_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.lead_form_email_outbox FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON __SOPHIA_RUNTIME_SCHEMA__.lead_form_email_outbox USING(customer_id=NULLIF(current_setting('sophia.tenant_id',true),'')::uuid) WITH CHECK(customer_id=NULLIF(current_setting('sophia.tenant_id',true),'')::uuid);
GRANT SELECT,INSERT,UPDATE ON __SOPHIA_RUNTIME_SCHEMA__.lead_form_email_outbox TO sophia_runtime_app;
CREATE INDEX lead_form_email_pending ON __SOPHIA_RUNTIME_SCHEMA__.lead_form_email_outbox(customer_id,available_at) WHERE sent_at IS NULL;
