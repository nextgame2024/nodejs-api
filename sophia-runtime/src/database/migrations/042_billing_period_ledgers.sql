CREATE TABLE IF NOT EXISTS __SOPHIA_RUNTIME_SCHEMA__.billing_subscription_periods (
  billing_subscription_period_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES __SOPHIA_RUNTIME_SCHEMA__.customers(customer_id) ON DELETE RESTRICT,
  billing_subscription_reference_id uuid NOT NULL,
  provider_key text NOT NULL CHECK (provider_key ~ '^[a-z][a-z0-9-]{1,79}$'),
  provider_environment text NOT NULL CHECK (provider_environment IN ('sandbox', 'live')),
  provider_account_key text NOT NULL CHECK (provider_account_key ~ '^[a-z][a-z0-9-]{1,79}$'),
  external_subscription_ref text NOT NULL CHECK (length(external_subscription_ref) BETWEEN 1 AND 240),
  period_start timestamptz NOT NULL,
  period_end timestamptz NOT NULL,
  first_observed_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (billing_subscription_period_id, customer_id),
  UNIQUE (provider_key, provider_environment, provider_account_key, external_subscription_ref, period_start, period_end),
  FOREIGN KEY (billing_subscription_reference_id, customer_id)
    REFERENCES __SOPHIA_RUNTIME_SCHEMA__.billing_subscription_references(
      billing_subscription_reference_id, customer_id) ON DELETE RESTRICT,
  CHECK (period_end > period_start)
);

CREATE OR REPLACE FUNCTION __SOPHIA_RUNTIME_SCHEMA__.capture_billing_subscription_period()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, __SOPHIA_RUNTIME_SCHEMA__
AS $$
BEGIN
  IF NEW.current_period_start IS NOT NULL AND NEW.current_period_end IS NOT NULL THEN
    INSERT INTO __SOPHIA_RUNTIME_SCHEMA__.billing_subscription_periods (
      customer_id, billing_subscription_reference_id, provider_key, provider_environment,
      provider_account_key, external_subscription_ref, period_start, period_end, first_observed_at
    ) VALUES (
      NEW.customer_id, NEW.billing_subscription_reference_id, NEW.provider_key, NEW.provider_environment,
      NEW.provider_account_key, NEW.external_subscription_ref, NEW.current_period_start,
      NEW.current_period_end, NEW.observed_at
    ) ON CONFLICT (provider_key, provider_environment, provider_account_key,
      external_subscription_ref, period_start, period_end) DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION __SOPHIA_RUNTIME_SCHEMA__.capture_billing_subscription_period() FROM PUBLIC;

DROP TRIGGER IF EXISTS trg_capture_billing_subscription_period
  ON __SOPHIA_RUNTIME_SCHEMA__.billing_subscription_references;
CREATE TRIGGER trg_capture_billing_subscription_period
  AFTER INSERT OR UPDATE OF current_period_start, current_period_end
  ON __SOPHIA_RUNTIME_SCHEMA__.billing_subscription_references
  FOR EACH ROW EXECUTE FUNCTION __SOPHIA_RUNTIME_SCHEMA__.capture_billing_subscription_period();

INSERT INTO __SOPHIA_RUNTIME_SCHEMA__.billing_subscription_periods (
  customer_id, billing_subscription_reference_id, provider_key, provider_environment,
  provider_account_key, external_subscription_ref, period_start, period_end, first_observed_at
)
SELECT customer_id, billing_subscription_reference_id, provider_key, provider_environment,
       provider_account_key, external_subscription_ref, current_period_start, current_period_end, observed_at
FROM __SOPHIA_RUNTIME_SCHEMA__.billing_subscription_references
WHERE current_period_start IS NOT NULL AND current_period_end IS NOT NULL
ON CONFLICT (provider_key, provider_environment, provider_account_key,
  external_subscription_ref, period_start, period_end) DO NOTHING;

