CREATE TABLE IF NOT EXISTS __SOPHIA_RUNTIME_SCHEMA__.billing_commercial_milestone_acceptances (
  billing_commercial_milestone_acceptance_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES __SOPHIA_RUNTIME_SCHEMA__.customers(customer_id) ON DELETE RESTRICT,
  commercial_plan_version_id uuid NOT NULL REFERENCES __SOPHIA_RUNTIME_SCHEMA__.commercial_plan_versions(commercial_plan_version_id) ON DELETE RESTRICT,
  commercial_plan_charge_component_id uuid NOT NULL REFERENCES __SOPHIA_RUNTIME_SCHEMA__.commercial_plan_charge_components(commercial_plan_charge_component_id) ON DELETE RESTRICT,
  request_id uuid NOT NULL,
  milestone_key text NOT NULL CHECK (milestone_key ~ '^[a-z][a-z0-9-]{1,79}$'),
  evidence_ref text NOT NULL CHECK (length(evidence_ref) BETWEEN 1 AND 240),
  accepted_by_identity text NOT NULL CHECK (length(accepted_by_identity) BETWEEN 1 AND 200),
  accepted_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (customer_id,request_id),
  UNIQUE (customer_id,commercial_plan_charge_component_id),
  UNIQUE (billing_commercial_milestone_acceptance_id,customer_id)
);

