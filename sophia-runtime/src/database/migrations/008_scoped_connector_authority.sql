CREATE TABLE IF NOT EXISTS __SOPHIA_RUNTIME_SCHEMA__.connector_bindings (
  connector_binding_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES __SOPHIA_RUNTIME_SCHEMA__.customers(customer_id) ON DELETE CASCADE,
  connector_key text NOT NULL,
  external_account_id text NOT NULL,
  credential_ref text NOT NULL,
  allowed_scopes jsonb NOT NULL DEFAULT '[]'::jsonb,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'suspended', 'revoked')),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (customer_id, connector_key, external_account_id)
);

CREATE INDEX IF NOT EXISTS idx_sophia_connector_bindings_customer_status
  ON __SOPHIA_RUNTIME_SCHEMA__.connector_bindings(customer_id, status);

ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.connector_bindings ENABLE ROW LEVEL SECURITY;
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.connector_bindings FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS connector_bindings_tenant_isolation ON __SOPHIA_RUNTIME_SCHEMA__.connector_bindings;
CREATE POLICY connector_bindings_tenant_isolation
  ON __SOPHIA_RUNTIME_SCHEMA__.connector_bindings
  USING (customer_id = NULLIF(current_setting('sophia.tenant_id', true), '')::uuid)
  WITH CHECK (customer_id = NULLIF(current_setting('sophia.tenant_id', true), '')::uuid);
