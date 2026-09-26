CREATE TABLE IF NOT EXISTS __SOPHIA_RUNTIME_SCHEMA__.commercial_plan_versions (
  commercial_plan_version_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_key text NOT NULL CHECK (plan_key ~ '^[a-z][a-z0-9-]{1,79}$'),
  version integer NOT NULL CHECK (version > 0),
  display_name text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 160),
  status text NOT NULL CHECK (status IN ('draft', 'published', 'retired')),
  pricing_status text NOT NULL DEFAULT 'unconfigured' CHECK (pricing_status IN ('unconfigured', 'configured')),
  billing_currency text CHECK (billing_currency IS NULL OR billing_currency ~ '^[A-Z]{3}$'),
  billing_interval text CHECK (billing_interval IS NULL OR billing_interval IN ('month', 'year')),
  base_charge_minor bigint CHECK (base_charge_minor IS NULL OR base_charge_minor >= 0),
  tax_mode text NOT NULL DEFAULT 'unconfigured'
    CHECK (tax_mode IN ('unconfigured', 'inclusive', 'exclusive', 'not_applicable')),
  tax_rate_basis_points integer CHECK (tax_rate_basis_points IS NULL OR tax_rate_basis_points BETWEEN 0 AND 10000),
  overage_rounding text NOT NULL DEFAULT 'unconfigured' CHECK (overage_rounding IN ('unconfigured', 'ceil')),
  rate_card jsonb NOT NULL DEFAULT '{"dimensions":[]}'::jsonb CHECK (jsonb_typeof(rate_card) = 'object'),
  entitlements jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(entitlements) = 'object'),
  manifest_digest text NOT NULL CHECK (manifest_digest ~ '^[a-f0-9]{64}$'),
  published_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (plan_key, version),
  UNIQUE (commercial_plan_version_id, plan_key),
  CHECK ((pricing_status = 'unconfigured' AND billing_currency IS NULL AND billing_interval IS NULL
      AND base_charge_minor IS NULL AND tax_mode = 'unconfigured' AND overage_rounding = 'unconfigured')
    OR (pricing_status = 'configured' AND billing_currency IS NOT NULL AND billing_interval IS NOT NULL
      AND base_charge_minor IS NOT NULL AND tax_mode <> 'unconfigured' AND overage_rounding = 'ceil')),
  CHECK ((tax_mode = 'exclusive' AND tax_rate_basis_points IS NOT NULL)
    OR (tax_mode <> 'exclusive' AND tax_rate_basis_points IS NULL)),
  CHECK ((status = 'draft' AND published_at IS NULL) OR (status <> 'draft' AND published_at IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS __SOPHIA_RUNTIME_SCHEMA__.tenant_commercial_assignments (
  commercial_assignment_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES __SOPHIA_RUNTIME_SCHEMA__.customers(customer_id) ON DELETE CASCADE,
  commercial_plan_version_id uuid NOT NULL REFERENCES __SOPHIA_RUNTIME_SCHEMA__.commercial_plan_versions(commercial_plan_version_id) ON DELETE RESTRICT,
  status text NOT NULL CHECK (status IN ('scheduled', 'active', 'ended')),
  effective_from timestamptz NOT NULL,
  effective_to timestamptz,
  assignment_revision integer NOT NULL DEFAULT 1 CHECK (assignment_revision > 0),
  assigned_by_identity text NOT NULL CHECK (length(assigned_by_identity) BETWEEN 1 AND 240),
  assignment_reason text NOT NULL CHECK (length(assignment_reason) BETWEEN 1 AND 500),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (effective_to IS NULL OR effective_to > effective_from),
  UNIQUE (commercial_assignment_id, customer_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_active_tenant_commercial_assignment
  ON __SOPHIA_RUNTIME_SCHEMA__.tenant_commercial_assignments(customer_id)
  WHERE status = 'active' AND effective_to IS NULL;

CREATE TABLE IF NOT EXISTS __SOPHIA_RUNTIME_SCHEMA__.billing_subscription_references (
  billing_subscription_reference_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES __SOPHIA_RUNTIME_SCHEMA__.customers(customer_id) ON DELETE CASCADE,
  provider_key text NOT NULL CHECK (provider_key ~ '^[a-z][a-z0-9-]{1,79}$'),
  external_subscription_ref text NOT NULL CHECK (length(external_subscription_ref) BETWEEN 1 AND 240),
  status text NOT NULL CHECK (status IN ('pending', 'trialing', 'active', 'past_due', 'paused', 'cancelled', 'unknown')),
  current_period_start timestamptz,
  current_period_end timestamptz,
  observed_at timestamptz NOT NULL,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  UNIQUE (customer_id, provider_key, external_subscription_ref),
  UNIQUE (billing_subscription_reference_id, customer_id)
);

CREATE TABLE IF NOT EXISTS __SOPHIA_RUNTIME_SCHEMA__.billing_invoice_references (
  billing_invoice_reference_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES __SOPHIA_RUNTIME_SCHEMA__.customers(customer_id) ON DELETE CASCADE,
  provider_key text NOT NULL CHECK (provider_key ~ '^[a-z][a-z0-9-]{1,79}$'),
  external_invoice_ref text NOT NULL CHECK (length(external_invoice_ref) BETWEEN 1 AND 240),
  status text NOT NULL CHECK (status IN ('draft', 'open', 'paid', 'void', 'uncollectible', 'unknown')),
  currency text CHECK (currency IS NULL OR currency ~ '^[A-Z]{3}$'),
  amount_due_minor bigint CHECK (amount_due_minor IS NULL OR amount_due_minor >= 0),
  amount_paid_minor bigint CHECK (amount_paid_minor IS NULL OR amount_paid_minor >= 0),
  hosted_invoice_url text CHECK (hosted_invoice_url IS NULL OR hosted_invoice_url ~ '^https://'),
  due_at timestamptz,
  observed_at timestamptz NOT NULL,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  CHECK ((currency IS NULL AND amount_due_minor IS NULL AND amount_paid_minor IS NULL)
    OR (currency IS NOT NULL AND amount_due_minor IS NOT NULL AND amount_paid_minor IS NOT NULL)),
  UNIQUE (customer_id, provider_key, external_invoice_ref),
  UNIQUE (billing_invoice_reference_id, customer_id)
);

CREATE OR REPLACE FUNCTION __SOPHIA_RUNTIME_SCHEMA__.protect_commercial_plan_version()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status IN ('published', 'retired') THEN
    RAISE EXCEPTION 'Published commercial plan versions are immutable';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS protect_commercial_plan_version ON __SOPHIA_RUNTIME_SCHEMA__.commercial_plan_versions;
CREATE TRIGGER protect_commercial_plan_version BEFORE UPDATE OR DELETE
  ON __SOPHIA_RUNTIME_SCHEMA__.commercial_plan_versions
  FOR EACH ROW EXECUTE FUNCTION __SOPHIA_RUNTIME_SCHEMA__.protect_commercial_plan_version();

ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.tenant_commercial_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.tenant_commercial_assignments FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_commercial_assignments_tenant_isolation
  ON __SOPHIA_RUNTIME_SCHEMA__.tenant_commercial_assignments;
CREATE POLICY tenant_commercial_assignments_tenant_isolation
  ON __SOPHIA_RUNTIME_SCHEMA__.tenant_commercial_assignments
  USING (customer_id = NULLIF(current_setting('sophia.tenant_id', true), '')::uuid)
  WITH CHECK (customer_id = NULLIF(current_setting('sophia.tenant_id', true), '')::uuid);

ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.billing_subscription_references ENABLE ROW LEVEL SECURITY;
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.billing_subscription_references FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS billing_subscription_references_tenant_isolation
  ON __SOPHIA_RUNTIME_SCHEMA__.billing_subscription_references;
CREATE POLICY billing_subscription_references_tenant_isolation
  ON __SOPHIA_RUNTIME_SCHEMA__.billing_subscription_references
  USING (customer_id = NULLIF(current_setting('sophia.tenant_id', true), '')::uuid)
  WITH CHECK (customer_id = NULLIF(current_setting('sophia.tenant_id', true), '')::uuid);

ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.billing_invoice_references ENABLE ROW LEVEL SECURITY;
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.billing_invoice_references FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS billing_invoice_references_tenant_isolation
  ON __SOPHIA_RUNTIME_SCHEMA__.billing_invoice_references;
CREATE POLICY billing_invoice_references_tenant_isolation
  ON __SOPHIA_RUNTIME_SCHEMA__.billing_invoice_references
  USING (customer_id = NULLIF(current_setting('sophia.tenant_id', true), '')::uuid)
  WITH CHECK (customer_id = NULLIF(current_setting('sophia.tenant_id', true), '')::uuid);

REVOKE ALL ON __SOPHIA_RUNTIME_SCHEMA__.commercial_plan_versions FROM sophia_runtime_app;
REVOKE ALL ON __SOPHIA_RUNTIME_SCHEMA__.tenant_commercial_assignments FROM sophia_runtime_app;
REVOKE ALL ON __SOPHIA_RUNTIME_SCHEMA__.billing_subscription_references FROM sophia_runtime_app;
REVOKE ALL ON __SOPHIA_RUNTIME_SCHEMA__.billing_invoice_references FROM sophia_runtime_app;
GRANT SELECT ON __SOPHIA_RUNTIME_SCHEMA__.commercial_plan_versions TO sophia_runtime_app;
GRANT SELECT ON __SOPHIA_RUNTIME_SCHEMA__.tenant_commercial_assignments TO sophia_runtime_app;
GRANT SELECT ON __SOPHIA_RUNTIME_SCHEMA__.billing_subscription_references TO sophia_runtime_app;
GRANT SELECT ON __SOPHIA_RUNTIME_SCHEMA__.billing_invoice_references TO sophia_runtime_app;
