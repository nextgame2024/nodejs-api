CREATE TABLE IF NOT EXISTS __SOPHIA_RUNTIME_SCHEMA__.evaluation_datasets (
  evaluation_dataset_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES __SOPHIA_RUNTIME_SCHEMA__.customers(customer_id) ON DELETE CASCADE,
  dataset_key text NOT NULL CHECK (dataset_key ~ '^[a-z0-9][a-z0-9.-]{0,119}$'),
  display_name text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 160),
  created_by_identity text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (customer_id, dataset_key),
  UNIQUE (evaluation_dataset_id, customer_id)
);

CREATE TABLE IF NOT EXISTS __SOPHIA_RUNTIME_SCHEMA__.evaluation_dataset_versions (
  evaluation_dataset_version_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  evaluation_dataset_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved', 'retired')),
  evaluator_key text NOT NULL,
  evaluator_version integer NOT NULL CHECK (evaluator_version > 0),
  evidence_mode text NOT NULL CHECK (evidence_mode = 'deterministic'),
  cases jsonb NOT NULL CHECK (jsonb_typeof(cases) = 'array' AND jsonb_array_length(cases) BETWEEN 1 AND 100),
  created_by_identity text NOT NULL,
  approved_by_identity text,
  approved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (evaluation_dataset_id, customer_id)
    REFERENCES __SOPHIA_RUNTIME_SCHEMA__.evaluation_datasets(evaluation_dataset_id, customer_id) ON DELETE CASCADE,
  UNIQUE (evaluation_dataset_id, version),
  UNIQUE (evaluation_dataset_version_id, customer_id),
  CHECK ((status = 'approved' AND approved_by_identity IS NOT NULL AND approved_at IS NOT NULL)
    OR status <> 'approved')
);

CREATE TABLE IF NOT EXISTS __SOPHIA_RUNTIME_SCHEMA__.agent_evaluation_requirements (
  agent_evaluation_requirement_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL,
  agent_id uuid NOT NULL,
  evaluation_dataset_version_id uuid NOT NULL,
  required_for_publication boolean NOT NULL DEFAULT true,
  configured_by_identity text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (agent_id, customer_id)
    REFERENCES __SOPHIA_RUNTIME_SCHEMA__.agents(agent_id, customer_id) ON DELETE CASCADE,
  FOREIGN KEY (evaluation_dataset_version_id, customer_id)
    REFERENCES __SOPHIA_RUNTIME_SCHEMA__.evaluation_dataset_versions(evaluation_dataset_version_id, customer_id),
  UNIQUE (agent_id, evaluation_dataset_version_id)
);

