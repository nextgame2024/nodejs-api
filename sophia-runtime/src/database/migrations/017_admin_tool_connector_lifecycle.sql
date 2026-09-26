ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.connector_bindings
  DROP CONSTRAINT IF EXISTS connector_bindings_status_check;
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.connector_bindings
  ADD CONSTRAINT connector_bindings_status_check
  CHECK (status IN ('draft', 'active', 'suspended', 'disconnecting', 'revoked'));

ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.connector_bindings
  ADD COLUMN IF NOT EXISTS health_status text NOT NULL DEFAULT 'unknown',
  ADD COLUMN IF NOT EXISTS health_checked_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_error_code text,
  ADD COLUMN IF NOT EXISTS disconnected_at timestamptz;

ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.connector_bindings
  DROP CONSTRAINT IF EXISTS connector_bindings_health_status_check;
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.connector_bindings
  ADD CONSTRAINT connector_bindings_health_status_check
  CHECK (health_status IN ('unknown', 'healthy', 'unhealthy'));

ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.capability_bindings
  ADD COLUMN IF NOT EXISTS connector_binding_id uuid
    REFERENCES __SOPHIA_RUNTIME_SCHEMA__.connector_bindings(connector_binding_id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS revision integer NOT NULL DEFAULT 1;

ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.capability_bindings
  DROP CONSTRAINT IF EXISTS capability_bindings_revision_check;
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.capability_bindings
  ADD CONSTRAINT capability_bindings_revision_check CHECK (revision > 0);

CREATE INDEX IF NOT EXISTS idx_sophia_capability_bindings_connector
  ON __SOPHIA_RUNTIME_SCHEMA__.capability_bindings(connector_binding_id)
  WHERE connector_binding_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS __SOPHIA_RUNTIME_SCHEMA__.connector_binding_events (
  connector_binding_event_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES __SOPHIA_RUNTIME_SCHEMA__.customers(customer_id) ON DELETE CASCADE,
  connector_binding_id uuid NOT NULL REFERENCES __SOPHIA_RUNTIME_SCHEMA__.connector_bindings(connector_binding_id) ON DELETE RESTRICT,
  event_type text NOT NULL CHECK (event_type IN ('connected', 'tested', 'reconnected', 'disconnect_requested', 'disconnected')),
  status text NOT NULL,
  unresolved_command_count integer NOT NULL DEFAULT 0 CHECK (unresolved_command_count >= 0),
  created_by_identity text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sophia_connector_binding_events_binding
  ON __SOPHIA_RUNTIME_SCHEMA__.connector_binding_events(customer_id, connector_binding_id, created_at DESC);

ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.connector_binding_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.connector_binding_events FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS connector_binding_events_tenant_isolation ON __SOPHIA_RUNTIME_SCHEMA__.connector_binding_events;
CREATE POLICY connector_binding_events_tenant_isolation
  ON __SOPHIA_RUNTIME_SCHEMA__.connector_binding_events
  USING (customer_id = NULLIF(current_setting('sophia.tenant_id', true), '')::uuid)
  WITH CHECK (customer_id = NULLIF(current_setting('sophia.tenant_id', true), '')::uuid);
