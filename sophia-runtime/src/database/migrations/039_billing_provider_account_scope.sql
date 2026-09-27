CREATE TABLE IF NOT EXISTS __SOPHIA_RUNTIME_SCHEMA__.seller_billing_provider_accounts (
  seller_billing_provider_account_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seller_legal_entity_id uuid NOT NULL
    REFERENCES __SOPHIA_RUNTIME_SCHEMA__.seller_legal_entities(seller_legal_entity_id) ON DELETE RESTRICT,
  provider_key text NOT NULL CHECK (provider_key ~ '^[a-z][a-z0-9-]{1,79}$'),
  provider_environment text NOT NULL CHECK (provider_environment IN ('sandbox', 'live')),
  provider_account_key text NOT NULL CHECK (provider_account_key ~ '^[a-z][a-z0-9-]{1,79}$'),
  external_account_ref text NOT NULL CHECK (length(external_account_ref) BETWEEN 1 AND 240),
  status text NOT NULL CHECK (status IN ('active', 'retired')),
  effective_from timestamptz NOT NULL,
  effective_to timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider_key, provider_environment, provider_account_key),
  UNIQUE (provider_key, provider_environment, external_account_ref),
  CHECK (effective_to IS NULL OR effective_to > effective_from)
);

CREATE OR REPLACE FUNCTION __SOPHIA_RUNTIME_SCHEMA__.protect_seller_billing_provider_account()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.seller_billing_provider_account_id <> OLD.seller_billing_provider_account_id
    OR NEW.seller_legal_entity_id <> OLD.seller_legal_entity_id
    OR NEW.provider_key <> OLD.provider_key OR NEW.provider_environment <> OLD.provider_environment
    OR NEW.provider_account_key <> OLD.provider_account_key OR NEW.external_account_ref <> OLD.external_account_ref
    OR NEW.effective_from <> OLD.effective_from OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'Seller billing provider account identity is immutable';
  END IF;
  IF OLD.status = 'active' AND NEW.status = 'retired' AND OLD.effective_to IS NULL AND NEW.effective_to IS NOT NULL THEN
    RETURN NEW;
  END IF;
  IF NEW.status = OLD.status AND NEW.effective_to IS NOT DISTINCT FROM OLD.effective_to THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Seller billing provider account has an invalid transition';
END;
$$;
DROP TRIGGER IF EXISTS trg_protect_seller_billing_provider_account
  ON __SOPHIA_RUNTIME_SCHEMA__.seller_billing_provider_accounts;
CREATE TRIGGER trg_protect_seller_billing_provider_account
  BEFORE UPDATE ON __SOPHIA_RUNTIME_SCHEMA__.seller_billing_provider_accounts
  FOR EACH ROW EXECUTE FUNCTION __SOPHIA_RUNTIME_SCHEMA__.protect_seller_billing_provider_account();

ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.billing_provider_customers
  ADD COLUMN IF NOT EXISTS provider_account_key text NOT NULL DEFAULT 'legacy-primary'
    CHECK (provider_account_key ~ '^[a-z][a-z0-9-]{1,79}$');
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.billing_webhook_events
  ADD COLUMN IF NOT EXISTS provider_account_key text NOT NULL DEFAULT 'legacy-primary'
    CHECK (provider_account_key ~ '^[a-z][a-z0-9-]{1,79}$');
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.billing_checkout_intents
  ADD COLUMN IF NOT EXISTS provider_account_key text NOT NULL DEFAULT 'legacy-primary'
    CHECK (provider_account_key ~ '^[a-z][a-z0-9-]{1,79}$');
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.billing_subscription_references
  ADD COLUMN IF NOT EXISTS provider_account_key text NOT NULL DEFAULT 'legacy-primary'
    CHECK (provider_account_key ~ '^[a-z][a-z0-9-]{1,79}$');
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.billing_invoice_references
  ADD COLUMN IF NOT EXISTS provider_account_key text NOT NULL DEFAULT 'legacy-primary'
    CHECK (provider_account_key ~ '^[a-z][a-z0-9-]{1,79}$');

ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.billing_provider_customers
  DROP CONSTRAINT IF EXISTS billing_provider_customers_customer_id_provider_key_provide_key,
  DROP CONSTRAINT IF EXISTS billing_provider_customers_provider_key_provider_environmen_key;
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.billing_provider_customers
  ADD CONSTRAINT billing_provider_customer_tenant_account_key
    UNIQUE (customer_id, provider_key, provider_environment, provider_account_key),
  ADD CONSTRAINT billing_provider_customer_external_account_key
    UNIQUE (provider_key, provider_environment, provider_account_key, external_customer_ref);

ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.billing_webhook_events
  DROP CONSTRAINT IF EXISTS billing_webhook_events_provider_key_provider_environment_ex_key;
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.billing_webhook_events
  ADD CONSTRAINT billing_webhook_external_account_key
    UNIQUE (provider_key, provider_environment, provider_account_key, external_event_ref);

ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.billing_checkout_intents
  DROP CONSTRAINT IF EXISTS billing_checkout_intents_customer_id_provider_key_provider__key,
  DROP CONSTRAINT IF EXISTS billing_checkout_intents_provider_key_provider_environment__key;
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.billing_checkout_intents
  ADD CONSTRAINT billing_checkout_request_account_key
    UNIQUE (customer_id, provider_key, provider_environment, provider_account_key, request_id),
  ADD CONSTRAINT billing_checkout_external_account_key
    UNIQUE (provider_key, provider_environment, provider_account_key, external_checkout_ref);
