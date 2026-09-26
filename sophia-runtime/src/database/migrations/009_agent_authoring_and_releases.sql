CREATE TABLE IF NOT EXISTS __SOPHIA_RUNTIME_SCHEMA__.agents (
  agent_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES __SOPHIA_RUNTIME_SCHEMA__.customers(customer_id) ON DELETE CASCADE,
  agent_key text NOT NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'enabled', 'disabled', 'archived')),
  active_release_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (customer_id, agent_key),
  UNIQUE (agent_id, customer_id)
);

CREATE TABLE IF NOT EXISTS __SOPHIA_RUNTIME_SCHEMA__.instruction_sets (
  instruction_set_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES __SOPHIA_RUNTIME_SCHEMA__.customers(customer_id) ON DELETE CASCADE,
  instruction_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (customer_id, instruction_key)
);

CREATE TABLE IF NOT EXISTS __SOPHIA_RUNTIME_SCHEMA__.instruction_revisions (
  instruction_revision_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  instruction_set_id uuid NOT NULL REFERENCES __SOPHIA_RUNTIME_SCHEMA__.instruction_sets(instruction_set_id) ON DELETE CASCADE,
  revision integer NOT NULL CHECK (revision > 0),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved')),
  content text NOT NULL,
  tone text,
  greeting text,
  variable_schema jsonb NOT NULL DEFAULT '{"type":"object","properties":{},"additionalProperties":false}'::jsonb,
  created_by_identity text NOT NULL,
  approved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (instruction_set_id, revision)
);

