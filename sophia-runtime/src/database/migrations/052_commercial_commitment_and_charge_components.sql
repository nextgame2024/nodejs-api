ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.commercial_plan_versions
  ADD COLUMN IF NOT EXISTS minimum_commitment_months integer;

ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.commercial_plan_versions
  DROP CONSTRAINT IF EXISTS commercial_plan_versions_minimum_commitment_months_check;
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.commercial_plan_versions
  ADD CONSTRAINT commercial_plan_versions_minimum_commitment_months_check
  CHECK (minimum_commitment_months IS NULL OR minimum_commitment_months BETWEEN 1 AND 120);

CREATE TABLE IF NOT EXISTS __SOPHIA_RUNTIME_SCHEMA__.commercial_plan_charge_components (
  commercial_plan_charge_component_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  commercial_plan_version_id uuid NOT NULL REFERENCES __SOPHIA_RUNTIME_SCHEMA__.commercial_plan_versions(
    commercial_plan_version_id) ON DELETE RESTRICT,
  component_key text NOT NULL CHECK (component_key ~ '^[a-z][a-z0-9-]{1,79}$'),
  charge_timing text NOT NULL CHECK (charge_timing IN ('initial_checkout','operator_milestone')),
  milestone_key text CHECK (milestone_key IS NULL OR milestone_key ~ '^[a-z][a-z0-9-]{1,79}$'),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  description text NOT NULL CHECK (length(description) BETWEEN 1 AND 240),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (commercial_plan_version_id,component_key),
  CHECK ((charge_timing='initial_checkout' AND milestone_key IS NULL)
    OR (charge_timing='operator_milestone' AND milestone_key IS NOT NULL))
);

CREATE OR REPLACE FUNCTION __SOPHIA_RUNTIME_SCHEMA__.protect_commercial_plan_charge_component()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE plan_status text;
BEGIN
  SELECT status INTO plan_status FROM __SOPHIA_RUNTIME_SCHEMA__.commercial_plan_versions
    WHERE commercial_plan_version_id=COALESCE(NEW.commercial_plan_version_id,OLD.commercial_plan_version_id);
  IF plan_status IS DISTINCT FROM 'draft' THEN
    RAISE EXCEPTION 'Published commercial plan charge components are immutable';
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS protect_commercial_plan_charge_component
  ON __SOPHIA_RUNTIME_SCHEMA__.commercial_plan_charge_components;
CREATE TRIGGER protect_commercial_plan_charge_component
  BEFORE INSERT OR UPDATE OR DELETE ON __SOPHIA_RUNTIME_SCHEMA__.commercial_plan_charge_components
  FOR EACH ROW EXECUTE FUNCTION __SOPHIA_RUNTIME_SCHEMA__.protect_commercial_plan_charge_component();

REVOKE ALL ON __SOPHIA_RUNTIME_SCHEMA__.commercial_plan_charge_components FROM PUBLIC,sophia_runtime_app;
GRANT SELECT ON __SOPHIA_RUNTIME_SCHEMA__.commercial_plan_charge_components TO sophia_runtime_app;

COMMENT ON COLUMN __SOPHIA_RUNTIME_SCHEMA__.commercial_plan_versions.minimum_commitment_months IS
  'Immutable minimum monthly contractual term for new assignments; null means no plan-defined minimum.';
COMMENT ON TABLE __SOPHIA_RUNTIME_SCHEMA__.commercial_plan_charge_components IS
  'Immutable one-time commercial obligations belonging to a plan version; provider delivery evidence is stored separately.';
