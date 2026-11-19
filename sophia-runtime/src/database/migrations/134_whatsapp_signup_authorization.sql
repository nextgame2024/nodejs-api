-- Authorization is staged separately from live channel credentials. Completing
-- signup does not change a deployment allowlist or enable automated sending.
CREATE TABLE __SOPHIA_RUNTIME_SCHEMA__.assistant_whatsapp_signup (
 customer_id uuid NOT NULL REFERENCES __SOPHIA_RUNTIME_SCHEMA__.customers(customer_id),
 signup_id uuid NOT NULL,
 actor_identity text NOT NULL,
 nonce_hash text NOT NULL,
 state text NOT NULL CHECK(state IN ('started','exchanging','authorized','verifying','verified','failed')),
 encrypted_token jsonb,
 business_account_id text,
 phone_number_id text,
 display_phone_number text,
 created_at timestamptz NOT NULL DEFAULT now(),
 expires_at timestamptz NOT NULL DEFAULT now()+interval '15 minutes',
 updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(customer_id,signup_id)
);
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.assistant_whatsapp_signup ENABLE ROW LEVEL SECURITY;
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.assistant_whatsapp_signup FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON __SOPHIA_RUNTIME_SCHEMA__.assistant_whatsapp_signup
 USING(customer_id=NULLIF(current_setting('sophia.tenant_id',true),'')::uuid)
 WITH CHECK(customer_id=NULLIF(current_setting('sophia.tenant_id',true),'')::uuid);
REVOKE ALL ON __SOPHIA_RUNTIME_SCHEMA__.assistant_whatsapp_signup FROM sophia_runtime_app;
GRANT SELECT,INSERT,UPDATE,DELETE ON __SOPHIA_RUNTIME_SCHEMA__.assistant_whatsapp_signup TO sophia_runtime_app;
CREATE INDEX assistant_whatsapp_signup_expiry ON __SOPHIA_RUNTIME_SCHEMA__.assistant_whatsapp_signup(customer_id,expires_at);
