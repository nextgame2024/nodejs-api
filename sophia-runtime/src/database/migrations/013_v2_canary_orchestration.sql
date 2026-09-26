CREATE TABLE IF NOT EXISTS __SOPHIA_RUNTIME_SCHEMA__.runtime_bootstrap_grants (
  bootstrap_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES __SOPHIA_RUNTIME_SCHEMA__.customers(customer_id) ON DELETE CASCADE,
  device_id text NOT NULL,
  experience_key text NOT NULL,
  token_hash text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'issued' CHECK (status IN ('issued', 'redeemed', 'expired', 'revoked')),
  expires_at timestamptz NOT NULL,
  redeemed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sophia_runtime_bootstrap_tenant_expiry
  ON __SOPHIA_RUNTIME_SCHEMA__.runtime_bootstrap_grants(customer_id, status, expires_at);

ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.sessions
  ADD COLUMN IF NOT EXISTS runtime_api_version text NOT NULL DEFAULT 'v1',
  ADD COLUMN IF NOT EXISTS bootstrap_id uuid REFERENCES __SOPHIA_RUNTIME_SCHEMA__.runtime_bootstrap_grants(bootstrap_id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS experience_profile_version_id uuid REFERENCES __SOPHIA_RUNTIME_SCHEMA__.experience_profile_versions(experience_profile_version_id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS session_plan_snapshot jsonb,
  ADD COLUMN IF NOT EXISTS session_plan_digest text;

ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.sessions
  DROP CONSTRAINT IF EXISTS sessions_runtime_api_version_check;
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.sessions
  ADD CONSTRAINT sessions_runtime_api_version_check CHECK (runtime_api_version IN ('v1', 'v2'));
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.sessions
  DROP CONSTRAINT IF EXISTS sessions_v2_snapshot_check;
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.sessions
  ADD CONSTRAINT sessions_v2_snapshot_check CHECK (
    runtime_api_version = 'v1'
    OR (
      bootstrap_id IS NOT NULL
      AND experience_profile_version_id IS NOT NULL
      AND agent_release_id IS NOT NULL
      AND session_plan_snapshot IS NOT NULL
      AND session_plan_digest IS NOT NULL
    )
  );

CREATE OR REPLACE FUNCTION __SOPHIA_RUNTIME_SCHEMA__.protect_session_v2_snapshot()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.runtime_api_version IS DISTINCT FROM OLD.runtime_api_version
     OR NEW.bootstrap_id IS DISTINCT FROM OLD.bootstrap_id
     OR NEW.experience_profile_version_id IS DISTINCT FROM OLD.experience_profile_version_id
     OR NEW.session_plan_snapshot IS DISTINCT FROM OLD.session_plan_snapshot
     OR NEW.session_plan_digest IS DISTINCT FROM OLD.session_plan_digest THEN
    RAISE EXCEPTION 'A session orchestration snapshot is immutable';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS protect_session_v2_snapshot ON __SOPHIA_RUNTIME_SCHEMA__.sessions;
CREATE TRIGGER protect_session_v2_snapshot
  BEFORE UPDATE OF runtime_api_version, bootstrap_id, experience_profile_version_id,
                   session_plan_snapshot, session_plan_digest
  ON __SOPHIA_RUNTIME_SCHEMA__.sessions
  FOR EACH ROW EXECUTE FUNCTION __SOPHIA_RUNTIME_SCHEMA__.protect_session_v2_snapshot();

CREATE OR REPLACE FUNCTION __SOPHIA_RUNTIME_SCHEMA__.validate_session_v2_tenant()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.runtime_api_version = 'v2' AND NOT EXISTS (
    SELECT 1
    FROM __SOPHIA_RUNTIME_SCHEMA__.experience_profile_versions v
    JOIN __SOPHIA_RUNTIME_SCHEMA__.experience_profiles p
      ON p.experience_profile_id = v.experience_profile_id
    WHERE v.experience_profile_version_id = NEW.experience_profile_version_id
      AND p.customer_id = NEW.customer_id
  ) THEN
    RAISE EXCEPTION 'V2 session profile must belong to the session tenant';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS validate_session_v2_tenant ON __SOPHIA_RUNTIME_SCHEMA__.sessions;
CREATE TRIGGER validate_session_v2_tenant
  BEFORE INSERT OR UPDATE OF customer_id, experience_profile_version_id, runtime_api_version
  ON __SOPHIA_RUNTIME_SCHEMA__.sessions
  FOR EACH ROW EXECUTE FUNCTION __SOPHIA_RUNTIME_SCHEMA__.validate_session_v2_tenant();

ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.runtime_bootstrap_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.runtime_bootstrap_grants FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS runtime_bootstrap_grants_tenant_isolation
  ON __SOPHIA_RUNTIME_SCHEMA__.runtime_bootstrap_grants;
CREATE POLICY runtime_bootstrap_grants_tenant_isolation
  ON __SOPHIA_RUNTIME_SCHEMA__.runtime_bootstrap_grants
  USING (customer_id = NULLIF(current_setting('sophia.tenant_id', true), '')::uuid)
  WITH CHECK (customer_id = NULLIF(current_setting('sophia.tenant_id', true), '')::uuid);
