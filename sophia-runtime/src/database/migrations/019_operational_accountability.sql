ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.sessions
  DROP CONSTRAINT IF EXISTS sessions_id_customer_unique;
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.sessions
  ADD CONSTRAINT sessions_id_customer_unique UNIQUE (session_id, customer_id);

CREATE TABLE IF NOT EXISTS __SOPHIA_RUNTIME_SCHEMA__.provider_usage_events (
  usage_event_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES __SOPHIA_RUNTIME_SCHEMA__.customers(customer_id) ON DELETE CASCADE,
  session_id uuid,
  source_event_id text NOT NULL CHECK (length(source_event_id) BETWEEN 1 AND 240),
  provider_id text NOT NULL CHECK (length(provider_id) BETWEEN 1 AND 120),
  adapter_key text NOT NULL CHECK (length(adapter_key) BETWEEN 1 AND 120),
  measurement_status text NOT NULL
    CHECK (measurement_status IN ('incomplete', 'estimated', 'measured')),
  usage_dimensions jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(usage_dimensions) = 'object'),
  estimated_cost_microunits bigint CHECK (estimated_cost_microunits IS NULL OR estimated_cost_microunits >= 0),
  cost_currency text CHECK (cost_currency IS NULL OR cost_currency ~ '^[A-Z]{3}$'),
  cost_table_version text,
  source_digest text NOT NULL CHECK (source_digest ~ '^[a-f0-9]{64}$'),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  occurred_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  reconciled_at timestamptz,
  FOREIGN KEY (session_id, customer_id)
    REFERENCES __SOPHIA_RUNTIME_SCHEMA__.sessions(session_id, customer_id) ON DELETE SET NULL (session_id),
  UNIQUE (customer_id, source_event_id),
  CHECK ((estimated_cost_microunits IS NULL AND cost_currency IS NULL AND cost_table_version IS NULL)
    OR (estimated_cost_microunits IS NOT NULL AND cost_currency IS NOT NULL
      AND cost_table_version IS NOT NULL AND length(cost_table_version) > 0))
);

CREATE INDEX IF NOT EXISTS idx_provider_usage_customer_occurred
  ON __SOPHIA_RUNTIME_SCHEMA__.provider_usage_events(customer_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_provider_usage_incomplete
  ON __SOPHIA_RUNTIME_SCHEMA__.provider_usage_events(customer_id, measurement_status, occurred_at)
  WHERE measurement_status <> 'measured';

CREATE OR REPLACE FUNCTION __SOPHIA_RUNTIME_SCHEMA__.protect_provider_usage_identity()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.customer_id IS DISTINCT FROM OLD.customer_id
     OR NEW.session_id IS DISTINCT FROM OLD.session_id
     OR NEW.source_event_id IS DISTINCT FROM OLD.source_event_id
     OR NEW.provider_id IS DISTINCT FROM OLD.provider_id
     OR NEW.adapter_key IS DISTINCT FROM OLD.adapter_key
     OR NEW.occurred_at IS DISTINCT FROM OLD.occurred_at
     OR NEW.recorded_at IS DISTINCT FROM OLD.recorded_at THEN
    RAISE EXCEPTION 'Provider usage event identity is immutable';
  END IF;
  IF OLD.measurement_status = 'measured' AND NEW.measurement_status <> 'measured' THEN
    RAISE EXCEPTION 'Measured usage cannot become incomplete or estimated';
  END IF;
  IF OLD.measurement_status = 'estimated' AND NEW.measurement_status = 'incomplete' THEN
    RAISE EXCEPTION 'Estimated usage cannot become incomplete';
  END IF;
  IF NEW.revision <> OLD.revision + 1 THEN
    RAISE EXCEPTION 'Provider usage reconciliation must increment revision exactly once';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS protect_provider_usage_identity
  ON __SOPHIA_RUNTIME_SCHEMA__.provider_usage_events;
CREATE TRIGGER protect_provider_usage_identity
  BEFORE UPDATE ON __SOPHIA_RUNTIME_SCHEMA__.provider_usage_events
  FOR EACH ROW EXECUTE FUNCTION __SOPHIA_RUNTIME_SCHEMA__.protect_provider_usage_identity();

ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.provider_usage_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.provider_usage_events FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS provider_usage_events_tenant_isolation
  ON __SOPHIA_RUNTIME_SCHEMA__.provider_usage_events;
CREATE POLICY provider_usage_events_tenant_isolation
  ON __SOPHIA_RUNTIME_SCHEMA__.provider_usage_events
  USING (customer_id = NULLIF(current_setting('sophia.tenant_id', true), '')::uuid)
  WITH CHECK (customer_id = NULLIF(current_setting('sophia.tenant_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON __SOPHIA_RUNTIME_SCHEMA__.provider_usage_events TO sophia_runtime_app;
