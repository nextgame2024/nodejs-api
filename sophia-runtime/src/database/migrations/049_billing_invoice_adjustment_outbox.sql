CREATE TABLE IF NOT EXISTS __SOPHIA_RUNTIME_SCHEMA__.billing_invoice_adjustment_outbox (
  billing_invoice_adjustment_outbox_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES __SOPHIA_RUNTIME_SCHEMA__.customers(customer_id) ON DELETE RESTRICT,
  billing_usage_period_ledger_id uuid NOT NULL,
  billing_provider_customer_id uuid NOT NULL,
  commercial_plan_version_id uuid NOT NULL REFERENCES __SOPHIA_RUNTIME_SCHEMA__.commercial_plan_versions(
    commercial_plan_version_id) ON DELETE RESTRICT,
  provider_key text NOT NULL CHECK (provider_key ~ '^[a-z][a-z0-9-]{1,79}$'),
  provider_environment text NOT NULL CHECK (provider_environment IN ('sandbox','live')),
  provider_account_key text NOT NULL CHECK (provider_account_key ~ '^[a-z][a-z0-9-]{1,79}$'),
  external_customer_ref text NOT NULL CHECK (length(external_customer_ref) BETWEEN 1 AND 240),
  external_subscription_ref text NOT NULL CHECK (length(external_subscription_ref) BETWEEN 1 AND 240),
  external_invoice_ref text NOT NULL CHECK (length(external_invoice_ref) BETWEEN 1 AND 240),
  one_time_price_ref text NOT NULL CHECK (length(one_time_price_ref) BETWEEN 1 AND 240),
  period_start timestamptz NOT NULL,
  period_end timestamptz NOT NULL,
  quantity bigint NOT NULL CHECK (quantity > 0),
  unit_price_minor bigint NOT NULL CHECK (unit_price_minor > 0),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  payload_digest text NOT NULL CHECK (payload_digest ~ '^[a-f0-9]{64}$'),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','leased','outcome_unknown','provider_accepted','reconciled','reconciliation_failed','terminal_failed','missed_window')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 12),
  max_attempts integer NOT NULL DEFAULT 6 CHECK (max_attempts BETWEEN 1 AND 12),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  lease_owner text CHECK (lease_owner IS NULL OR length(lease_owner) BETWEEN 1 AND 120),
  lease_token uuid,
  lease_until timestamptz,
  submission_started_at timestamptz,
  provider_invoice_item_ref text CHECK (provider_invoice_item_ref IS NULL OR length(provider_invoice_item_ref) BETWEEN 1 AND 240),
  provider_accepted_at timestamptz,
  reconciled_at timestamptz,
  last_error_code text CHECK (last_error_code IS NULL OR length(last_error_code) BETWEEN 1 AND 80),
  last_error_detail text CHECK (last_error_detail IS NULL OR length(last_error_detail) BETWEEN 1 AND 500),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (billing_usage_period_ledger_id),
  UNIQUE (billing_invoice_adjustment_outbox_id,customer_id),
  UNIQUE (provider_key,provider_environment,provider_account_key,external_invoice_ref),
  FOREIGN KEY (billing_usage_period_ledger_id,customer_id)
    REFERENCES __SOPHIA_RUNTIME_SCHEMA__.billing_usage_period_ledgers(
      billing_usage_period_ledger_id,customer_id) ON DELETE RESTRICT,
  FOREIGN KEY (billing_provider_customer_id,customer_id)
    REFERENCES __SOPHIA_RUNTIME_SCHEMA__.billing_provider_customers(
      billing_provider_customer_id,customer_id) ON DELETE RESTRICT,
  CHECK (period_end > period_start),
  CHECK (attempt_count <= max_attempts),
  CHECK ((status='pending' AND lease_owner IS NULL AND lease_token IS NULL AND lease_until IS NULL
          AND submission_started_at IS NULL AND provider_invoice_item_ref IS NULL
          AND provider_accepted_at IS NULL AND reconciled_at IS NULL)
    OR (status='leased' AND lease_owner IS NOT NULL AND lease_token IS NOT NULL AND lease_until IS NOT NULL
          AND provider_invoice_item_ref IS NULL AND provider_accepted_at IS NULL AND reconciled_at IS NULL)
    OR (status='outcome_unknown' AND submission_started_at IS NOT NULL
          AND lease_owner IS NULL AND lease_token IS NULL AND lease_until IS NULL
          AND provider_accepted_at IS NULL AND reconciled_at IS NULL)
    OR (status='provider_accepted' AND submission_started_at IS NOT NULL
          AND lease_owner IS NULL AND lease_token IS NULL AND lease_until IS NULL
          AND provider_invoice_item_ref IS NOT NULL AND provider_accepted_at IS NOT NULL AND reconciled_at IS NULL)
    OR (status='reconciled' AND submission_started_at IS NOT NULL
          AND lease_owner IS NULL AND lease_token IS NULL AND lease_until IS NULL
          AND provider_invoice_item_ref IS NOT NULL AND provider_accepted_at IS NOT NULL AND reconciled_at IS NOT NULL)
    OR (status='reconciliation_failed' AND submission_started_at IS NOT NULL
          AND lease_owner IS NULL AND lease_token IS NULL AND lease_until IS NULL AND reconciled_at IS NULL)
    OR (status IN ('terminal_failed','missed_window')
          AND lease_owner IS NULL AND lease_token IS NULL AND lease_until IS NULL
          AND provider_accepted_at IS NULL AND reconciled_at IS NULL)),
  CHECK (updated_at >= created_at)
);

CREATE INDEX IF NOT EXISTS idx_billing_invoice_adjustment_claim
  ON __SOPHIA_RUNTIME_SCHEMA__.billing_invoice_adjustment_outbox(
    provider_key,provider_environment,provider_account_key,next_attempt_at,created_at)
  WHERE status='pending';