CREATE TABLE IF NOT EXISTS __SOPHIA_RUNTIME_SCHEMA__.billing_usage_period_ledgers (
  billing_usage_period_ledger_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES __SOPHIA_RUNTIME_SCHEMA__.customers(customer_id) ON DELETE RESTRICT,
  billing_subscription_period_id uuid NOT NULL,
  commercial_assignment_id uuid NOT NULL,
  commercial_plan_version_id uuid NOT NULL REFERENCES __SOPHIA_RUNTIME_SCHEMA__.commercial_plan_versions(
    commercial_plan_version_id) ON DELETE RESTRICT,
  seller_legal_entity_version_id uuid NOT NULL REFERENCES __SOPHIA_RUNTIME_SCHEMA__.seller_legal_entity_versions(
    seller_legal_entity_version_id) ON DELETE RESTRICT,
  seller_commercial_policy_version_id uuid NOT NULL REFERENCES __SOPHIA_RUNTIME_SCHEMA__.seller_commercial_policy_versions(
    seller_commercial_policy_version_id) ON DELETE RESTRICT,
  period_start timestamptz NOT NULL,
  period_end timestamptz NOT NULL,
  active_microseconds bigint NOT NULL CHECK (active_microseconds >= 0),
  included_active_seconds bigint NOT NULL CHECK (included_active_seconds = 120000),
  overage_microseconds bigint NOT NULL CHECK (overage_microseconds >= 0),
  billable_overage_minutes bigint NOT NULL CHECK (billable_overage_minutes >= 0),
  overage_unit_price_minor bigint NOT NULL CHECK (overage_unit_price_minor >= 0),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  rate_card_snapshot jsonb NOT NULL CHECK (jsonb_typeof(rate_card_snapshot) = 'object'),
  plan_manifest_digest text NOT NULL CHECK (plan_manifest_digest ~ '^[a-f0-9]{64}$'),
  ledger_digest text NOT NULL CHECK (ledger_digest ~ '^[a-f0-9]{64}$'),
  finalised_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (billing_subscription_period_id),
  UNIQUE (customer_id, period_start, period_end),
  FOREIGN KEY (billing_subscription_period_id, customer_id)
    REFERENCES __SOPHIA_RUNTIME_SCHEMA__.billing_subscription_periods(
      billing_subscription_period_id, customer_id) ON DELETE RESTRICT,
  FOREIGN KEY (commercial_assignment_id, customer_id)
    REFERENCES __SOPHIA_RUNTIME_SCHEMA__.tenant_commercial_assignments(
      commercial_assignment_id, customer_id) ON DELETE RESTRICT,
  CHECK (period_end > period_start),
  CHECK (overage_microseconds = GREATEST(active_microseconds - included_active_seconds * 1000000, 0)),
  CHECK (billable_overage_minutes = CASE WHEN overage_microseconds = 0 THEN 0
    ELSE (overage_microseconds + 60000000 - 1) / 60000000 END)
);

CREATE OR REPLACE FUNCTION __SOPHIA_RUNTIME_SCHEMA__.reject_immutable_billing_period_change()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Finalised billing-period evidence is immutable';
END;
$$;

DROP TRIGGER IF EXISTS trg_immutable_billing_subscription_period
  ON __SOPHIA_RUNTIME_SCHEMA__.billing_subscription_periods;
CREATE TRIGGER trg_immutable_billing_subscription_period
  BEFORE UPDATE OR DELETE ON __SOPHIA_RUNTIME_SCHEMA__.billing_subscription_periods
  FOR EACH ROW EXECUTE FUNCTION __SOPHIA_RUNTIME_SCHEMA__.reject_immutable_billing_period_change();
DROP TRIGGER IF EXISTS trg_immutable_billing_usage_period_ledger
  ON __SOPHIA_RUNTIME_SCHEMA__.billing_usage_period_ledgers;
CREATE TRIGGER trg_immutable_billing_usage_period_ledger
  BEFORE UPDATE OR DELETE ON __SOPHIA_RUNTIME_SCHEMA__.billing_usage_period_ledgers
  FOR EACH ROW EXECUTE FUNCTION __SOPHIA_RUNTIME_SCHEMA__.reject_immutable_billing_period_change();

ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.billing_subscription_periods ENABLE ROW LEVEL SECURITY;
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.billing_subscription_periods FORCE ROW LEVEL SECURITY;
CREATE POLICY billing_subscription_periods_tenant_isolation
  ON __SOPHIA_RUNTIME_SCHEMA__.billing_subscription_periods
  USING (customer_id = NULLIF(current_setting('sophia.tenant_id', true), '')::uuid)
  WITH CHECK (customer_id = NULLIF(current_setting('sophia.tenant_id', true), '')::uuid);

ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.billing_usage_period_ledgers ENABLE ROW LEVEL SECURITY;
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.billing_usage_period_ledgers FORCE ROW LEVEL SECURITY;
CREATE POLICY billing_usage_period_ledgers_tenant_isolation
  ON __SOPHIA_RUNTIME_SCHEMA__.billing_usage_period_ledgers
  USING (customer_id = NULLIF(current_setting('sophia.tenant_id', true), '')::uuid)
  WITH CHECK (customer_id = NULLIF(current_setting('sophia.tenant_id', true), '')::uuid);

REVOKE ALL ON __SOPHIA_RUNTIME_SCHEMA__.billing_subscription_periods FROM PUBLIC, sophia_runtime_app;
REVOKE ALL ON __SOPHIA_RUNTIME_SCHEMA__.billing_usage_period_ledgers FROM PUBLIC, sophia_runtime_app;
GRANT SELECT ON __SOPHIA_RUNTIME_SCHEMA__.billing_subscription_periods TO sophia_runtime_app;
GRANT SELECT, INSERT ON __SOPHIA_RUNTIME_SCHEMA__.billing_usage_period_ledgers TO sophia_runtime_app;

COMMENT ON TABLE __SOPHIA_RUNTIME_SCHEMA__.billing_subscription_periods IS
  'Immutable provider-observed subscription boundaries; calendar months are not assumed to be invoice periods.';
COMMENT ON TABLE __SOPHIA_RUNTIME_SCHEMA__.billing_usage_period_ledgers IS
  'Immutable finalised aggregate activity quantity. One inclusion and one ceiling are applied per provider period.';
