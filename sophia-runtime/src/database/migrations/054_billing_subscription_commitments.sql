ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.billing_subscription_references
  ADD COLUMN IF NOT EXISTS commercial_plan_version_id uuid
    REFERENCES __SOPHIA_RUNTIME_SCHEMA__.commercial_plan_versions(commercial_plan_version_id) ON DELETE RESTRICT;

CREATE OR REPLACE FUNCTION __SOPHIA_RUNTIME_SCHEMA__.protect_billing_reference_identity()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.customer_id<>OLD.customer_id OR NEW.provider_key<>OLD.provider_key
    OR NEW.provider_environment<>OLD.provider_environment
    OR NEW.provider_account_key<>OLD.provider_account_key THEN
    RAISE EXCEPTION 'Billing reference tenant/provider/account identity is immutable';
  END IF;
  IF TG_TABLE_NAME='billing_subscription_references' THEN
    IF NEW.external_subscription_ref<>OLD.external_subscription_ref THEN
      RAISE EXCEPTION 'Billing subscription reference identity is immutable';
    END IF;
    IF OLD.commercial_plan_version_id IS NOT NULL
      AND NEW.commercial_plan_version_id IS DISTINCT FROM OLD.commercial_plan_version_id THEN
      RAISE EXCEPTION 'Billing subscription commercial plan identity is immutable once observed';
    END IF;
  ELSIF TG_TABLE_NAME='billing_invoice_references' THEN
    IF NEW.external_invoice_ref<>OLD.external_invoice_ref THEN
      RAISE EXCEPTION 'Billing invoice reference identity is immutable';
    END IF;
  ELSE
    RAISE EXCEPTION 'Billing reference trigger is attached to an unsupported table';
  END IF;
  IF NEW.revision<>OLD.revision+1 OR NEW.observed_at<OLD.observed_at THEN
    RAISE EXCEPTION 'Billing references must advance monotonically';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TABLE IF NOT EXISTS __SOPHIA_RUNTIME_SCHEMA__.billing_subscription_commitments (
  billing_subscription_commitment_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES __SOPHIA_RUNTIME_SCHEMA__.customers(customer_id) ON DELETE RESTRICT,
  billing_subscription_reference_id uuid NOT NULL,
  commercial_assignment_id uuid NOT NULL,
  commercial_plan_version_id uuid NOT NULL REFERENCES __SOPHIA_RUNTIME_SCHEMA__.commercial_plan_versions(commercial_plan_version_id) ON DELETE RESTRICT,
  provider_key text NOT NULL CHECK (provider_key ~ '^[a-z][a-z0-9-]{1,79}$'),
  provider_environment text NOT NULL CHECK (provider_environment IN ('sandbox','live')),
  provider_account_key text NOT NULL CHECK (provider_account_key ~ '^[a-z][a-z0-9-]{1,79}$'),
  external_subscription_ref text NOT NULL CHECK (length(external_subscription_ref) BETWEEN 1 AND 240),
  required_periods integer NOT NULL CHECK (required_periods BETWEEN 1 AND 120),
  commencement_period_start timestamptz NOT NULL,
  commencement_period_end timestamptz NOT NULL,
  periods_observed integer NOT NULL DEFAULT 1 CHECK (periods_observed BETWEEN 1 AND 120),
  commitment_end timestamptz,
  last_observed_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (billing_subscription_reference_id),
  UNIQUE (billing_subscription_commitment_id,customer_id),
  UNIQUE (provider_key,provider_environment,provider_account_key,external_subscription_ref),
  FOREIGN KEY (billing_subscription_reference_id,customer_id)
    REFERENCES __SOPHIA_RUNTIME_SCHEMA__.billing_subscription_references(billing_subscription_reference_id,customer_id) ON DELETE RESTRICT,
  FOREIGN KEY (commercial_assignment_id,customer_id)
    REFERENCES __SOPHIA_RUNTIME_SCHEMA__.tenant_commercial_assignments(commercial_assignment_id,customer_id) ON DELETE RESTRICT,
  CHECK (commencement_period_end>commencement_period_start),
  CHECK (periods_observed<=required_periods),
  CHECK ((periods_observed<required_periods AND commitment_end IS NULL)
    OR (periods_observed=required_periods AND commitment_end IS NOT NULL
      AND commitment_end>=commencement_period_end)),
  CHECK (updated_at>=created_at)
);

