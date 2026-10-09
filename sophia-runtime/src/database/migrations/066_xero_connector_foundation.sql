CREATE TABLE IF NOT EXISTS __SOPHIA_RUNTIME_SCHEMA__.xero_oauth_states (
  state_digest text PRIMARY KEY,
  customer_id uuid NOT NULL REFERENCES __SOPHIA_RUNTIME_SCHEMA__.customers(customer_id) ON DELETE CASCADE,
  identity_user_id text NOT NULL,
  pkce_verifier_ciphertext text NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_xero_oauth_states_customer_expiry
  ON __SOPHIA_RUNTIME_SCHEMA__.xero_oauth_states(customer_id, expires_at DESC);

CREATE TABLE IF NOT EXISTS __SOPHIA_RUNTIME_SCHEMA__.xero_authorizations (
  xero_authorization_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES __SOPHIA_RUNTIME_SCHEMA__.customers(customer_id) ON DELETE CASCADE,
  token_ciphertext text NOT NULL,
  token_expires_at timestamptz NOT NULL,
  granted_scopes jsonb NOT NULL DEFAULT '[]'::jsonb,
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'reauthorization_required', 'revoked', 'replaced')),
  authorized_by_identity text NOT NULL,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_xero_authorizations_customer_status
  ON __SOPHIA_RUNTIME_SCHEMA__.xero_authorizations(customer_id, status);

CREATE TABLE IF NOT EXISTS __SOPHIA_RUNTIME_SCHEMA__.xero_connections (
  xero_connection_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES __SOPHIA_RUNTIME_SCHEMA__.customers(customer_id) ON DELETE CASCADE,
  xero_authorization_id uuid NOT NULL REFERENCES __SOPHIA_RUNTIME_SCHEMA__.xero_authorizations(xero_authorization_id) ON DELETE RESTRICT,
  connector_binding_id uuid NOT NULL REFERENCES __SOPHIA_RUNTIME_SCHEMA__.connector_bindings(connector_binding_id) ON DELETE RESTRICT,
  provider_connection_id text NOT NULL,
  xero_tenant_id text NOT NULL,
  tenant_name text NOT NULL,
  tenant_type text NOT NULL DEFAULT 'ORGANISATION',
  tenant_short_code text,
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'degraded', 'reauthorization_required', 'revoked')),
  last_tested_at timestamptz,
  last_error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (customer_id, provider_connection_id),
  UNIQUE (xero_tenant_id)
);

CREATE INDEX IF NOT EXISTS idx_xero_connections_customer_status
  ON __SOPHIA_RUNTIME_SCHEMA__.xero_connections(customer_id, status);

ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.xero_oauth_states ENABLE ROW LEVEL SECURITY;
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.xero_oauth_states FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS xero_oauth_states_tenant_isolation ON __SOPHIA_RUNTIME_SCHEMA__.xero_oauth_states;
CREATE POLICY xero_oauth_states_tenant_isolation
  ON __SOPHIA_RUNTIME_SCHEMA__.xero_oauth_states
  USING (customer_id = NULLIF(current_setting('sophia.tenant_id', true), '')::uuid)
  WITH CHECK (customer_id = NULLIF(current_setting('sophia.tenant_id', true), '')::uuid);

ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.xero_authorizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.xero_authorizations FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS xero_authorizations_tenant_isolation ON __SOPHIA_RUNTIME_SCHEMA__.xero_authorizations;
CREATE POLICY xero_authorizations_tenant_isolation
  ON __SOPHIA_RUNTIME_SCHEMA__.xero_authorizations
  USING (customer_id = NULLIF(current_setting('sophia.tenant_id', true), '')::uuid)
  WITH CHECK (customer_id = NULLIF(current_setting('sophia.tenant_id', true), '')::uuid);

ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.xero_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.xero_connections FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS xero_connections_tenant_isolation ON __SOPHIA_RUNTIME_SCHEMA__.xero_connections;
CREATE POLICY xero_connections_tenant_isolation
  ON __SOPHIA_RUNTIME_SCHEMA__.xero_connections
  USING (customer_id = NULLIF(current_setting('sophia.tenant_id', true), '')::uuid)
  WITH CHECK (customer_id = NULLIF(current_setting('sophia.tenant_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE ON __SOPHIA_RUNTIME_SCHEMA__.xero_oauth_states TO sophia_runtime_app;
GRANT SELECT, INSERT, UPDATE ON __SOPHIA_RUNTIME_SCHEMA__.xero_authorizations TO sophia_runtime_app;
GRANT SELECT, INSERT, UPDATE ON __SOPHIA_RUNTIME_SCHEMA__.xero_connections TO sophia_runtime_app;

REVOKE DELETE ON __SOPHIA_RUNTIME_SCHEMA__.xero_oauth_states FROM sophia_runtime_app;
REVOKE DELETE ON __SOPHIA_RUNTIME_SCHEMA__.xero_authorizations FROM sophia_runtime_app;
REVOKE DELETE ON __SOPHIA_RUNTIME_SCHEMA__.xero_connections FROM sophia_runtime_app;
