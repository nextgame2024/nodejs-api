CREATE OR REPLACE FUNCTION __SOPHIA_RUNTIME_SCHEMA__.protect_billing_meter_event_outbox()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.billing_meter_event_outbox_id <> OLD.billing_meter_event_outbox_id
    OR NEW.customer_id <> OLD.customer_id
    OR NEW.billing_usage_period_ledger_id <> OLD.billing_usage_period_ledger_id
    OR NEW.billing_provider_customer_id <> OLD.billing_provider_customer_id
    OR NEW.provider_key <> OLD.provider_key OR NEW.provider_environment <> OLD.provider_environment
    OR NEW.provider_account_key <> OLD.provider_account_key
    OR NEW.external_customer_ref <> OLD.external_customer_ref
    OR NEW.meter_binding_key <> OLD.meter_binding_key
    OR NEW.submission_identifier <> OLD.submission_identifier
    OR NEW.event_timestamp <> OLD.event_timestamp OR NEW.quantity <> OLD.quantity
    OR NEW.quantity_unit <> OLD.quantity_unit OR NEW.payload_digest <> OLD.payload_digest
    OR NEW.max_attempts <> OLD.max_attempts OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'Billing meter-event identity and payload are immutable';
  END IF;
  IF NEW.attempt_count < OLD.attempt_count OR NEW.updated_at < OLD.updated_at THEN
    RAISE EXCEPTION 'Billing meter-event attempt evidence must advance monotonically';
  END IF;
  IF OLD.status = 'pending' AND NEW.status = 'leased'
    AND NEW.attempt_count = OLD.attempt_count + 1 AND NEW.lease_until > now()
    AND NEW.submission_started_at IS NULL THEN RETURN NEW;
  END IF;
  IF OLD.status = 'leased' AND NEW.status = 'leased'
    AND OLD.lease_until <= now() AND OLD.submission_started_at IS NULL
    AND NEW.attempt_count = OLD.attempt_count + 1 AND NEW.lease_until > now() THEN RETURN NEW;
  END IF;
  IF OLD.status = 'leased' AND NEW.status = 'leased'
    AND NEW.lease_owner = OLD.lease_owner AND NEW.lease_token = OLD.lease_token
    AND NEW.attempt_count = OLD.attempt_count AND NEW.lease_until > OLD.lease_until
    AND OLD.lease_until > now()
    AND NEW.submission_started_at IS NOT DISTINCT FROM OLD.submission_started_at THEN RETURN NEW;
  END IF;
  IF OLD.status = 'leased' AND NEW.status = 'leased'
    AND NEW.lease_owner = OLD.lease_owner AND NEW.lease_token = OLD.lease_token
    AND NEW.attempt_count = OLD.attempt_count AND OLD.submission_started_at IS NULL
    AND OLD.lease_until > now() AND NEW.submission_started_at IS NOT NULL THEN RETURN NEW;
  END IF;
  IF OLD.status = 'leased' AND NEW.status = 'pending'
    AND NEW.attempt_count = OLD.attempt_count
    AND (OLD.submission_started_at IS NULL
      OR (NEW.last_definitive_failure_at IS NOT NULL
        AND NEW.last_definitive_failure_at > COALESCE(OLD.last_definitive_failure_at, '-infinity'::timestamptz)))
    THEN RETURN NEW;
  END IF;
  IF OLD.status = 'leased' AND NEW.status = 'outcome_unknown'
    AND OLD.submission_started_at IS NOT NULL AND NEW.attempt_count = OLD.attempt_count THEN RETURN NEW;
  END IF;
  IF OLD.status = 'leased' AND NEW.status = 'provider_accepted'
    AND OLD.submission_started_at IS NOT NULL AND NEW.attempt_count = OLD.attempt_count THEN RETURN NEW;
  END IF;
  IF OLD.status = 'leased' AND NEW.status = 'terminal_failed'
    AND NEW.attempt_count = OLD.attempt_count THEN RETURN NEW;
  END IF;
  IF OLD.status IN ('outcome_unknown','provider_accepted') AND NEW.status = 'reconciled'
    AND NEW.attempt_count = OLD.attempt_count THEN RETURN NEW;
  END IF;
  IF OLD.status = 'outcome_unknown' AND NEW.status IN ('provider_accepted','terminal_failed')
    AND NEW.attempt_count = OLD.attempt_count THEN RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Billing meter-event outbox has an invalid transition';
END;
$$;

ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.billing_meter_event_outbox
  ADD CONSTRAINT billing_meter_event_terminal_provider_ref_check
  CHECK (status <> 'terminal_failed' OR provider_event_ref IS NULL);

COMMENT ON CONSTRAINT billing_meter_event_terminal_provider_ref_check
  ON __SOPHIA_RUNTIME_SCHEMA__.billing_meter_event_outbox IS
  'A terminal failure cannot simultaneously claim a provider-accepted event reference.';