CREATE OR REPLACE FUNCTION __SOPHIA_RUNTIME_SCHEMA__.protect_billing_subscription_commitment()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.billing_subscription_commitment_id<>OLD.billing_subscription_commitment_id
    OR NEW.customer_id<>OLD.customer_id
    OR NEW.billing_subscription_reference_id<>OLD.billing_subscription_reference_id
    OR NEW.commercial_assignment_id<>OLD.commercial_assignment_id
    OR NEW.commercial_plan_version_id<>OLD.commercial_plan_version_id
    OR NEW.provider_key<>OLD.provider_key OR NEW.provider_environment<>OLD.provider_environment
    OR NEW.provider_account_key<>OLD.provider_account_key
    OR NEW.external_subscription_ref<>OLD.external_subscription_ref
    OR NEW.required_periods<>OLD.required_periods
    OR NEW.commencement_period_start<>OLD.commencement_period_start
    OR NEW.commencement_period_end<>OLD.commencement_period_end
    OR NEW.created_at<>OLD.created_at THEN
    RAISE EXCEPTION 'Billing subscription commitment identity and contractual terms are immutable';
  END IF;
  IF NEW.periods_observed<OLD.periods_observed OR NEW.last_observed_at<OLD.last_observed_at
    OR NEW.updated_at<OLD.updated_at THEN
    RAISE EXCEPTION 'Billing subscription commitment evidence must advance monotonically';
  END IF;
  IF OLD.commitment_end IS NOT NULL AND NEW.commitment_end IS DISTINCT FROM OLD.commitment_end THEN
    RAISE EXCEPTION 'Billing subscription commitment boundary is immutable once established';
  END IF;
  IF NEW.periods_observed=OLD.periods_observed
    AND NEW.commitment_end IS NOT DISTINCT FROM OLD.commitment_end
    AND NEW.last_observed_at=OLD.last_observed_at THEN
    RAISE EXCEPTION 'Billing subscription commitment update contains no new evidence';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_protect_billing_subscription_commitment
  ON __SOPHIA_RUNTIME_SCHEMA__.billing_subscription_commitments;
CREATE TRIGGER trg_protect_billing_subscription_commitment BEFORE UPDATE
  ON __SOPHIA_RUNTIME_SCHEMA__.billing_subscription_commitments FOR EACH ROW
  EXECUTE FUNCTION __SOPHIA_RUNTIME_SCHEMA__.protect_billing_subscription_commitment();

ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.billing_subscription_commitments ENABLE ROW LEVEL SECURITY;
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.billing_subscription_commitments FORCE ROW LEVEL SECURITY;
CREATE POLICY billing_subscription_commitments_tenant_isolation
  ON __SOPHIA_RUNTIME_SCHEMA__.billing_subscription_commitments
  USING (customer_id=NULLIF(current_setting('sophia.tenant_id',true),'')::uuid)
  WITH CHECK (customer_id=NULLIF(current_setting('sophia.tenant_id',true),'')::uuid);

REVOKE ALL ON __SOPHIA_RUNTIME_SCHEMA__.billing_subscription_commitments FROM PUBLIC,sophia_runtime_app;
GRANT SELECT,INSERT,UPDATE ON __SOPHIA_RUNTIME_SCHEMA__.billing_subscription_commitments TO sophia_runtime_app;

COMMENT ON TABLE __SOPHIA_RUNTIME_SCHEMA__.billing_subscription_commitments IS
  'Provider-period-derived minimum-term evidence. Portal cancellation remains disabled until the exact required-period end.';
COMMENT ON COLUMN __SOPHIA_RUNTIME_SCHEMA__.billing_subscription_references.commercial_plan_version_id IS
  'Signed provider subscription-metadata plan pin; null is permitted for pre-contract observations and becomes immutable once known.';