CREATE TABLE IF NOT EXISTS __SOPHIA_RUNTIME_SCHEMA__.agent_drafts (
  agent_id uuid PRIMARY KEY REFERENCES __SOPHIA_RUNTIME_SCHEMA__.agents(agent_id) ON DELETE CASCADE,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  configuration jsonb NOT NULL,
  updated_by_identity text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS __SOPHIA_RUNTIME_SCHEMA__.agent_release_manifests (
  agent_release_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  release_number integer NOT NULL CHECK (release_number > 0),
  source_draft_revision integer NOT NULL CHECK (source_draft_revision > 0),
  manifest jsonb NOT NULL,
  manifest_digest text NOT NULL,
  platform_safety_policy_version text NOT NULL,
  release_notes text,
  published_by_identity text NOT NULL,
  published_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (agent_id, customer_id)
    REFERENCES __SOPHIA_RUNTIME_SCHEMA__.agents(agent_id, customer_id) ON DELETE CASCADE,
  UNIQUE (agent_id, release_number),
  UNIQUE (agent_release_id, agent_id),
  UNIQUE (agent_release_id, customer_id)
);

ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.agents
  DROP CONSTRAINT IF EXISTS agents_active_release_fk;
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.agents
  ADD CONSTRAINT agents_active_release_fk
  FOREIGN KEY (active_release_id, agent_id)
  REFERENCES __SOPHIA_RUNTIME_SCHEMA__.agent_release_manifests(agent_release_id, agent_id)
  ON DELETE RESTRICT;

CREATE TABLE IF NOT EXISTS __SOPHIA_RUNTIME_SCHEMA__.agent_release_revocations (
  agent_release_id uuid PRIMARY KEY REFERENCES __SOPHIA_RUNTIME_SCHEMA__.agent_release_manifests(agent_release_id) ON DELETE CASCADE,
  reason text NOT NULL,
  revoked_by_identity text NOT NULL,
  revoked_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.sessions
  ADD COLUMN IF NOT EXISTS agent_release_id uuid;
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.sessions
  DROP CONSTRAINT IF EXISTS sessions_agent_release_tenant_fk;
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.sessions
  ADD CONSTRAINT sessions_agent_release_tenant_fk
  FOREIGN KEY (agent_release_id, customer_id)
  REFERENCES __SOPHIA_RUNTIME_SCHEMA__.agent_release_manifests(agent_release_id, customer_id)
  ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS idx_sophia_agents_customer_status
  ON __SOPHIA_RUNTIME_SCHEMA__.agents(customer_id, status);
CREATE INDEX IF NOT EXISTS idx_sophia_agent_releases_agent_published
  ON __SOPHIA_RUNTIME_SCHEMA__.agent_release_manifests(agent_id, published_at DESC);

CREATE OR REPLACE FUNCTION __SOPHIA_RUNTIME_SCHEMA__.protect_agent_release_manifest()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Published agent release manifests are immutable';
END;
$$;

DROP TRIGGER IF EXISTS protect_agent_release_manifest ON __SOPHIA_RUNTIME_SCHEMA__.agent_release_manifests;
CREATE TRIGGER protect_agent_release_manifest
  BEFORE UPDATE OR DELETE ON __SOPHIA_RUNTIME_SCHEMA__.agent_release_manifests
  FOR EACH ROW EXECUTE FUNCTION __SOPHIA_RUNTIME_SCHEMA__.protect_agent_release_manifest();

CREATE OR REPLACE FUNCTION __SOPHIA_RUNTIME_SCHEMA__.protect_session_release_pin()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.agent_release_id IS DISTINCT FROM OLD.agent_release_id THEN
    RAISE EXCEPTION 'A session release manifest pin is immutable';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS protect_session_release_pin ON __SOPHIA_RUNTIME_SCHEMA__.sessions;
CREATE TRIGGER protect_session_release_pin
  BEFORE UPDATE OF agent_release_id ON __SOPHIA_RUNTIME_SCHEMA__.sessions
  FOR EACH ROW EXECUTE FUNCTION __SOPHIA_RUNTIME_SCHEMA__.protect_session_release_pin();

CREATE OR REPLACE FUNCTION __SOPHIA_RUNTIME_SCHEMA__.protect_approved_instruction_revision()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'approved' THEN
    RAISE EXCEPTION 'Approved instruction revisions are immutable';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS protect_approved_instruction_revision ON __SOPHIA_RUNTIME_SCHEMA__.instruction_revisions;
CREATE TRIGGER protect_approved_instruction_revision
  BEFORE UPDATE OR DELETE ON __SOPHIA_RUNTIME_SCHEMA__.instruction_revisions
  FOR EACH ROW EXECUTE FUNCTION __SOPHIA_RUNTIME_SCHEMA__.protect_approved_instruction_revision();

ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.agents ENABLE ROW LEVEL SECURITY;
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.agents FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS agents_tenant_isolation ON __SOPHIA_RUNTIME_SCHEMA__.agents;
CREATE POLICY agents_tenant_isolation ON __SOPHIA_RUNTIME_SCHEMA__.agents
  USING (customer_id = NULLIF(current_setting('sophia.tenant_id', true), '')::uuid)
  WITH CHECK (customer_id = NULLIF(current_setting('sophia.tenant_id', true), '')::uuid);

ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.instruction_sets ENABLE ROW LEVEL SECURITY;
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.instruction_sets FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS instruction_sets_tenant_isolation ON __SOPHIA_RUNTIME_SCHEMA__.instruction_sets;
CREATE POLICY instruction_sets_tenant_isolation ON __SOPHIA_RUNTIME_SCHEMA__.instruction_sets
  USING (customer_id = NULLIF(current_setting('sophia.tenant_id', true), '')::uuid)
  WITH CHECK (customer_id = NULLIF(current_setting('sophia.tenant_id', true), '')::uuid);

ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.agent_drafts ENABLE ROW LEVEL SECURITY;
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.agent_drafts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS agent_drafts_tenant_isolation ON __SOPHIA_RUNTIME_SCHEMA__.agent_drafts;
CREATE POLICY agent_drafts_tenant_isolation ON __SOPHIA_RUNTIME_SCHEMA__.agent_drafts
  USING (EXISTS (SELECT 1 FROM __SOPHIA_RUNTIME_SCHEMA__.agents a
    WHERE a.agent_id = agent_drafts.agent_id
      AND a.customer_id = NULLIF(current_setting('sophia.tenant_id', true), '')::uuid))
  WITH CHECK (EXISTS (SELECT 1 FROM __SOPHIA_RUNTIME_SCHEMA__.agents a
    WHERE a.agent_id = agent_drafts.agent_id
      AND a.customer_id = NULLIF(current_setting('sophia.tenant_id', true), '')::uuid));

ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.instruction_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.instruction_revisions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS instruction_revisions_tenant_isolation ON __SOPHIA_RUNTIME_SCHEMA__.instruction_revisions;
CREATE POLICY instruction_revisions_tenant_isolation ON __SOPHIA_RUNTIME_SCHEMA__.instruction_revisions
  USING (EXISTS (SELECT 1 FROM __SOPHIA_RUNTIME_SCHEMA__.instruction_sets s
    WHERE s.instruction_set_id = instruction_revisions.instruction_set_id
      AND s.customer_id = NULLIF(current_setting('sophia.tenant_id', true), '')::uuid))
  WITH CHECK (EXISTS (SELECT 1 FROM __SOPHIA_RUNTIME_SCHEMA__.instruction_sets s
    WHERE s.instruction_set_id = instruction_revisions.instruction_set_id
      AND s.customer_id = NULLIF(current_setting('sophia.tenant_id', true), '')::uuid));

ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.agent_release_manifests ENABLE ROW LEVEL SECURITY;
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.agent_release_manifests FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS agent_releases_tenant_isolation ON __SOPHIA_RUNTIME_SCHEMA__.agent_release_manifests;
CREATE POLICY agent_releases_tenant_isolation ON __SOPHIA_RUNTIME_SCHEMA__.agent_release_manifests
  USING (customer_id = NULLIF(current_setting('sophia.tenant_id', true), '')::uuid)
  WITH CHECK (customer_id = NULLIF(current_setting('sophia.tenant_id', true), '')::uuid);

ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.agent_release_revocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.agent_release_revocations FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS agent_revocations_tenant_isolation ON __SOPHIA_RUNTIME_SCHEMA__.agent_release_revocations;
CREATE POLICY agent_revocations_tenant_isolation ON __SOPHIA_RUNTIME_SCHEMA__.agent_release_revocations
  USING (EXISTS (SELECT 1 FROM __SOPHIA_RUNTIME_SCHEMA__.agent_release_manifests r
    JOIN __SOPHIA_RUNTIME_SCHEMA__.agents a ON a.agent_id = r.agent_id
    WHERE r.agent_release_id = agent_release_revocations.agent_release_id
      AND a.customer_id = NULLIF(current_setting('sophia.tenant_id', true), '')::uuid))
  WITH CHECK (EXISTS (SELECT 1 FROM __SOPHIA_RUNTIME_SCHEMA__.agent_release_manifests r
    JOIN __SOPHIA_RUNTIME_SCHEMA__.agents a ON a.agent_id = r.agent_id
    WHERE r.agent_release_id = agent_release_revocations.agent_release_id
      AND a.customer_id = NULLIF(current_setting('sophia.tenant_id', true), '')::uuid));
