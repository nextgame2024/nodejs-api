ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.billing_checkout_intents
  ALTER COLUMN external_checkout_ref DROP NOT NULL,
  ALTER COLUMN expires_at DROP NOT NULL;
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.billing_checkout_intents
  DROP CONSTRAINT IF EXISTS billing_checkout_intents_status_check,
  DROP CONSTRAINT IF EXISTS billing_checkout_intents_check1;
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.billing_checkout_intents
  ADD CONSTRAINT billing_checkout_intents_status_check
    CHECK (status IN ('allocating', 'outcome_unknown', 'created', 'completed', 'expired')),
  ADD CONSTRAINT billing_checkout_intents_lifecycle_check CHECK (
    (status IN ('allocating','outcome_unknown') AND external_checkout_ref IS NULL AND expires_at IS NULL AND completed_at IS NULL)
    OR (status = 'created' AND external_checkout_ref IS NOT NULL AND expires_at IS NOT NULL AND completed_at IS NULL)
    OR (status IN ('completed','expired') AND external_checkout_ref IS NOT NULL AND expires_at IS NOT NULL AND completed_at IS NOT NULL)
  );

CREATE UNIQUE INDEX IF NOT EXISTS uq_active_billing_checkout_intent
  ON __SOPHIA_RUNTIME_SCHEMA__.billing_checkout_intents(customer_id, provider_key, provider_environment)
  WHERE status IN ('allocating','outcome_unknown','created');

CREATE OR REPLACE FUNCTION __SOPHIA_RUNTIME_SCHEMA__.protect_billing_checkout_intent()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.customer_id <> OLD.customer_id OR NEW.provider_key <> OLD.provider_key
    OR NEW.provider_environment <> OLD.provider_environment OR NEW.request_id <> OLD.request_id
    OR NEW.commercial_plan_version_id <> OLD.commercial_plan_version_id OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'Billing Checkout intent identity is immutable';
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
