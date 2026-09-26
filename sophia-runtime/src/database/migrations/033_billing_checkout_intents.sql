CREATE TABLE IF NOT EXISTS __SOPHIA_RUNTIME_SCHEMA__.billing_checkout_intents (
  billing_checkout_intent_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES __SOPHIA_RUNTIME_SCHEMA__.customers(customer_id) ON DELETE CASCADE,
  provider_key text NOT NULL CHECK (provider_key ~ '^[a-z][a-z0-9-]{1,79}$'),
  provider_environment text NOT NULL CHECK (provider_environment IN ('sandbox', 'live')),
  request_id uuid NOT NULL,
  commercial_plan_version_id uuid NOT NULL REFERENCES __SOPHIA_RUNTIME_SCHEMA__.commercial_plan_versions(commercial_plan_version_id) ON DELETE RESTRICT,
  external_checkout_ref text NOT NULL CHECK (length(external_checkout_ref) BETWEEN 1 AND 240),
  status text NOT NULL CHECK (status IN ('created', 'completed', 'expired')),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL CHECK (expires_at > created_at),
  completed_at timestamptz,
  UNIQUE (customer_id, provider_key, provider_environment, request_id),
  UNIQUE (provider_key, provider_environment, external_checkout_ref),
  CHECK ((status = 'created' AND completed_at IS NULL) OR (status <> 'created' AND completed_at IS NOT NULL))
);

ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.billing_checkout_intents ENABLE ROW LEVEL SECURITY;
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.billing_checkout_intents FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS billing_checkout_intents_tenant_isolation
  ON __SOPHIA_RUNTIME_SCHEMA__.billing_checkout_intents;
CREATE POLICY billing_checkout_intents_tenant_isolation
  ON __SOPHIA_RUNTIME_SCHEMA__.billing_checkout_intents
  USING (customer_id = NULLIF(current_setting('sophia.tenant_id', true), '')::uuid)
  WITH CHECK (customer_id = NULLIF(current_setting('sophia.tenant_id', true), '')::uuid);

CREATE OR REPLACE FUNCTION __SOPHIA_RUNTIME_SCHEMA__.protect_billing_checkout_intent()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.customer_id <> OLD.customer_id OR NEW.provider_key <> OLD.provider_key
    OR NEW.provider_environment <> OLD.provider_environment OR NEW.request_id <> OLD.request_id
    OR NEW.commercial_plan_version_id <> OLD.commercial_plan_version_id
    OR NEW.external_checkout_ref <> OLD.external_checkout_ref OR NEW.created_at <> OLD.created_at
    OR NEW.expires_at <> OLD.expires_at THEN
    RAISE EXCEPTION 'Billing Checkout intent identity is immutable';
  END IF;
  IF OLD.status <> 'created' OR NEW.status NOT IN ('completed', 'expired') OR NEW.completed_at IS NULL THEN
    RAISE EXCEPTION 'Billing Checkout intent has an invalid transition';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS protect_billing_checkout_intent
  ON __SOPHIA_RUNTIME_SCHEMA__.billing_checkout_intents;
CREATE TRIGGER protect_billing_checkout_intent BEFORE UPDATE
  ON __SOPHIA_RUNTIME_SCHEMA__.billing_checkout_intents
  FOR EACH ROW EXECUTE FUNCTION __SOPHIA_RUNTIME_SCHEMA__.protect_billing_checkout_intent();

REVOKE ALL ON __SOPHIA_RUNTIME_SCHEMA__.billing_checkout_intents FROM sophia_runtime_app;
GRANT SELECT, INSERT, UPDATE ON __SOPHIA_RUNTIME_SCHEMA__.billing_checkout_intents TO sophia_runtime_app;
