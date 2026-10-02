CREATE TABLE IF NOT EXISTS __SOPHIA_RUNTIME_SCHEMA__.billing_invoice_adjustment_recovery_attempts (
  billing_invoice_adjustment_recovery_attempt_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES __SOPHIA_RUNTIME_SCHEMA__.customers(customer_id) ON DELETE RESTRICT,
  source_billing_invoice_adjustment_outbox_id uuid NOT NULL,
  target_external_invoice_ref text NOT NULL CHECK (length(target_external_invoice_ref) BETWEEN 1 AND 240),
  target_period_start timestamptz NOT NULL,
  target_period_end timestamptz NOT NULL CHECK (target_period_end > target_period_start),
  payload_digest text NOT NULL CHECK (payload_digest ~ '^[a-f0-9]{64}$'),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN
    ('pending','submitting','outcome_unknown','provider_accepted','reconciled','reconciliation_failed','terminal_failed','missed_window')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 12),
  provider_invoice_item_ref text CHECK (provider_invoice_item_ref IS NULL OR length(provider_invoice_item_ref) BETWEEN 1 AND 240),
  provider_accepted_at timestamptz,
  reconciled_at timestamptz,
  last_error_code text CHECK (last_error_code IS NULL OR length(last_error_code) BETWEEN 1 AND 80),
  last_error_detail text CHECK (last_error_detail IS NULL OR length(last_error_detail) BETWEEN 1 AND 500),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_billing_invoice_adjustment_outbox_id,target_external_invoice_ref),
  UNIQUE (billing_invoice_adjustment_recovery_attempt_id,customer_id),
  FOREIGN KEY (source_billing_invoice_adjustment_outbox_id,customer_id)
    REFERENCES __SOPHIA_RUNTIME_SCHEMA__.billing_invoice_adjustment_outbox(
      billing_invoice_adjustment_outbox_id,customer_id) ON DELETE RESTRICT,
  CHECK ((status IN ('pending','submitting','outcome_unknown','terminal_failed','missed_window','reconciliation_failed')
          AND reconciled_at IS NULL)
    OR (status='provider_accepted' AND provider_invoice_item_ref IS NOT NULL
          AND provider_accepted_at IS NOT NULL AND reconciled_at IS NULL)
    OR (status='reconciled' AND provider_invoice_item_ref IS NOT NULL
          AND provider_accepted_at IS NOT NULL AND reconciled_at IS NOT NULL)),
  CHECK (updated_at >= created_at)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_billing_invoice_adjustment_one_recovered
  ON __SOPHIA_RUNTIME_SCHEMA__.billing_invoice_adjustment_recovery_attempts(
    source_billing_invoice_adjustment_outbox_id) WHERE status='reconciled';

CREATE UNIQUE INDEX IF NOT EXISTS uq_billing_invoice_adjustment_one_non_missed_recovery
  ON __SOPHIA_RUNTIME_SCHEMA__.billing_invoice_adjustment_recovery_attempts(
    source_billing_invoice_adjustment_outbox_id) WHERE status<>'missed_window';

CREATE INDEX IF NOT EXISTS idx_billing_invoice_adjustment_recovery_target
  ON __SOPHIA_RUNTIME_SCHEMA__.billing_invoice_adjustment_recovery_attempts(
    customer_id,target_external_invoice_ref,status);

