-- Repair the shared reference trigger installed by migration 032. PostgreSQL may
-- resolve every NEW/OLD field referenced by a PL/pgSQL expression even when an
-- earlier boolean condition is false, so table-specific records need nested
-- branches before their table-specific columns are accessed.
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