DROP INDEX IF EXISTS __SOPHIA_RUNTIME_SCHEMA__.uq_active_billing_checkout_intent;
CREATE UNIQUE INDEX uq_active_billing_checkout_intent
  ON __SOPHIA_RUNTIME_SCHEMA__.billing_checkout_intents
    (customer_id, provider_key, provider_environment, provider_account_key)
  WHERE status IN ('allocating','outcome_unknown','created');

ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.billing_subscription_references
  DROP CONSTRAINT IF EXISTS billing_subscription_provider_environment_ref_key;
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.billing_subscription_references
  ADD CONSTRAINT billing_subscription_provider_account_ref_key
    UNIQUE (provider_key, provider_environment, provider_account_key, external_subscription_ref);
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.billing_invoice_references
  DROP CONSTRAINT IF EXISTS billing_invoice_provider_environment_ref_key;
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.billing_invoice_references
  ADD CONSTRAINT billing_invoice_provider_account_ref_key
    UNIQUE (provider_key, provider_environment, provider_account_key, external_invoice_ref);

CREATE OR REPLACE FUNCTION __SOPHIA_RUNTIME_SCHEMA__.resolve_billing_customer_tenant(
  requested_provider_key text,
  requested_provider_environment text,
  requested_provider_account_key text,
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
    AND provider_account_key = requested_provider_account_key
    AND external_customer_ref = requested_external_customer_ref
  LIMIT 1
$$;
REVOKE ALL ON FUNCTION __SOPHIA_RUNTIME_SCHEMA__.resolve_billing_customer_tenant(text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION __SOPHIA_RUNTIME_SCHEMA__.resolve_billing_customer_tenant(text, text, text, text)
  TO sophia_runtime_app;

CREATE OR REPLACE FUNCTION __SOPHIA_RUNTIME_SCHEMA__.protect_billing_provider_customer_identity()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.customer_id <> OLD.customer_id OR NEW.provider_key <> OLD.provider_key
    OR NEW.provider_environment <> OLD.provider_environment
    OR NEW.provider_account_key <> OLD.provider_account_key
    OR NEW.external_customer_ref <> OLD.external_customer_ref THEN
    RAISE EXCEPTION 'Billing provider customer account identity is immutable';
  END IF;
  IF NEW.revision <> OLD.revision + 1 OR NEW.observed_at < OLD.observed_at THEN
    RAISE EXCEPTION 'Billing provider customer observations must advance monotonically';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION __SOPHIA_RUNTIME_SCHEMA__.protect_billing_webhook_evidence()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.customer_id <> OLD.customer_id OR NEW.provider_key <> OLD.provider_key
    OR NEW.provider_environment <> OLD.provider_environment
    OR NEW.provider_account_key <> OLD.provider_account_key
    OR NEW.external_event_ref <> OLD.external_event_ref OR NEW.event_type <> OLD.event_type
    OR NEW.payload_digest <> OLD.payload_digest OR NEW.occurred_at <> OLD.occurred_at
    OR NEW.received_at <> OLD.received_at THEN
    RAISE EXCEPTION 'Billing webhook account identity and digest evidence are immutable';
  END IF;
  IF OLD.processing_status <> 'received' OR NEW.processing_status NOT IN ('processed', 'ignored', 'failed')
    OR NEW.processed_at IS NULL THEN
    RAISE EXCEPTION 'Billing webhook processing evidence has an invalid transition';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION __SOPHIA_RUNTIME_SCHEMA__.protect_billing_checkout_intent()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.customer_id <> OLD.customer_id OR NEW.provider_key <> OLD.provider_key
    OR NEW.provider_environment <> OLD.provider_environment
    OR NEW.provider_account_key <> OLD.provider_account_key OR NEW.request_id <> OLD.request_id
    OR NEW.commercial_plan_version_id <> OLD.commercial_plan_version_id OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'Billing Checkout intent account identity is immutable';
  END IF;
  IF OLD.status IN ('allocating','outcome_unknown') AND NEW.status = 'created' THEN
    IF OLD.external_checkout_ref IS NOT NULL OR OLD.expires_at IS NOT NULL
      OR NEW.external_checkout_ref IS NULL OR NEW.expires_at IS NULL OR NEW.completed_at IS NOT NULL THEN
      RAISE EXCEPTION 'Billing Checkout provider allocation is invalid';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status = 'allocating' AND NEW.status = 'outcome_unknown'
    AND NEW.external_checkout_ref IS NULL AND NEW.expires_at IS NULL AND NEW.completed_at IS NULL THEN
    RETURN NEW;
  END IF;
  IF OLD.status = 'created' AND NEW.status IN ('completed','expired')
    AND NEW.external_checkout_ref = OLD.external_checkout_ref AND NEW.expires_at = OLD.expires_at
    AND NEW.completed_at IS NOT NULL THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Billing Checkout intent has an invalid transition';
END;
$$;

CREATE OR REPLACE FUNCTION __SOPHIA_RUNTIME_SCHEMA__.protect_billing_reference_identity()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.customer_id <> OLD.customer_id OR NEW.provider_key <> OLD.provider_key
    OR NEW.provider_environment <> OLD.provider_environment
    OR NEW.provider_account_key <> OLD.provider_account_key THEN
    RAISE EXCEPTION 'Billing reference tenant/provider/account identity is immutable';
  END IF;
  IF TG_TABLE_NAME = 'billing_subscription_references' THEN
    IF NEW.external_subscription_ref <> OLD.external_subscription_ref THEN
      RAISE EXCEPTION 'Billing subscription reference identity is immutable';
    END IF;
  ELSIF TG_TABLE_NAME = 'billing_invoice_references' THEN
    IF NEW.external_invoice_ref <> OLD.external_invoice_ref THEN
      RAISE EXCEPTION 'Billing invoice reference identity is immutable';
    END IF;
  ELSE
    RAISE EXCEPTION 'Billing reference trigger is attached to an unsupported table';
  END IF;
  IF NEW.revision <> OLD.revision + 1 OR NEW.observed_at < OLD.observed_at THEN
    RAISE EXCEPTION 'Billing references must advance monotonically';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON __SOPHIA_RUNTIME_SCHEMA__.seller_billing_provider_accounts FROM sophia_runtime_app;
GRANT SELECT ON __SOPHIA_RUNTIME_SCHEMA__.seller_billing_provider_accounts TO sophia_runtime_app;

COMMENT ON COLUMN __SOPHIA_RUNTIME_SCHEMA__.billing_provider_customers.provider_account_key IS
  'Internal account scope; external provider object identifiers are unique only within this account.';
COMMENT ON TABLE __SOPHIA_RUNTIME_SCHEMA__.seller_billing_provider_accounts IS
  'Seller-owned provider accounts. A legal-entity or processor-account migration retires the old row, creates a new row and preserves historical references.';