CREATE TABLE IF NOT EXISTS __SOPHIA_RUNTIME_SCHEMA__.billing_invoice_adjustment_recovery_reconciliations (
  billing_invoice_adjustment_recovery_reconciliation_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES __SOPHIA_RUNTIME_SCHEMA__.customers(customer_id) ON DELETE RESTRICT,
  billing_invoice_adjustment_recovery_attempt_id uuid NOT NULL UNIQUE,
  source_billing_invoice_adjustment_outbox_id uuid NOT NULL,
  external_invoice_ref text NOT NULL CHECK (length(external_invoice_ref) BETWEEN 1 AND 240),
  provider_invoice_item_ref text NOT NULL CHECK (length(provider_invoice_item_ref) BETWEEN 1 AND 240),
  provider_invoice_line_ref text NOT NULL CHECK (length(provider_invoice_line_ref) BETWEEN 1 AND 240),
  one_time_price_ref text NOT NULL CHECK (length(one_time_price_ref) BETWEEN 1 AND 240),
  period_start timestamptz NOT NULL,
  period_end timestamptz NOT NULL CHECK (period_end > period_start),
  quantity bigint NOT NULL CHECK (quantity > 0),
  unit_price_minor bigint NOT NULL CHECK (unit_price_minor > 0),
  amount_minor bigint NOT NULL CHECK (amount_minor=quantity*unit_price_minor),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  invoice_status text NOT NULL CHECK (invoice_status IN ('open','paid','void','uncollectible')),
  observed_at timestamptz NOT NULL,
  evidence_digest text NOT NULL CHECK (evidence_digest ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (billing_invoice_adjustment_recovery_attempt_id,customer_id)
    REFERENCES __SOPHIA_RUNTIME_SCHEMA__.billing_invoice_adjustment_recovery_attempts(
      billing_invoice_adjustment_recovery_attempt_id,customer_id) ON DELETE RESTRICT,
  FOREIGN KEY (source_billing_invoice_adjustment_outbox_id,customer_id)
    REFERENCES __SOPHIA_RUNTIME_SCHEMA__.billing_invoice_adjustment_outbox(
      billing_invoice_adjustment_outbox_id,customer_id) ON DELETE RESTRICT
);

CREATE OR REPLACE FUNCTION __SOPHIA_RUNTIME_SCHEMA__.protect_billing_invoice_adjustment_recovery_attempt()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.billing_invoice_adjustment_recovery_attempt_id<>OLD.billing_invoice_adjustment_recovery_attempt_id
    OR NEW.customer_id<>OLD.customer_id
    OR NEW.source_billing_invoice_adjustment_outbox_id<>OLD.source_billing_invoice_adjustment_outbox_id
    OR NEW.target_external_invoice_ref<>OLD.target_external_invoice_ref
    OR NEW.target_period_start<>OLD.target_period_start OR NEW.target_period_end<>OLD.target_period_end
    OR NEW.payload_digest<>OLD.payload_digest OR NEW.created_at<>OLD.created_at THEN
    RAISE EXCEPTION 'Billing invoice-adjustment recovery identity and payload are immutable';
  END IF;
  IF NEW.attempt_count<OLD.attempt_count OR NEW.updated_at<OLD.updated_at THEN
    RAISE EXCEPTION 'Billing invoice-adjustment recovery evidence must advance monotonically';
  END IF;
  IF OLD.status IN ('pending','submitting','outcome_unknown') AND NEW.status='submitting'
    AND NEW.attempt_count=OLD.attempt_count+1 THEN RETURN NEW;
  END IF;
  IF OLD.status='submitting' AND NEW.status IN
    ('outcome_unknown','provider_accepted','terminal_failed','missed_window')
    AND NEW.attempt_count=OLD.attempt_count THEN RETURN NEW;
  END IF;
  IF OLD.status IN ('outcome_unknown','provider_accepted')
    AND NEW.status='reconciliation_failed'
    AND NEW.attempt_count=OLD.attempt_count THEN RETURN NEW;
  END IF;
  IF OLD.status IN ('outcome_unknown','provider_accepted','reconciliation_failed') AND NEW.status='reconciled'
    AND NEW.attempt_count=OLD.attempt_count
    AND EXISTS (
      SELECT 1 FROM __SOPHIA_RUNTIME_SCHEMA__.billing_invoice_adjustment_recovery_reconciliations evidence
      WHERE evidence.customer_id=OLD.customer_id
        AND evidence.billing_invoice_adjustment_recovery_attempt_id=OLD.billing_invoice_adjustment_recovery_attempt_id
    ) THEN RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Billing invoice-adjustment recovery has an invalid transition';
END;
$$;

CREATE OR REPLACE FUNCTION __SOPHIA_RUNTIME_SCHEMA__.reject_billing_invoice_adjustment_recovery_reconciliation_change()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Billing invoice-adjustment recovery reconciliation evidence is immutable';
END;
$$;

CREATE TRIGGER trg_protect_billing_invoice_adjustment_recovery_attempt
  BEFORE UPDATE ON __SOPHIA_RUNTIME_SCHEMA__.billing_invoice_adjustment_recovery_attempts
  FOR EACH ROW EXECUTE FUNCTION __SOPHIA_RUNTIME_SCHEMA__.protect_billing_invoice_adjustment_recovery_attempt();
CREATE TRIGGER trg_immutable_billing_invoice_adjustment_recovery_reconciliation
  BEFORE UPDATE OR DELETE ON __SOPHIA_RUNTIME_SCHEMA__.billing_invoice_adjustment_recovery_reconciliations
  FOR EACH ROW EXECUTE FUNCTION __SOPHIA_RUNTIME_SCHEMA__.reject_billing_invoice_adjustment_recovery_reconciliation_change();

ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.billing_invoice_adjustment_recovery_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.billing_invoice_adjustment_recovery_attempts FORCE ROW LEVEL SECURITY;
CREATE POLICY billing_invoice_adjustment_recovery_attempts_tenant_isolation
  ON __SOPHIA_RUNTIME_SCHEMA__.billing_invoice_adjustment_recovery_attempts
  USING (customer_id=NULLIF(current_setting('sophia.tenant_id',true),'')::uuid)
  WITH CHECK (customer_id=NULLIF(current_setting('sophia.tenant_id',true),'')::uuid);
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.billing_invoice_adjustment_recovery_reconciliations ENABLE ROW LEVEL SECURITY;
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.billing_invoice_adjustment_recovery_reconciliations FORCE ROW LEVEL SECURITY;
CREATE POLICY billing_invoice_adjustment_recovery_reconciliations_tenant_isolation
  ON __SOPHIA_RUNTIME_SCHEMA__.billing_invoice_adjustment_recovery_reconciliations
  USING (customer_id=NULLIF(current_setting('sophia.tenant_id',true),'')::uuid)
  WITH CHECK (customer_id=NULLIF(current_setting('sophia.tenant_id',true),'')::uuid);

REVOKE ALL ON __SOPHIA_RUNTIME_SCHEMA__.billing_invoice_adjustment_recovery_attempts FROM PUBLIC,sophia_runtime_app;
GRANT SELECT,INSERT,UPDATE ON __SOPHIA_RUNTIME_SCHEMA__.billing_invoice_adjustment_recovery_attempts TO sophia_runtime_app;
REVOKE ALL ON __SOPHIA_RUNTIME_SCHEMA__.billing_invoice_adjustment_recovery_reconciliations FROM PUBLIC,sophia_runtime_app;
GRANT SELECT,INSERT ON __SOPHIA_RUNTIME_SCHEMA__.billing_invoice_adjustment_recovery_reconciliations TO sophia_runtime_app;

COMMENT ON TABLE __SOPHIA_RUNTIME_SCHEMA__.billing_invoice_adjustment_recovery_attempts IS
  'Immutable next-renewal delivery attempts for missed sandbox overage adjustments; never creates an out-of-cycle invoice.';
COMMENT ON TABLE __SOPHIA_RUNTIME_SCHEMA__.billing_invoice_adjustment_recovery_reconciliations IS
  'Immutable exact finalized-line proof for one successful missed-window carry-forward.';