CREATE TABLE IF NOT EXISTS __SOPHIA_RUNTIME_SCHEMA__.evaluation_runs (
  evaluation_run_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL,
  agent_id uuid NOT NULL,
  evaluation_dataset_version_id uuid NOT NULL,
  target_type text NOT NULL CHECK (target_type IN ('draft', 'release')),
  target_draft_revision integer,
  target_release_id uuid,
  evaluator_key text NOT NULL,
  evaluator_version integer NOT NULL,
  evidence_mode text NOT NULL CHECK (evidence_mode IN ('deterministic', 'mocked-provider-contract', 'live-provider')),
  status text NOT NULL CHECK (status IN ('passed', 'failed', 'blocked')),
  results jsonb NOT NULL CHECK (jsonb_typeof(results) = 'array'),
  configuration_digest text NOT NULL CHECK (configuration_digest ~ '^[a-f0-9]{64}$'),
  external_effects boolean NOT NULL DEFAULT false CHECK (external_effects = false),
  metered_session_created boolean NOT NULL DEFAULT false CHECK (metered_session_created = false),
  run_by_identity text NOT NULL,
  completed_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (agent_id, customer_id)
    REFERENCES __SOPHIA_RUNTIME_SCHEMA__.agents(agent_id, customer_id) ON DELETE CASCADE,
  FOREIGN KEY (evaluation_dataset_version_id, customer_id)
    REFERENCES __SOPHIA_RUNTIME_SCHEMA__.evaluation_dataset_versions(evaluation_dataset_version_id, customer_id),
  FOREIGN KEY (target_release_id, customer_id)
    REFERENCES __SOPHIA_RUNTIME_SCHEMA__.agent_release_manifests(agent_release_id, customer_id),
  CHECK ((target_type = 'draft' AND target_draft_revision IS NOT NULL AND target_release_id IS NULL)
    OR (target_type = 'release' AND target_draft_revision IS NULL AND target_release_id IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_evaluation_runs_publication
  ON __SOPHIA_RUNTIME_SCHEMA__.evaluation_runs(customer_id, agent_id, evaluation_dataset_version_id, target_draft_revision, completed_at DESC);

CREATE OR REPLACE FUNCTION __SOPHIA_RUNTIME_SCHEMA__.protect_evaluation_evidence()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Approved evaluation definitions and run evidence are immutable';
END;
$$;

CREATE OR REPLACE FUNCTION __SOPHIA_RUNTIME_SCHEMA__.protect_evaluation_version()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status IN ('approved', 'retired') THEN
    RAISE EXCEPTION 'Approved evaluation versions are immutable';
  END IF;
  IF NEW.evaluation_dataset_id IS DISTINCT FROM OLD.evaluation_dataset_id
     OR NEW.customer_id IS DISTINCT FROM OLD.customer_id
     OR NEW.version IS DISTINCT FROM OLD.version
     OR NEW.evaluator_key IS DISTINCT FROM OLD.evaluator_key
     OR NEW.evaluator_version IS DISTINCT FROM OLD.evaluator_version
     OR NEW.evidence_mode IS DISTINCT FROM OLD.evidence_mode
     OR NEW.cases IS DISTINCT FROM OLD.cases THEN
    RAISE EXCEPTION 'Evaluation version content is immutable';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS protect_evaluation_version ON __SOPHIA_RUNTIME_SCHEMA__.evaluation_dataset_versions;
CREATE TRIGGER protect_evaluation_version BEFORE UPDATE ON __SOPHIA_RUNTIME_SCHEMA__.evaluation_dataset_versions
  FOR EACH ROW EXECUTE FUNCTION __SOPHIA_RUNTIME_SCHEMA__.protect_evaluation_version();
DROP TRIGGER IF EXISTS protect_evaluation_version_delete ON __SOPHIA_RUNTIME_SCHEMA__.evaluation_dataset_versions;
CREATE TRIGGER protect_evaluation_version_delete BEFORE DELETE ON __SOPHIA_RUNTIME_SCHEMA__.evaluation_dataset_versions
  FOR EACH ROW EXECUTE FUNCTION __SOPHIA_RUNTIME_SCHEMA__.protect_evaluation_evidence();
DROP TRIGGER IF EXISTS protect_evaluation_run ON __SOPHIA_RUNTIME_SCHEMA__.evaluation_runs;
CREATE TRIGGER protect_evaluation_run BEFORE UPDATE OR DELETE ON __SOPHIA_RUNTIME_SCHEMA__.evaluation_runs
  FOR EACH ROW EXECUTE FUNCTION __SOPHIA_RUNTIME_SCHEMA__.protect_evaluation_evidence();

ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.evaluation_datasets ENABLE ROW LEVEL SECURITY;
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.evaluation_datasets FORCE ROW LEVEL SECURITY;
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.evaluation_dataset_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.evaluation_dataset_versions FORCE ROW LEVEL SECURITY;
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.agent_evaluation_requirements ENABLE ROW LEVEL SECURITY;
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.agent_evaluation_requirements FORCE ROW LEVEL SECURITY;
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.evaluation_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.evaluation_runs FORCE ROW LEVEL SECURITY;

DO $$ DECLARE table_name text; BEGIN
  FOREACH table_name IN ARRAY ARRAY['evaluation_datasets','evaluation_dataset_versions','agent_evaluation_requirements','evaluation_runs'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I_tenant_isolation ON __SOPHIA_RUNTIME_SCHEMA__.%I', table_name, table_name);
    EXECUTE format('CREATE POLICY %I_tenant_isolation ON __SOPHIA_RUNTIME_SCHEMA__.%I USING (customer_id = NULLIF(current_setting(''sophia.tenant_id'', true), '''')::uuid) WITH CHECK (customer_id = NULLIF(current_setting(''sophia.tenant_id'', true), '''')::uuid)', table_name, table_name);
  END LOOP;
END $$;

REVOKE ALL ON __SOPHIA_RUNTIME_SCHEMA__.evaluation_datasets FROM sophia_runtime_app;
REVOKE ALL ON __SOPHIA_RUNTIME_SCHEMA__.evaluation_dataset_versions FROM sophia_runtime_app;
REVOKE ALL ON __SOPHIA_RUNTIME_SCHEMA__.agent_evaluation_requirements FROM sophia_runtime_app;
REVOKE ALL ON __SOPHIA_RUNTIME_SCHEMA__.evaluation_runs FROM sophia_runtime_app;
GRANT SELECT, INSERT ON __SOPHIA_RUNTIME_SCHEMA__.evaluation_datasets TO sophia_runtime_app;
GRANT SELECT, INSERT, UPDATE ON __SOPHIA_RUNTIME_SCHEMA__.evaluation_dataset_versions TO sophia_runtime_app;
GRANT SELECT, INSERT, UPDATE ON __SOPHIA_RUNTIME_SCHEMA__.agent_evaluation_requirements TO sophia_runtime_app;
GRANT SELECT, INSERT ON __SOPHIA_RUNTIME_SCHEMA__.evaluation_runs TO sophia_runtime_app;
