CREATE TABLE IF NOT EXISTS __SOPHIA_RUNTIME_SCHEMA__.billing_provider_customers (
  billing_provider_customer_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES __SOPHIA_RUNTIME_SCHEMA__.customers(customer_id) ON DELETE CASCADE,
  provider_key text NOT NULL CHECK (provider_key ~ '^[a-z][a-z0-9-]{1,79}$'),
  provider_environment text NOT NULL CHECK (provider_environment IN ('sandbox', 'live')),
  external_customer_ref text NOT NULL CHECK (length(external_customer_ref) BETWEEN 1 AND 240),
  observed_at timestamptz NOT NULL,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  UNIQUE (customer_id, provider_key, provider_environment),
  UNIQUE (provider_key, provider_environment, external_customer_ref)
);

CREATE TABLE IF NOT EXISTS __SOPHIA_RUNTIME_SCHEMA__.billing_webhook_events (
  billing_webhook_event_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES __SOPHIA_RUNTIME_SCHEMA__.customers(customer_id) ON DELETE CASCADE,
  provider_key text NOT NULL CHECK (provider_key ~ '^[a-z][a-z0-9-]{1,79}$'),
  provider_environment text NOT NULL CHECK (provider_environment IN ('sandbox', 'live')),
  external_event_ref text NOT NULL CHECK (length(external_event_ref) BETWEEN 1 AND 240),
  event_type text NOT NULL CHECK (length(event_type) BETWEEN 1 AND 160),
  payload_digest text NOT NULL CHECK (payload_digest ~ '^[a-f0-9]{64}$'),
  occurred_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  processing_status text NOT NULL CHECK (processing_status IN ('received', 'processed', 'ignored', 'failed')),
  processing_detail text CHECK (processing_detail IS NULL OR length(processing_detail) BETWEEN 1 AND 240),
  processed_at timestamptz,
  UNIQUE (provider_key, provider_environment, external_event_ref),
  CHECK ((processing_status = 'received' AND processed_at IS NULL)
    OR (processing_status <> 'received' AND processed_at IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_billing_webhook_tenant_time
  ON __SOPHIA_RUNTIME_SCHEMA__.billing_webhook_events(customer_id, occurred_at DESC);

ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.billing_provider_customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.billing_provider_customers FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS billing_provider_customers_tenant_isolation
  ON __SOPHIA_RUNTIME_SCHEMA__.billing_provider_customers;
CREATE POLICY billing_provider_customers_tenant_isolation
  ON __SOPHIA_RUNTIME_SCHEMA__.billing_provider_customers
  USING (customer_id = NULLIF(current_setting('sophia.tenant_id', true), '')::uuid)
  WITH CHECK (customer_id = NULLIF(current_setting('sophia.tenant_id', true), '')::uuid);

ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.billing_webhook_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.billing_webhook_events FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS billing_webhook_events_tenant_isolation
  ON __SOPHIA_RUNTIME_SCHEMA__.billing_webhook_events;
CREATE POLICY billing_webhook_events_tenant_isolation
  ON __SOPHIA_RUNTIME_SCHEMA__.billing_webhook_events
  USING (customer_id = NULLIF(current_setting('sophia.tenant_id', true), '')::uuid)
  WITH CHECK (customer_id = NULLIF(current_setting('sophia.tenant_id', true), '')::uuid);

CREATE OR REPLACE FUNCTION __SOPHIA_RUNTIME_SCHEMA__.resolve_billing_customer_tenant(
  requested_provider_key text,
  requested_provider_environment text,
  requested_external_customer_ref text
) RETURNS uuid
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = pg_catalog, __SOPHIA_RUNTIME_SCHEMA__
AS $$
  SELECT customer_id
  FROM __SOPHIA_RUNTIME_SCHEMA__.billing_provider_customers
  WHERE provider_key = requested_provider_key
    AND provider_environment = requested_provider_environment
    AND external_customer_ref = requested_external_customer_ref
  LIMIT 1
$$;

REVOKE ALL ON FUNCTION __SOPHIA_RUNTIME_SCHEMA__.resolve_billing_customer_tenant(text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION __SOPHIA_RUNTIME_SCHEMA__.resolve_billing_customer_tenant(text, text, text) TO sophia_runtime_app;

REVOKE ALL ON __SOPHIA_RUNTIME_SCHEMA__.billing_provider_customers FROM sophia_runtime_app;
REVOKE ALL ON __SOPHIA_RUNTIME_SCHEMA__.billing_webhook_events FROM sophia_runtime_app;
GRANT SELECT, INSERT, UPDATE ON __SOPHIA_RUNTIME_SCHEMA__.billing_provider_customers TO sophia_runtime_app;
GRANT SELECT, INSERT, UPDATE ON __SOPHIA_RUNTIME_SCHEMA__.billing_webhook_events TO sophia_runtime_app;
GRANT INSERT, UPDATE ON __SOPHIA_RUNTIME_SCHEMA__.billing_subscription_references TO sophia_runtime_app;
GRANT INSERT, UPDATE ON __SOPHIA_RUNTIME_SCHEMA__.billing_invoice_references TO sophia_runtime_app;