CREATE TABLE IF NOT EXISTS __SOPHIA_RUNTIME_SCHEMA__.billing_commercial_milestone_outbox (
  billing_commercial_milestone_outbox_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES __SOPHIA_RUNTIME_SCHEMA__.customers(customer_id) ON DELETE RESTRICT,
  billing_commercial_milestone_acceptance_id uuid NOT NULL,
  commercial_plan_version_id uuid NOT NULL REFERENCES __SOPHIA_RUNTIME_SCHEMA__.commercial_plan_versions(commercial_plan_version_id) ON DELETE RESTRICT,
  component_key text NOT NULL CHECK (component_key ~ '^[a-z][a-z0-9-]{1,79}$'),
  milestone_key text NOT NULL CHECK (milestone_key ~ '^[a-z][a-z0-9-]{1,79}$'),
  provider_key text NOT NULL CHECK (provider_key ~ '^[a-z][a-z0-9-]{1,79}$'),
  provider_environment text NOT NULL CHECK (provider_environment IN ('sandbox','live')),
  provider_account_key text NOT NULL CHECK (provider_account_key ~ '^[a-z][a-z0-9-]{1,79}$'),
  external_customer_ref text NOT NULL CHECK (length(external_customer_ref) BETWEEN 1 AND 240),
  one_time_price_ref text NOT NULL CHECK (length(one_time_price_ref) BETWEEN 1 AND 240),
  quantity bigint NOT NULL DEFAULT 1 CHECK (quantity=1),
  unit_price_minor bigint NOT NULL CHECK (unit_price_minor > 0),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  payload_digest text NOT NULL CHECK (payload_digest ~ '^[a-f0-9]{64}$'),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','submitting','outcome_unknown','provider_accepted','reconciled','reconciliation_failed','terminal_failed')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 12),
  max_attempts integer NOT NULL DEFAULT 6 CHECK (max_attempts BETWEEN 1 AND 12),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  external_invoice_ref text CHECK (external_invoice_ref IS NULL OR length(external_invoice_ref) BETWEEN 1 AND 240),
  provider_invoice_item_ref text CHECK (provider_invoice_item_ref IS NULL OR length(provider_invoice_item_ref) BETWEEN 1 AND 240),
  provider_accepted_at timestamptz,
  reconciled_at timestamptz,
  last_error_code text CHECK (last_error_code IS NULL OR length(last_error_code) BETWEEN 1 AND 80),
  last_error_detail text CHECK (last_error_detail IS NULL OR length(last_error_detail) BETWEEN 1 AND 500),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (billing_commercial_milestone_acceptance_id),
  UNIQUE (billing_commercial_milestone_outbox_id,customer_id),
  FOREIGN KEY (billing_commercial_milestone_acceptance_id,customer_id)
    REFERENCES __SOPHIA_RUNTIME_SCHEMA__.billing_commercial_milestone_acceptances(billing_commercial_milestone_acceptance_id,customer_id) ON DELETE RESTRICT,
  CHECK ((status IN ('pending','submitting','outcome_unknown','terminal_failed')
          AND external_invoice_ref IS NULL AND provider_invoice_item_ref IS NULL
          AND provider_accepted_at IS NULL AND reconciled_at IS NULL)
    OR (status IN ('provider_accepted','reconciliation_failed')
          AND external_invoice_ref IS NOT NULL AND provider_invoice_item_ref IS NOT NULL
          AND provider_accepted_at IS NOT NULL AND reconciled_at IS NULL)
    OR (status='reconciled' AND external_invoice_ref IS NOT NULL AND provider_invoice_item_ref IS NOT NULL
          AND provider_accepted_at IS NOT NULL AND reconciled_at IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS __SOPHIA_RUNTIME_SCHEMA__.billing_commercial_milestone_reconciliations (
  billing_commercial_milestone_reconciliation_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES __SOPHIA_RUNTIME_SCHEMA__.customers(customer_id) ON DELETE RESTRICT,
  billing_commercial_milestone_outbox_id uuid NOT NULL UNIQUE,
  external_invoice_ref text NOT NULL,
  provider_invoice_item_ref text NOT NULL,
  provider_invoice_line_ref text NOT NULL,
  one_time_price_ref text NOT NULL,
  quantity bigint NOT NULL CHECK (quantity=1),
  unit_price_minor bigint NOT NULL CHECK (unit_price_minor > 0),
  amount_minor bigint NOT NULL CHECK (amount_minor=unit_price_minor),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  invoice_status text NOT NULL CHECK (invoice_status IN ('open','paid','void','uncollectible')),
  observed_at timestamptz NOT NULL,
  evidence_digest text NOT NULL CHECK (evidence_digest ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (billing_commercial_milestone_outbox_id,customer_id)
    REFERENCES __SOPHIA_RUNTIME_SCHEMA__.billing_commercial_milestone_outbox(billing_commercial_milestone_outbox_id,customer_id) ON DELETE RESTRICT
);

CREATE OR REPLACE FUNCTION __SOPHIA_RUNTIME_SCHEMA__.reject_billing_commercial_milestone_acceptance_change()
RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  RAISE EXCEPTION 'Commercial milestone acceptance evidence is immutable';
END; $$;
CREATE TRIGGER trg_immutable_billing_commercial_milestone_acceptance BEFORE UPDATE OR DELETE
  ON __SOPHIA_RUNTIME_SCHEMA__.billing_commercial_milestone_acceptances FOR EACH ROW
  EXECUTE FUNCTION __SOPHIA_RUNTIME_SCHEMA__.reject_billing_commercial_milestone_acceptance_change();

CREATE OR REPLACE FUNCTION __SOPHIA_RUNTIME_SCHEMA__.reject_billing_commercial_milestone_reconciliation_change()
RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  RAISE EXCEPTION 'Commercial milestone reconciliation evidence is immutable';
END; $$;
CREATE TRIGGER trg_immutable_billing_commercial_milestone_reconciliation BEFORE UPDATE OR DELETE
  ON __SOPHIA_RUNTIME_SCHEMA__.billing_commercial_milestone_reconciliations FOR EACH ROW
  EXECUTE FUNCTION __SOPHIA_RUNTIME_SCHEMA__.reject_billing_commercial_milestone_reconciliation_change();

CREATE OR REPLACE FUNCTION __SOPHIA_RUNTIME_SCHEMA__.protect_billing_commercial_milestone_outbox()
RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF NEW.customer_id<>OLD.customer_id OR NEW.billing_commercial_milestone_acceptance_id<>OLD.billing_commercial_milestone_acceptance_id
    OR NEW.commercial_plan_version_id<>OLD.commercial_plan_version_id OR NEW.component_key<>OLD.component_key
    OR NEW.milestone_key<>OLD.milestone_key OR NEW.provider_key<>OLD.provider_key
    OR NEW.provider_environment<>OLD.provider_environment OR NEW.provider_account_key<>OLD.provider_account_key
    OR NEW.external_customer_ref<>OLD.external_customer_ref OR NEW.one_time_price_ref<>OLD.one_time_price_ref
    OR NEW.quantity<>OLD.quantity OR NEW.unit_price_minor<>OLD.unit_price_minor OR NEW.currency<>OLD.currency
    OR NEW.payload_digest<>OLD.payload_digest OR NEW.created_at<>OLD.created_at OR NEW.max_attempts<>OLD.max_attempts THEN
    RAISE EXCEPTION 'Commercial milestone invoice identity and payload are immutable';
  END IF;
  IF NEW.attempt_count<OLD.attempt_count OR NEW.updated_at<OLD.updated_at THEN
    RAISE EXCEPTION 'Commercial milestone invoice evidence must advance monotonically';
  END IF;
  IF OLD.external_invoice_ref IS NOT NULL AND NEW.external_invoice_ref IS DISTINCT FROM OLD.external_invoice_ref
    OR OLD.provider_invoice_item_ref IS NOT NULL AND NEW.provider_invoice_item_ref IS DISTINCT FROM OLD.provider_invoice_item_ref
    OR OLD.provider_accepted_at IS NOT NULL AND NEW.provider_accepted_at IS DISTINCT FROM OLD.provider_accepted_at
    OR OLD.reconciled_at IS NOT NULL AND NEW.reconciled_at IS DISTINCT FROM OLD.reconciled_at THEN
    RAISE EXCEPTION 'Commercial milestone provider evidence is immutable once observed';
  END IF;
  IF OLD.status='pending' AND NEW.status='submitting' AND NEW.attempt_count=OLD.attempt_count+1 THEN RETURN NEW; END IF;
  IF OLD.status='submitting' AND NEW.status IN ('pending','outcome_unknown','provider_accepted','terminal_failed')
    AND NEW.attempt_count=OLD.attempt_count THEN RETURN NEW; END IF;
  IF OLD.status='provider_accepted' AND NEW.status IN ('reconciled','reconciliation_failed')
    AND NEW.attempt_count=OLD.attempt_count THEN RETURN NEW; END IF;
  IF OLD.status='reconciliation_failed' AND NEW.status='reconciled'
    AND NEW.attempt_count=OLD.attempt_count THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'Commercial milestone invoice outbox has an invalid transition';
END; $$;
CREATE TRIGGER trg_protect_billing_commercial_milestone_outbox BEFORE UPDATE
  ON __SOPHIA_RUNTIME_SCHEMA__.billing_commercial_milestone_outbox FOR EACH ROW
  EXECUTE FUNCTION __SOPHIA_RUNTIME_SCHEMA__.protect_billing_commercial_milestone_outbox();

ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.billing_commercial_milestone_acceptances ENABLE ROW LEVEL SECURITY;
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.billing_commercial_milestone_acceptances FORCE ROW LEVEL SECURITY;
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.billing_commercial_milestone_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.billing_commercial_milestone_outbox FORCE ROW LEVEL SECURITY;
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.billing_commercial_milestone_reconciliations ENABLE ROW LEVEL SECURITY;
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.billing_commercial_milestone_reconciliations FORCE ROW LEVEL SECURITY;

CREATE POLICY billing_commercial_milestone_acceptances_tenant_isolation ON __SOPHIA_RUNTIME_SCHEMA__.billing_commercial_milestone_acceptances
  USING (customer_id=NULLIF(current_setting('sophia.tenant_id',true),'')::uuid)
  WITH CHECK (customer_id=NULLIF(current_setting('sophia.tenant_id',true),'')::uuid);
CREATE POLICY billing_commercial_milestone_outbox_tenant_isolation ON __SOPHIA_RUNTIME_SCHEMA__.billing_commercial_milestone_outbox
  USING (customer_id=NULLIF(current_setting('sophia.tenant_id',true),'')::uuid)
  WITH CHECK (customer_id=NULLIF(current_setting('sophia.tenant_id',true),'')::uuid);
CREATE POLICY billing_commercial_milestone_reconciliations_tenant_isolation ON __SOPHIA_RUNTIME_SCHEMA__.billing_commercial_milestone_reconciliations
  USING (customer_id=NULLIF(current_setting('sophia.tenant_id',true),'')::uuid)
  WITH CHECK (customer_id=NULLIF(current_setting('sophia.tenant_id',true),'')::uuid);

REVOKE ALL ON __SOPHIA_RUNTIME_SCHEMA__.billing_commercial_milestone_acceptances FROM PUBLIC,sophia_runtime_app;
REVOKE ALL ON __SOPHIA_RUNTIME_SCHEMA__.billing_commercial_milestone_outbox FROM PUBLIC,sophia_runtime_app;
REVOKE ALL ON __SOPHIA_RUNTIME_SCHEMA__.billing_commercial_milestone_reconciliations FROM PUBLIC,sophia_runtime_app;
GRANT SELECT,INSERT ON __SOPHIA_RUNTIME_SCHEMA__.billing_commercial_milestone_acceptances TO sophia_runtime_app;
GRANT SELECT,INSERT,UPDATE ON __SOPHIA_RUNTIME_SCHEMA__.billing_commercial_milestone_outbox TO sophia_runtime_app;
GRANT SELECT,INSERT ON __SOPHIA_RUNTIME_SCHEMA__.billing_commercial_milestone_reconciliations TO sophia_runtime_app;

COMMENT ON TABLE __SOPHIA_RUNTIME_SCHEMA__.billing_commercial_milestone_acceptances IS
  'Immutable recent-MFA operator evidence accepting a contractual commercial milestone.';
COMMENT ON TABLE __SOPHIA_RUNTIME_SCHEMA__.billing_commercial_milestone_outbox IS
  'Durable digest-bound commercial milestone invoice operation; live submission remains independently disabled.';
