CREATE OR REPLACE FUNCTION __SOPHIA_RUNTIME_SCHEMA__.protect_billing_provider_customer_identity()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.customer_id <> OLD.customer_id OR NEW.provider_key <> OLD.provider_key
    OR NEW.provider_environment <> OLD.provider_environment OR NEW.external_customer_ref <> OLD.external_customer_ref THEN
    RAISE EXCEPTION 'Billing provider customer identity is immutable';
  END IF;
  IF NEW.revision <> OLD.revision + 1 OR NEW.observed_at < OLD.observed_at THEN
    RAISE EXCEPTION 'Billing provider customer observations must advance monotonically';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS protect_billing_provider_customer_identity
  ON __SOPHIA_RUNTIME_SCHEMA__.billing_provider_customers;
CREATE TRIGGER protect_billing_provider_customer_identity BEFORE UPDATE
  ON __SOPHIA_RUNTIME_SCHEMA__.billing_provider_customers
  FOR EACH ROW EXECUTE FUNCTION __SOPHIA_RUNTIME_SCHEMA__.protect_billing_provider_customer_identity();

CREATE OR REPLACE FUNCTION __SOPHIA_RUNTIME_SCHEMA__.protect_billing_webhook_evidence()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.customer_id <> OLD.customer_id OR NEW.provider_key <> OLD.provider_key
    OR NEW.provider_environment <> OLD.provider_environment OR NEW.external_event_ref <> OLD.external_event_ref
    OR NEW.event_type <> OLD.event_type OR NEW.payload_digest <> OLD.payload_digest
    OR NEW.occurred_at <> OLD.occurred_at OR NEW.received_at <> OLD.received_at THEN
    RAISE EXCEPTION 'Billing webhook identity and digest evidence are immutable';
  END IF;
  IF OLD.processing_status <> 'received' OR NEW.processing_status NOT IN ('processed', 'ignored', 'failed')
    OR NEW.processed_at IS NULL THEN
    RAISE EXCEPTION 'Billing webhook processing evidence has an invalid transition';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS protect_billing_webhook_evidence
  ON __SOPHIA_RUNTIME_SCHEMA__.billing_webhook_events;
CREATE TRIGGER protect_billing_webhook_evidence BEFORE UPDATE
  ON __SOPHIA_RUNTIME_SCHEMA__.billing_webhook_events
  FOR EACH ROW EXECUTE FUNCTION __SOPHIA_RUNTIME_SCHEMA__.protect_billing_webhook_evidence();

CREATE OR REPLACE FUNCTION __SOPHIA_RUNTIME_SCHEMA__.protect_billing_reference_identity()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.customer_id <> OLD.customer_id OR NEW.provider_key <> OLD.provider_key THEN
    RAISE EXCEPTION 'Billing reference tenant/provider identity is immutable';
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
DROP TRIGGER IF EXISTS protect_billing_subscription_reference_identity
  ON __SOPHIA_RUNTIME_SCHEMA__.billing_subscription_references;
CREATE TRIGGER protect_billing_subscription_reference_identity BEFORE UPDATE
  ON __SOPHIA_RUNTIME_SCHEMA__.billing_subscription_references
  FOR EACH ROW EXECUTE FUNCTION __SOPHIA_RUNTIME_SCHEMA__.protect_billing_reference_identity();
DROP TRIGGER IF EXISTS protect_billing_invoice_reference_identity
  ON __SOPHIA_RUNTIME_SCHEMA__.billing_invoice_references;
CREATE TRIGGER protect_billing_invoice_reference_identity BEFORE UPDATE
  ON __SOPHIA_RUNTIME_SCHEMA__.billing_invoice_references
  FOR EACH ROW EXECUTE FUNCTION __SOPHIA_RUNTIME_SCHEMA__.protect_billing_reference_identity();