CREATE TABLE IF NOT EXISTS __SOPHIA_RUNTIME_SCHEMA__.billing_invoice_adjustment_reconciliations (
  billing_invoice_adjustment_reconciliation_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES __SOPHIA_RUNTIME_SCHEMA__.customers(customer_id) ON DELETE RESTRICT,
  billing_invoice_adjustment_outbox_id uuid NOT NULL UNIQUE,
  external_invoice_ref text NOT NULL CHECK (length(external_invoice_ref) BETWEEN 1 AND 240),
  provider_invoice_item_ref text NOT NULL CHECK (length(provider_invoice_item_ref) BETWEEN 1 AND 240),
  provider_invoice_line_ref text NOT NULL CHECK (length(provider_invoice_line_ref) BETWEEN 1 AND 240),
  one_time_price_ref text NOT NULL CHECK (length(one_time_price_ref) BETWEEN 1 AND 240),
  period_start timestamptz NOT NULL,
  period_end timestamptz NOT NULL CHECK (period_end > period_start),
  quantity bigint NOT NULL CHECK (quantity > 0),
  unit_price_minor bigint NOT NULL CHECK (unit_price_minor > 0),
  amount_minor bigint NOT NULL CHECK (amount_minor = quantity * unit_price_minor),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  invoice_status text NOT NULL CHECK (invoice_status IN ('open','paid','void','uncollectible')),
  observed_at timestamptz NOT NULL,
  evidence_digest text NOT NULL CHECK (evidence_digest ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (billing_invoice_adjustment_outbox_id,customer_id)
    REFERENCES __SOPHIA_RUNTIME_SCHEMA__.billing_invoice_adjustment_outbox(
      billing_invoice_adjustment_outbox_id,customer_id) ON DELETE RESTRICT
);

CREATE OR REPLACE FUNCTION __SOPHIA_RUNTIME_SCHEMA__.reject_billing_invoice_adjustment_reconciliation_change()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Billing invoice-adjustment reconciliation evidence is immutable';
END;
$$;

DROP TRIGGER IF EXISTS trg_immutable_billing_invoice_adjustment_reconciliation
  ON __SOPHIA_RUNTIME_SCHEMA__.billing_invoice_adjustment_reconciliations;
CREATE TRIGGER trg_immutable_billing_invoice_adjustment_reconciliation
  BEFORE UPDATE OR DELETE ON __SOPHIA_RUNTIME_SCHEMA__.billing_invoice_adjustment_reconciliations
  FOR EACH ROW EXECUTE FUNCTION __SOPHIA_RUNTIME_SCHEMA__.reject_billing_invoice_adjustment_reconciliation_change();

ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.billing_invoice_adjustment_reconciliations ENABLE ROW LEVEL SECURITY;
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.billing_invoice_adjustment_reconciliations FORCE ROW LEVEL SECURITY;
CREATE POLICY billing_invoice_adjustment_reconciliations_tenant_isolation
  ON __SOPHIA_RUNTIME_SCHEMA__.billing_invoice_adjustment_reconciliations
  USING (customer_id=NULLIF(current_setting('sophia.tenant_id',true),'')::uuid)
  WITH CHECK (customer_id=NULLIF(current_setting('sophia.tenant_id',true),'')::uuid);

REVOKE ALL ON __SOPHIA_RUNTIME_SCHEMA__.billing_invoice_adjustment_reconciliations FROM PUBLIC,sophia_runtime_app;
GRANT SELECT,INSERT ON __SOPHIA_RUNTIME_SCHEMA__.billing_invoice_adjustment_reconciliations TO sophia_runtime_app;

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
  RAISE EXCEPTION 'Billing invoice-adjustment outbox has an invalid transition';
END;
$$;

DROP TRIGGER IF EXISTS trg_protect_billing_invoice_adjustment_outbox
  ON __SOPHIA_RUNTIME_SCHEMA__.billing_invoice_adjustment_outbox;
CREATE TRIGGER trg_protect_billing_invoice_adjustment_outbox
  BEFORE UPDATE ON __SOPHIA_RUNTIME_SCHEMA__.billing_invoice_adjustment_outbox
  FOR EACH ROW EXECUTE FUNCTION __SOPHIA_RUNTIME_SCHEMA__.protect_billing_invoice_adjustment_outbox();

ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.billing_invoice_adjustment_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.billing_invoice_adjustment_outbox FORCE ROW LEVEL SECURITY;
CREATE POLICY billing_invoice_adjustment_outbox_tenant_isolation
  ON __SOPHIA_RUNTIME_SCHEMA__.billing_invoice_adjustment_outbox
  USING (customer_id=NULLIF(current_setting('sophia.tenant_id',true),'')::uuid)
  WITH CHECK (customer_id=NULLIF(current_setting('sophia.tenant_id',true),'')::uuid);

REVOKE ALL ON __SOPHIA_RUNTIME_SCHEMA__.billing_invoice_adjustment_outbox FROM PUBLIC,sophia_runtime_app;
GRANT SELECT,INSERT,UPDATE ON __SOPHIA_RUNTIME_SCHEMA__.billing_invoice_adjustment_outbox TO sophia_runtime_app;

COMMENT ON TABLE __SOPHIA_RUNTIME_SCHEMA__.billing_invoice_adjustment_outbox IS
  'Durable exact-period overage adjustment bound to one draft renewal invoice. Live dispatch remains independently disabled.';

COMMENT ON TABLE __SOPHIA_RUNTIME_SCHEMA__.billing_invoice_adjustment_reconciliations IS
  'Immutable provider read-back proving the finalized one-time overage line exactly matches its Sophia usage ledger.';
