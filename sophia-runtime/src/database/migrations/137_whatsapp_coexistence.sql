CREATE TABLE __SOPHIA_RUNTIME_SCHEMA__.whatsapp_connections (
 customer_id uuid PRIMARY KEY REFERENCES __SOPHIA_RUNTIME_SCHEMA__.customers(customer_id),
 profile_id text NOT NULL UNIQUE,
 business_account_id text NOT NULL,
 phone_number_id text NOT NULL UNIQUE,
 display_phone_number text NOT NULL,
 encrypted_token jsonb,
 actor_identity text NOT NULL,
 state text NOT NULL DEFAULT 'activating' CHECK(state IN ('activating','syncing','ready','attention','disconnected')),
 step text NOT NULL DEFAULT 'subscribe' CHECK(step IN ('subscribe','contacts','history','done')),
 operation_state text NOT NULL DEFAULT 'pending' CHECK(operation_state IN ('pending','running','accepted','uncertain')),
 subscription_request jsonb NOT NULL DEFAULT '{}',
 contacts_request_id text,
 history_request_id text,
 history_progress integer NOT NULL DEFAULT 0 CHECK(history_progress BETWEEN 0 AND 100),
 history_declined boolean NOT NULL DEFAULT false,
 contacts_received boolean NOT NULL DEFAULT false,
 failure_code text,
 operation_started_at timestamptz,
 next_attempt_at timestamptz NOT NULL DEFAULT now(),
 sync_deadline timestamptz NOT NULL DEFAULT now()+interval '24 hours',
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE __SOPHIA_RUNTIME_SCHEMA__.whatsapp_sync_receipts (
 customer_id uuid NOT NULL REFERENCES __SOPHIA_RUNTIME_SCHEMA__.whatsapp_connections(customer_id),
 receipt_key text NOT NULL,
 field text NOT NULL CHECK(field IN ('history','smb_app_state_sync','account_update')),
 encrypted_payload jsonb NOT NULL,
 received_at timestamptz NOT NULL DEFAULT now(),
 processed_at timestamptz,
 processed_items integer NOT NULL DEFAULT 0,
 expires_at timestamptz NOT NULL DEFAULT now()+interval '7 days',
 PRIMARY KEY(customer_id,receipt_key)
);
CREATE TABLE __SOPHIA_RUNTIME_SCHEMA__.whatsapp_imported_contacts (
 customer_id uuid NOT NULL,
 contact_key text NOT NULL,
 display_name text NOT NULL,
 phone text,
 changed_at timestamptz NOT NULL,
 PRIMARY KEY(customer_id,contact_key),
 FOREIGN KEY(customer_id) REFERENCES __SOPHIA_RUNTIME_SCHEMA__.whatsapp_connections(customer_id)
);
CREATE TABLE __SOPHIA_RUNTIME_SCHEMA__.whatsapp_imported_messages (
 customer_id uuid NOT NULL,
 message_id text NOT NULL,
 contact_key text NOT NULL,
 sent_at timestamptz NOT NULL,
 direction text NOT NULL CHECK(direction IN ('inbound','outbound')),
 message_type text NOT NULL,
 body text NOT NULL,
 PRIMARY KEY(customer_id,message_id),
 FOREIGN KEY(customer_id) REFERENCES __SOPHIA_RUNTIME_SCHEMA__.whatsapp_connections(customer_id)
);
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.whatsapp_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.whatsapp_connections FORCE ROW LEVEL SECURITY;
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.whatsapp_sync_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.whatsapp_sync_receipts FORCE ROW LEVEL SECURITY;
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.whatsapp_imported_contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.whatsapp_imported_contacts FORCE ROW LEVEL SECURITY;
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.whatsapp_imported_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.whatsapp_imported_messages FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON __SOPHIA_RUNTIME_SCHEMA__.whatsapp_connections USING(customer_id=NULLIF(current_setting('sophia.tenant_id',true),'')::uuid) WITH CHECK(customer_id=NULLIF(current_setting('sophia.tenant_id',true),'')::uuid);
CREATE POLICY tenant_isolation ON __SOPHIA_RUNTIME_SCHEMA__.whatsapp_sync_receipts USING(customer_id=NULLIF(current_setting('sophia.tenant_id',true),'')::uuid) WITH CHECK(customer_id=NULLIF(current_setting('sophia.tenant_id',true),'')::uuid);
CREATE POLICY tenant_isolation ON __SOPHIA_RUNTIME_SCHEMA__.whatsapp_imported_contacts USING(customer_id=NULLIF(current_setting('sophia.tenant_id',true),'')::uuid) WITH CHECK(customer_id=NULLIF(current_setting('sophia.tenant_id',true),'')::uuid);
CREATE POLICY tenant_isolation ON __SOPHIA_RUNTIME_SCHEMA__.whatsapp_imported_messages USING(customer_id=NULLIF(current_setting('sophia.tenant_id',true),'')::uuid) WITH CHECK(customer_id=NULLIF(current_setting('sophia.tenant_id',true),'')::uuid);
GRANT SELECT,INSERT,UPDATE,DELETE ON __SOPHIA_RUNTIME_SCHEMA__.whatsapp_connections,__SOPHIA_RUNTIME_SCHEMA__.whatsapp_sync_receipts,__SOPHIA_RUNTIME_SCHEMA__.whatsapp_imported_contacts,__SOPHIA_RUNTIME_SCHEMA__.whatsapp_imported_messages TO sophia_runtime_app;
CREATE INDEX whatsapp_sync_receipts_pending ON __SOPHIA_RUNTIME_SCHEMA__.whatsapp_sync_receipts(customer_id,received_at) WHERE processed_at IS NULL;
CREATE UNIQUE INDEX whatsapp_imported_event_once ON __SOPHIA_RUNTIME_SCHEMA__.assistant_lead_events(customer_id,conversation_id,(metadata->>'importedMessageId')) WHERE metadata ? 'importedMessageId';
