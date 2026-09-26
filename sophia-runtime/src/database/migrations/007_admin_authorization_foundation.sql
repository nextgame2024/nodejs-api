CREATE TABLE IF NOT EXISTS __SOPHIA_RUNTIME_SCHEMA__.admin_memberships (
  membership_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES __SOPHIA_RUNTIME_SCHEMA__.customers(customer_id) ON DELETE CASCADE,
  identity_user_id text NOT NULL,
  role_key text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'revoked')),
  permission_overrides jsonb NOT NULL DEFAULT '{"allow":[],"deny":[]}'::jsonb,
  authorization_revision integer NOT NULL DEFAULT 1 CHECK (authorization_revision > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (customer_id, identity_user_id)
);

CREATE INDEX IF NOT EXISTS idx_sophia_admin_memberships_identity
  ON __SOPHIA_RUNTIME_SCHEMA__.admin_memberships(identity_user_id, status);

CREATE TABLE IF NOT EXISTS __SOPHIA_RUNTIME_SCHEMA__.admin_audit_events (
  audit_event_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid REFERENCES __SOPHIA_RUNTIME_SCHEMA__.customers(customer_id) ON DELETE SET NULL,
  identity_user_id text,
  event_type text NOT NULL,
  resource_type text,
  resource_id text,
  permission_key text,
  outcome text NOT NULL CHECK (outcome IN ('allowed', 'denied', 'failed')),
  correlation_id text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sophia_admin_audit_tenant_created
  ON __SOPHIA_RUNTIME_SCHEMA__.admin_audit_events(customer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sophia_admin_audit_actor_created
  ON __SOPHIA_RUNTIME_SCHEMA__.admin_audit_events(identity_user_id, created_at DESC);
