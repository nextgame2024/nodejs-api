CREATE TABLE IF NOT EXISTS __SOPHIA_RUNTIME_SCHEMA__.tenant_usage_guardrails (
  customer_id uuid PRIMARY KEY REFERENCES __SOPHIA_RUNTIME_SCHEMA__.customers(customer_id) ON DELETE CASCADE,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  max_concurrent_sessions integer CHECK (max_concurrent_sessions IS NULL OR max_concurrent_sessions > 0),
  max_tool_calls_per_minute integer CHECK (max_tool_calls_per_minute IS NULL OR max_tool_calls_per_minute > 0),
  provider_cost_alert_microunits bigint CHECK (provider_cost_alert_microunits IS NULL OR provider_cost_alert_microunits > 0),
  provider_cost_alert_currency text CHECK (provider_cost_alert_currency IS NULL OR provider_cost_alert_currency ~ '^[A-Z]{3}$'),
  updated_by_identity text NOT NULL CHECK (length(updated_by_identity) BETWEEN 1 AND 240),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((provider_cost_alert_microunits IS NULL) = (provider_cost_alert_currency IS NULL))
);

CREATE TABLE IF NOT EXISTS __SOPHIA_RUNTIME_SCHEMA__.tool_admission_reservations (
  tool_admission_reservation_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invocation_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  session_id uuid NOT NULL,
  deduplication_key text,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '2 minutes'),
  FOREIGN KEY (session_id, customer_id)
    REFERENCES __SOPHIA_RUNTIME_SCHEMA__.sessions(session_id, customer_id) ON DELETE CASCADE,
  UNIQUE (invocation_id, customer_id),
  CHECK (expires_at > created_at)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_tool_admission_provider_deduplication
  ON __SOPHIA_RUNTIME_SCHEMA__.tool_admission_reservations(customer_id, session_id, deduplication_key)
  WHERE deduplication_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tool_admission_recent
  ON __SOPHIA_RUNTIME_SCHEMA__.tool_admission_reservations(customer_id, session_id, created_at DESC);

ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.tenant_usage_guardrails ENABLE ROW LEVEL SECURITY;
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.tenant_usage_guardrails FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_usage_guardrails_tenant_isolation
  ON __SOPHIA_RUNTIME_SCHEMA__.tenant_usage_guardrails;
CREATE POLICY tenant_usage_guardrails_tenant_isolation
  ON __SOPHIA_RUNTIME_SCHEMA__.tenant_usage_guardrails
  USING (customer_id = NULLIF(current_setting('sophia.tenant_id', true), '')::uuid)
  WITH CHECK (customer_id = NULLIF(current_setting('sophia.tenant_id', true), '')::uuid);

ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.tool_admission_reservations ENABLE ROW LEVEL SECURITY;
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.tool_admission_reservations FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tool_admission_reservations_tenant_isolation
  ON __SOPHIA_RUNTIME_SCHEMA__.tool_admission_reservations;
CREATE POLICY tool_admission_reservations_tenant_isolation
  ON __SOPHIA_RUNTIME_SCHEMA__.tool_admission_reservations
  USING (customer_id = NULLIF(current_setting('sophia.tenant_id', true), '')::uuid)
  WITH CHECK (customer_id = NULLIF(current_setting('sophia.tenant_id', true), '')::uuid);

REVOKE ALL ON __SOPHIA_RUNTIME_SCHEMA__.tenant_usage_guardrails FROM sophia_runtime_app;
REVOKE ALL ON __SOPHIA_RUNTIME_SCHEMA__.tool_admission_reservations FROM sophia_runtime_app;
GRANT SELECT, INSERT, UPDATE ON __SOPHIA_RUNTIME_SCHEMA__.tenant_usage_guardrails TO sophia_runtime_app;
GRANT SELECT, INSERT, DELETE ON __SOPHIA_RUNTIME_SCHEMA__.tool_admission_reservations TO sophia_runtime_app;
