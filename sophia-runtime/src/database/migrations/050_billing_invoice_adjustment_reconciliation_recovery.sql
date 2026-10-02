CREATE OR REPLACE FUNCTION __SOPHIA_RUNTIME_SCHEMA__.protect_billing_invoice_adjustment_outbox()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.billing_invoice_adjustment_outbox_id <> OLD.billing_invoice_adjustment_outbox_id
    OR NEW.customer_id <> OLD.customer_id
    OR NEW.billing_usage_period_ledger_id <> OLD.billing_usage_period_ledger_id
    OR NEW.billing_provider_customer_id <> OLD.billing_provider_customer_id
    OR NEW.commercial_plan_version_id <> OLD.commercial_plan_version_id
    OR NEW.provider_key <> OLD.provider_key OR NEW.provider_environment <> OLD.provider_environment
    OR NEW.provider_account_key <> OLD.provider_account_key
    OR NEW.external_customer_ref <> OLD.external_customer_ref
    OR NEW.external_subscription_ref <> OLD.external_subscription_ref
    OR NEW.external_invoice_ref <> OLD.external_invoice_ref
    OR NEW.one_time_price_ref <> OLD.one_time_price_ref
    OR NEW.period_start <> OLD.period_start OR NEW.period_end <> OLD.period_end
    OR NEW.quantity <> OLD.quantity OR NEW.unit_price_minor <> OLD.unit_price_minor
    OR NEW.currency <> OLD.currency OR NEW.payload_digest <> OLD.payload_digest
    OR NEW.max_attempts <> OLD.max_attempts OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'Billing invoice-adjustment identity and payload are immutable';
  END IF;
  IF NEW.attempt_count < OLD.attempt_count OR NEW.updated_at < OLD.updated_at THEN
    RAISE EXCEPTION 'Billing invoice-adjustment evidence must advance monotonically';
  END IF;
  IF OLD.status='pending' AND NEW.status='leased'
    AND NEW.attempt_count=OLD.attempt_count+1 AND NEW.lease_until>now()
    AND NEW.submission_started_at IS NULL THEN RETURN NEW;
  END IF;
  IF OLD.status='leased' AND NEW.status='leased'
    AND NEW.lease_owner=OLD.lease_owner AND NEW.lease_token=OLD.lease_token
    AND NEW.attempt_count=OLD.attempt_count AND OLD.submission_started_at IS NULL
    AND OLD.lease_until>now() AND NEW.submission_started_at IS NOT NULL THEN RETURN NEW;
  END IF;
  IF OLD.status='leased' AND NEW.status='pending'
    AND NEW.attempt_count=OLD.attempt_count AND NEW.submission_started_at IS NULL THEN RETURN NEW;
  END IF;
  IF OLD.status='leased' AND NEW.status IN ('outcome_unknown','provider_accepted','terminal_failed','missed_window')
    AND NEW.attempt_count=OLD.attempt_count THEN RETURN NEW;
  END IF;
  IF OLD.status IN ('outcome_unknown','provider_accepted') AND NEW.status IN ('reconciled','reconciliation_failed')
    AND NEW.attempt_count=OLD.attempt_count THEN RETURN NEW;
  END IF;
  IF OLD.status='reconciliation_failed' AND NEW.status='reconciled'
    AND NEW.attempt_count=OLD.attempt_count
    AND EXISTS (
      SELECT 1
      FROM __SOPHIA_RUNTIME_SCHEMA__.billing_invoice_adjustment_reconciliations evidence
      WHERE evidence.customer_id=OLD.customer_id
        AND evidence.billing_invoice_adjustment_outbox_id=OLD.billing_invoice_adjustment_outbox_id
    ) THEN RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Billing invoice-adjustment outbox has an invalid transition';
END;
$$;

COMMENT ON FUNCTION __SOPHIA_RUNTIME_SCHEMA__.protect_billing_invoice_adjustment_outbox() IS
  'Protects immutable invoice-adjustment state and permits failed-to-reconciled recovery only after exact immutable evidence exists.';
