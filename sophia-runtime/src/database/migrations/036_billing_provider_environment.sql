ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.billing_subscription_references
  ADD COLUMN IF NOT EXISTS provider_environment text NOT NULL DEFAULT 'sandbox'
    CHECK (provider_environment IN ('sandbox', 'live'));
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.billing_invoice_references
  ADD COLUMN IF NOT EXISTS provider_environment text NOT NULL DEFAULT 'sandbox'
    CHECK (provider_environment IN ('sandbox', 'live'));

ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.billing_subscription_references
  DROP CONSTRAINT IF EXISTS billing_subscription_referenc_customer_id_provider_key_exte_key;
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.billing_invoice_references
  DROP CONSTRAINT IF EXISTS billing_invoice_references_customer_id_provider_key_externa_key;

ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.billing_subscription_references
  ADD CONSTRAINT billing_subscription_provider_environment_ref_key
    UNIQUE (provider_key, provider_environment, external_subscription_ref);
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.billing_invoice_references
  ADD CONSTRAINT billing_invoice_provider_environment_ref_key
    UNIQUE (provider_key, provider_environment, external_invoice_ref);

CREATE INDEX IF NOT EXISTS idx_billing_subscription_tenant_environment_time
  ON __SOPHIA_RUNTIME_SCHEMA__.billing_subscription_references
    (customer_id, provider_key, provider_environment, observed_at DESC);
CREATE INDEX IF NOT EXISTS idx_billing_invoice_tenant_environment_time
  ON __SOPHIA_RUNTIME_SCHEMA__.billing_invoice_references
    (customer_id, provider_key, provider_environment, observed_at DESC);

CREATE OR REPLACE FUNCTION __SOPHIA_RUNTIME_SCHEMA__.protect_billing_reference_identity()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.customer_id <> OLD.customer_id OR NEW.provider_key <> OLD.provider_key
    OR NEW.provider_environment <> OLD.provider_environment THEN
    RAISE EXCEPTION 'Billing reference tenant/provider/environment identity is immutable';
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
