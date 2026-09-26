ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.sessions
  ADD COLUMN IF NOT EXISTS last_seen_at timestamptz,
  ADD COLUMN IF NOT EXISTS disconnect_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS hard_expires_at timestamptz;

UPDATE __SOPHIA_RUNTIME_SCHEMA__.sessions
SET last_seen_at = COALESCE(last_seen_at, started_at),
    disconnect_expires_at = COALESCE(disconnect_expires_at, started_at + interval '15 minutes'),
    hard_expires_at = COALESCE(hard_expires_at, started_at + interval '2 hours')
WHERE last_seen_at IS NULL OR disconnect_expires_at IS NULL OR hard_expires_at IS NULL;

ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.sessions
  DROP CONSTRAINT IF EXISTS sessions_status_check;
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.sessions
  ADD CONSTRAINT sessions_status_check
  CHECK (status IN ('created', 'active', 'closing', 'cleanup_pending', 'closed', 'failed'));

CREATE TABLE IF NOT EXISTS __SOPHIA_RUNTIME_SCHEMA__.provider_catalog_deployments (
  deployment_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES __SOPHIA_RUNTIME_SCHEMA__.customers(customer_id) ON DELETE CASCADE,
  environment_key text NOT NULL,
  provider_key text NOT NULL,
  catalog_version text NOT NULL,
  catalog_digest text NOT NULL,
  provider_resource_id text NOT NULL,
  status text NOT NULL DEFAULT 'provisioning'
    CHECK (status IN ('provisioning', 'active', 'retired', 'failed')),
  resource_ids jsonb NOT NULL DEFAULT '{}'::jsonb,
  operation_lease_until timestamptz,
  last_error text,
  activated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (customer_id, environment_key, provider_key, catalog_version)
);

CREATE TABLE IF NOT EXISTS __SOPHIA_RUNTIME_SCHEMA__.provider_resource_owners (
  environment_key text NOT NULL,
  provider_key text NOT NULL,
  provider_resource_id text NOT NULL,
  customer_id uuid NOT NULL REFERENCES __SOPHIA_RUNTIME_SCHEMA__.customers(customer_id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (environment_key, provider_key, provider_resource_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_sophia_provider_catalog_active
  ON __SOPHIA_RUNTIME_SCHEMA__.provider_catalog_deployments(customer_id, environment_key, provider_key)
  WHERE status = 'active';

CREATE TABLE IF NOT EXISTS __SOPHIA_RUNTIME_SCHEMA__.provider_session_allocations (
  allocation_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES __SOPHIA_RUNTIME_SCHEMA__.customers(customer_id) ON DELETE CASCADE,
  session_id uuid UNIQUE REFERENCES __SOPHIA_RUNTIME_SCHEMA__.sessions(session_id) ON DELETE SET NULL,
  lifecycle_adapter_key text NOT NULL,
  experience_key text NOT NULL,
  stage text NOT NULL DEFAULT 'allocating'
    CHECK (stage IN ('allocating', 'allocated', 'attached', 'cleanup_pending', 'cleaning', 'released', 'failed')),
  provider_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  cleanup_after timestamptz NOT NULL,
  cleanup_attempts integer NOT NULL DEFAULT 0 CHECK (cleanup_attempts >= 0),
  cleanup_lease_owner text,
  cleanup_lease_until timestamptz,
  last_error_code text,
  last_error_message text,
  allocated_at timestamptz,
  attached_at timestamptz,
  released_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sophia_provider_allocations_cleanup
  ON __SOPHIA_RUNTIME_SCHEMA__.provider_session_allocations(stage, cleanup_after, cleanup_lease_until);

ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.tool_calls
  ADD COLUMN IF NOT EXISTS event_source text NOT NULL DEFAULT 'browser'
    CHECK (event_source IN ('browser', 'provider_sideband')),
  ADD COLUMN IF NOT EXISTS provider_event_id text,
  ADD COLUMN IF NOT EXISTS deduplication_key text,
  ADD COLUMN IF NOT EXISTS execution_owner text NOT NULL DEFAULT 'sophia-runtime';

UPDATE __SOPHIA_RUNTIME_SCHEMA__.tool_calls
SET deduplication_key = 'provider:' || provider_call_id
WHERE deduplication_key IS NULL AND provider_call_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_sophia_tool_call_event_owner
  ON __SOPHIA_RUNTIME_SCHEMA__.tool_calls(session_id, deduplication_key)
  WHERE deduplication_key IS NOT NULL;

ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.provider_catalog_deployments ENABLE ROW LEVEL SECURITY;
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.provider_catalog_deployments FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS provider_catalog_deployments_tenant_isolation
  ON __SOPHIA_RUNTIME_SCHEMA__.provider_catalog_deployments;
CREATE POLICY provider_catalog_deployments_tenant_isolation
  ON __SOPHIA_RUNTIME_SCHEMA__.provider_catalog_deployments
  USING (customer_id = NULLIF(current_setting('sophia.tenant_id', true), '')::uuid)
  WITH CHECK (customer_id = NULLIF(current_setting('sophia.tenant_id', true), '')::uuid);

ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.provider_resource_owners ENABLE ROW LEVEL SECURITY;
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.provider_resource_owners FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS provider_resource_owners_tenant_isolation
  ON __SOPHIA_RUNTIME_SCHEMA__.provider_resource_owners;
CREATE POLICY provider_resource_owners_tenant_isolation
  ON __SOPHIA_RUNTIME_SCHEMA__.provider_resource_owners
  USING (customer_id = NULLIF(current_setting('sophia.tenant_id', true), '')::uuid)
  WITH CHECK (customer_id = NULLIF(current_setting('sophia.tenant_id', true), '')::uuid);

ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.provider_session_allocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.provider_session_allocations FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS provider_session_allocations_tenant_isolation
  ON __SOPHIA_RUNTIME_SCHEMA__.provider_session_allocations;
CREATE POLICY provider_session_allocations_tenant_isolation
  ON __SOPHIA_RUNTIME_SCHEMA__.provider_session_allocations
  USING (customer_id = NULLIF(current_setting('sophia.tenant_id', true), '')::uuid)
  WITH CHECK (customer_id = NULLIF(current_setting('sophia.tenant_id', true), '')::uuid);
