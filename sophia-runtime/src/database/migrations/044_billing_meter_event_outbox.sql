ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.billing_provider_customers
  ADD CONSTRAINT billing_provider_customer_tenant_identity_key
  UNIQUE (billing_provider_customer_id, customer_id);
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.billing_usage_period_ledgers
  ADD CONSTRAINT billing_usage_period_ledger_tenant_identity_key
  UNIQUE (billing_usage_period_ledger_id, customer_id);

CREATE TABLE IF NOT EXISTS __SOPHIA_RUNTIME_SCHEMA__.billing_meter_event_outbox (
  billing_meter_event_outbox_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES __SOPHIA_RUNTIME_SCHEMA__.customers(customer_id) ON DELETE RESTRICT,
  billing_usage_period_ledger_id uuid NOT NULL,
  billing_provider_customer_id uuid NOT NULL,
  provider_key text NOT NULL CHECK (provider_key ~ '^[a-z][a-z0-9-]{1,79}$'),
  provider_environment text NOT NULL CHECK (provider_environment IN ('sandbox', 'live')),
  provider_account_key text NOT NULL CHECK (provider_account_key ~ '^[a-z][a-z0-9-]{1,79}$'),
  external_customer_ref text NOT NULL CHECK (length(external_customer_ref) BETWEEN 1 AND 240),
  meter_binding_key text NOT NULL CHECK (meter_binding_key ~ '^[a-z][a-z0-9-]{1,79}$'),
  submission_identifier text NOT NULL CHECK (length(submission_identifier) BETWEEN 1 AND 100),
  event_timestamp timestamptz NOT NULL,
  quantity bigint NOT NULL CHECK (quantity > 0),
  quantity_unit text NOT NULL CHECK (quantity_unit = 'whole-minute'),
  payload_digest text NOT NULL CHECK (payload_digest ~ '^[a-f0-9]{64}$'),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','leased','outcome_unknown','provider_accepted','reconciled','terminal_failed')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 12),
  max_attempts integer NOT NULL DEFAULT 6 CHECK (max_attempts BETWEEN 1 AND 12),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  lease_owner text CHECK (lease_owner IS NULL OR length(lease_owner) BETWEEN 1 AND 120),
  lease_token uuid,
  lease_until timestamptz,
  submission_started_at timestamptz,
  last_definitive_failure_at timestamptz,
  provider_event_ref text CHECK (provider_event_ref IS NULL OR length(provider_event_ref) BETWEEN 1 AND 240),
  provider_accepted_at timestamptz,
  reconciled_at timestamptz,
  last_error_code text CHECK (last_error_code IS NULL OR length(last_error_code) BETWEEN 1 AND 80),
  last_error_detail text CHECK (last_error_detail IS NULL OR length(last_error_detail) BETWEEN 1 AND 500),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (billing_usage_period_ledger_id),
  UNIQUE (provider_key, provider_environment, provider_account_key, submission_identifier),
  FOREIGN KEY (billing_usage_period_ledger_id, customer_id)
    REFERENCES __SOPHIA_RUNTIME_SCHEMA__.billing_usage_period_ledgers(
      billing_usage_period_ledger_id, customer_id) ON DELETE RESTRICT,
  FOREIGN KEY (billing_provider_customer_id, customer_id)
    REFERENCES __SOPHIA_RUNTIME_SCHEMA__.billing_provider_customers(
      billing_provider_customer_id, customer_id) ON DELETE RESTRICT,
  CHECK (attempt_count <= max_attempts),
  CHECK (event_timestamp <= created_at),
  CHECK ((status = 'pending' AND lease_owner IS NULL AND lease_token IS NULL AND lease_until IS NULL
          AND submission_started_at IS NULL AND provider_event_ref IS NULL
          AND provider_accepted_at IS NULL AND reconciled_at IS NULL)
    OR (status = 'leased' AND lease_owner IS NOT NULL AND lease_token IS NOT NULL AND lease_until IS NOT NULL
          AND provider_event_ref IS NULL AND provider_accepted_at IS NULL AND reconciled_at IS NULL)
    OR (status = 'outcome_unknown' AND submission_started_at IS NOT NULL
          AND lease_owner IS NULL AND lease_token IS NULL AND lease_until IS NULL
          AND provider_accepted_at IS NULL AND reconciled_at IS NULL)
    OR (status = 'provider_accepted' AND submission_started_at IS NOT NULL
          AND lease_owner IS NULL AND lease_token IS NULL AND lease_until IS NULL
          AND provider_event_ref IS NOT NULL AND provider_accepted_at IS NOT NULL AND reconciled_at IS NULL)
    OR (status = 'reconciled' AND submission_started_at IS NOT NULL
          AND lease_owner IS NULL AND lease_token IS NULL AND lease_until IS NULL
          AND provider_event_ref IS NOT NULL AND provider_accepted_at IS NOT NULL AND reconciled_at IS NOT NULL)
    OR (status = 'terminal_failed' AND lease_owner IS NULL AND lease_token IS NULL AND lease_until IS NULL
          AND provider_accepted_at IS NULL AND reconciled_at IS NULL)),
  CHECK (updated_at >= created_at)
);

CREATE INDEX IF NOT EXISTS idx_billing_meter_event_outbox_claim
  ON __SOPHIA_RUNTIME_SCHEMA__.billing_meter_event_outbox(
    provider_key, provider_environment, provider_account_key, next_attempt_at, created_at)
  WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_billing_meter_event_outbox_expired_lease
  ON __SOPHIA_RUNTIME_SCHEMA__.billing_meter_event_outbox(lease_until)
  WHERE status = 'leased';

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

DROP TRIGGER IF EXISTS trg_protect_billing_meter_event_outbox
  ON __SOPHIA_RUNTIME_SCHEMA__.billing_meter_event_outbox;
CREATE TRIGGER trg_protect_billing_meter_event_outbox
  BEFORE UPDATE ON __SOPHIA_RUNTIME_SCHEMA__.billing_meter_event_outbox
  FOR EACH ROW EXECUTE FUNCTION __SOPHIA_RUNTIME_SCHEMA__.protect_billing_meter_event_outbox();

ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.billing_meter_event_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.billing_meter_event_outbox FORCE ROW LEVEL SECURITY;
CREATE POLICY billing_meter_event_outbox_tenant_isolation
  ON __SOPHIA_RUNTIME_SCHEMA__.billing_meter_event_outbox
  USING (customer_id = NULLIF(current_setting('sophia.tenant_id', true), '')::uuid)
  WITH CHECK (customer_id = NULLIF(current_setting('sophia.tenant_id', true), '')::uuid);

REVOKE ALL ON __SOPHIA_RUNTIME_SCHEMA__.billing_meter_event_outbox FROM PUBLIC, sophia_runtime_app;
GRANT SELECT, INSERT, UPDATE ON __SOPHIA_RUNTIME_SCHEMA__.billing_meter_event_outbox TO sophia_runtime_app;

COMMENT ON TABLE __SOPHIA_RUNTIME_SCHEMA__.billing_meter_event_outbox IS
  'Transactional provider-neutral whole-minute overage outbox. Ambiguous submissions remain outcome_unknown and are never automatically retried.';
COMMENT ON COLUMN __SOPHIA_RUNTIME_SCHEMA__.billing_meter_event_outbox.meter_binding_key IS
  'Stable internal semantic binding resolved to an approved provider Meter only by a configured adapter.';
COMMENT ON COLUMN __SOPHIA_RUNTIME_SCHEMA__.billing_meter_event_outbox.submission_identifier IS
  'Deterministic cross-retry provider submission identity derived from the immutable period-ledger UUID.';
