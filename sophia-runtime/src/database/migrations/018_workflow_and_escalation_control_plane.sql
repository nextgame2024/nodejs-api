CREATE TABLE IF NOT EXISTS __SOPHIA_RUNTIME_SCHEMA__.workflow_definitions (
  workflow_definition_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES __SOPHIA_RUNTIME_SCHEMA__.customers(customer_id) ON DELETE CASCADE,
  workflow_key text NOT NULL,
  template_key text NOT NULL,
  created_by_identity text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (customer_id, workflow_key),
  UNIQUE (workflow_definition_id, customer_id)
);

ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.connector_bindings
  ADD CONSTRAINT connector_bindings_id_customer_unique UNIQUE (connector_binding_id, customer_id);

CREATE TABLE IF NOT EXISTS __SOPHIA_RUNTIME_SCHEMA__.workflow_versions (
  workflow_version_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_definition_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'retired')),
  template_key text NOT NULL,
  template_version text NOT NULL,
  template_manifest_digest text NOT NULL,
  configuration jsonb NOT NULL,
  required_authorization jsonb NOT NULL,
  created_by_identity text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  published_by_identity text,
  published_at timestamptz,
  FOREIGN KEY (workflow_definition_id, customer_id)
    REFERENCES __SOPHIA_RUNTIME_SCHEMA__.workflow_definitions(workflow_definition_id, customer_id) ON DELETE CASCADE,
  UNIQUE (workflow_definition_id, version),
  UNIQUE (workflow_version_id, customer_id)
);

CREATE TABLE IF NOT EXISTS __SOPHIA_RUNTIME_SCHEMA__.workflow_run_references (
  workflow_run_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES __SOPHIA_RUNTIME_SCHEMA__.customers(customer_id) ON DELETE CASCADE,
  workflow_version_id uuid NOT NULL,
  capability_binding_id uuid NOT NULL REFERENCES __SOPHIA_RUNTIME_SCHEMA__.capability_bindings(capability_binding_id) ON DELETE RESTRICT,
  owner_key text NOT NULL,
  external_run_ref text NOT NULL,
  last_status text NOT NULL DEFAULT 'accepted'
    CHECK (last_status IN ('accepted', 'processing', 'succeeded', 'failed', 'cancelled', 'outcome_unknown')),
  last_status_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workflow_run_id, customer_id),
  FOREIGN KEY (workflow_version_id, customer_id)
    REFERENCES __SOPHIA_RUNTIME_SCHEMA__.workflow_versions(workflow_version_id, customer_id) ON DELETE RESTRICT,
  UNIQUE (customer_id, owner_key, external_run_ref)
);

CREATE TABLE IF NOT EXISTS __SOPHIA_RUNTIME_SCHEMA__.workflow_retry_commands (
  workflow_retry_command_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES __SOPHIA_RUNTIME_SCHEMA__.customers(customer_id) ON DELETE CASCADE,
  workflow_run_id uuid NOT NULL,
  idempotency_key text NOT NULL,
  status text NOT NULL DEFAULT 'executing' CHECK (status IN ('executing', 'succeeded', 'failed', 'outcome_unknown')),
  result jsonb,
  requested_by_identity text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  FOREIGN KEY (workflow_run_id, customer_id)
    REFERENCES __SOPHIA_RUNTIME_SCHEMA__.workflow_run_references(workflow_run_id, customer_id) ON DELETE RESTRICT,
  UNIQUE (customer_id, workflow_run_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS __SOPHIA_RUNTIME_SCHEMA__.escalation_destinations (
  escalation_destination_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES __SOPHIA_RUNTIME_SCHEMA__.customers(customer_id) ON DELETE CASCADE,
  destination_key text NOT NULL,
  display_name text NOT NULL,
  channel text NOT NULL CHECK (channel IN ('operations_inbox', 'callback', 'notification', 'live_transfer')),
  connector_binding_id uuid,
  availability text NOT NULL CHECK (availability IN ('supported', 'unsupported')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_by_identity text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (customer_id, destination_key),
  UNIQUE (escalation_destination_id, customer_id),
  FOREIGN KEY (connector_binding_id, customer_id)
    REFERENCES __SOPHIA_RUNTIME_SCHEMA__.connector_bindings(connector_binding_id, customer_id) ON DELETE RESTRICT,
  CHECK ((channel = 'operations_inbox' AND connector_binding_id IS NULL)
    OR (channel <> 'operations_inbox'))
);

CREATE TABLE IF NOT EXISTS __SOPHIA_RUNTIME_SCHEMA__.escalation_policies (
  escalation_policy_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES __SOPHIA_RUNTIME_SCHEMA__.customers(customer_id) ON DELETE CASCADE,
  policy_key text NOT NULL,
  created_by_identity text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (customer_id, policy_key),
  UNIQUE (escalation_policy_id, customer_id)
);

CREATE TABLE IF NOT EXISTS __SOPHIA_RUNTIME_SCHEMA__.escalation_policy_versions (
  escalation_policy_version_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  escalation_policy_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'retired')),
  configuration jsonb NOT NULL,
  created_by_identity text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  published_by_identity text,
  published_at timestamptz,
  FOREIGN KEY (escalation_policy_id, customer_id)
    REFERENCES __SOPHIA_RUNTIME_SCHEMA__.escalation_policies(escalation_policy_id, customer_id) ON DELETE CASCADE,
  UNIQUE (escalation_policy_id, version),
  UNIQUE (escalation_policy_version_id, customer_id)
);

CREATE TABLE IF NOT EXISTS __SOPHIA_RUNTIME_SCHEMA__.escalation_cases (
  escalation_case_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES __SOPHIA_RUNTIME_SCHEMA__.customers(customer_id) ON DELETE CASCADE,
  escalation_policy_version_id uuid NOT NULL,
  escalation_destination_id uuid NOT NULL,
  source_session_id uuid,
  reason_code text NOT NULL,
  summary text NOT NULL,
  contact_preference text,
  priority text NOT NULL CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'assigned', 'in_progress', 'resolved')),
  delivery_status text NOT NULL CHECK (delivery_status IN ('queued', 'pending', 'accepted', 'failed', 'unavailable')),
  transfer_status text NOT NULL CHECK (transfer_status IN ('not_requested', 'callback_requested', 'notification_accepted', 'live_connected', 'failed', 'unavailable')),
  assigned_to_identity text,
  resolution_code text,
  resolution_note text,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  FOREIGN KEY (escalation_policy_version_id, customer_id)
    REFERENCES __SOPHIA_RUNTIME_SCHEMA__.escalation_policy_versions(escalation_policy_version_id, customer_id) ON DELETE RESTRICT,
  FOREIGN KEY (escalation_destination_id, customer_id)
    REFERENCES __SOPHIA_RUNTIME_SCHEMA__.escalation_destinations(escalation_destination_id, customer_id) ON DELETE RESTRICT,
  UNIQUE (escalation_case_id, customer_id)
);

CREATE TABLE IF NOT EXISTS __SOPHIA_RUNTIME_SCHEMA__.escalation_case_events (
  escalation_case_event_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL,
  escalation_case_id uuid NOT NULL,
  event_type text NOT NULL CHECK (event_type IN ('created', 'assigned', 'started', 'resolved', 'delivery_status_changed')),
  status text NOT NULL,
  delivery_status text NOT NULL,
  transfer_status text NOT NULL,
  actor_identity text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (escalation_case_id, customer_id)
    REFERENCES __SOPHIA_RUNTIME_SCHEMA__.escalation_cases(escalation_case_id, customer_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_workflow_versions_customer_status
  ON __SOPHIA_RUNTIME_SCHEMA__.workflow_versions(customer_id, status);
CREATE INDEX IF NOT EXISTS idx_workflow_runs_customer_created
  ON __SOPHIA_RUNTIME_SCHEMA__.workflow_run_references(customer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_workflow_retry_commands_run
  ON __SOPHIA_RUNTIME_SCHEMA__.workflow_retry_commands(customer_id, workflow_run_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_escalation_cases_customer_status
  ON __SOPHIA_RUNTIME_SCHEMA__.escalation_cases(customer_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_escalation_case_events_case
  ON __SOPHIA_RUNTIME_SCHEMA__.escalation_case_events(customer_id, escalation_case_id, created_at);

CREATE OR REPLACE FUNCTION __SOPHIA_RUNTIME_SCHEMA__.protect_published_workflow_version()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status IN ('published', 'retired') THEN
    RAISE EXCEPTION 'Published workflow versions are immutable';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS protect_published_workflow_version ON __SOPHIA_RUNTIME_SCHEMA__.workflow_versions;
CREATE TRIGGER protect_published_workflow_version
  BEFORE UPDATE OR DELETE ON __SOPHIA_RUNTIME_SCHEMA__.workflow_versions
  FOR EACH ROW EXECUTE FUNCTION __SOPHIA_RUNTIME_SCHEMA__.protect_published_workflow_version();

CREATE OR REPLACE FUNCTION __SOPHIA_RUNTIME_SCHEMA__.protect_published_escalation_policy_version()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status IN ('published', 'retired') THEN
    RAISE EXCEPTION 'Published escalation policy versions are immutable';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS protect_published_escalation_policy_version ON __SOPHIA_RUNTIME_SCHEMA__.escalation_policy_versions;
CREATE TRIGGER protect_published_escalation_policy_version
  BEFORE UPDATE OR DELETE ON __SOPHIA_RUNTIME_SCHEMA__.escalation_policy_versions
  FOR EACH ROW EXECUTE FUNCTION __SOPHIA_RUNTIME_SCHEMA__.protect_published_escalation_policy_version();

CREATE OR REPLACE FUNCTION __SOPHIA_RUNTIME_SCHEMA__.protect_workflow_run_pin()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.workflow_version_id IS DISTINCT FROM OLD.workflow_version_id
     OR NEW.capability_binding_id IS DISTINCT FROM OLD.capability_binding_id
     OR NEW.owner_key IS DISTINCT FROM OLD.owner_key
     OR NEW.external_run_ref IS DISTINCT FROM OLD.external_run_ref THEN
    RAISE EXCEPTION 'Workflow run ownership and version pin are immutable';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS protect_workflow_run_pin ON __SOPHIA_RUNTIME_SCHEMA__.workflow_run_references;
CREATE TRIGGER protect_workflow_run_pin
  BEFORE UPDATE ON __SOPHIA_RUNTIME_SCHEMA__.workflow_run_references
  FOR EACH ROW EXECUTE FUNCTION __SOPHIA_RUNTIME_SCHEMA__.protect_workflow_run_pin();

CREATE OR REPLACE FUNCTION __SOPHIA_RUNTIME_SCHEMA__.enforce_workflow_run_binding_tenant()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM __SOPHIA_RUNTIME_SCHEMA__.capability_bindings b
    JOIN __SOPHIA_RUNTIME_SCHEMA__.business_profile_versions v
      ON v.business_profile_version_id = b.business_profile_version_id
    JOIN __SOPHIA_RUNTIME_SCHEMA__.business_profiles p
      ON p.business_profile_id = v.business_profile_id
    WHERE b.capability_binding_id = NEW.capability_binding_id
      AND p.customer_id = NEW.customer_id
  ) THEN
    RAISE EXCEPTION 'Workflow run capability binding must belong to the same tenant';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS enforce_workflow_run_binding_tenant ON __SOPHIA_RUNTIME_SCHEMA__.workflow_run_references;
CREATE TRIGGER enforce_workflow_run_binding_tenant
  BEFORE INSERT OR UPDATE OF capability_binding_id, customer_id
  ON __SOPHIA_RUNTIME_SCHEMA__.workflow_run_references
  FOR EACH ROW EXECUTE FUNCTION __SOPHIA_RUNTIME_SCHEMA__.enforce_workflow_run_binding_tenant();

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'workflow_definitions', 'workflow_versions', 'workflow_run_references', 'workflow_retry_commands',
    'escalation_destinations', 'escalation_policies', 'escalation_policy_versions',
    'escalation_cases', 'escalation_case_events'
  ] LOOP
    EXECUTE format('ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.%I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('DROP POLICY IF EXISTS %I ON __SOPHIA_RUNTIME_SCHEMA__.%I', table_name || '_tenant_isolation', table_name);
    EXECUTE format(
      'CREATE POLICY %I ON __SOPHIA_RUNTIME_SCHEMA__.%I USING (customer_id = NULLIF(current_setting(''sophia.tenant_id'', true), '''')::uuid) WITH CHECK (customer_id = NULLIF(current_setting(''sophia.tenant_id'', true), '''')::uuid)',
      table_name || '_tenant_isolation', table_name
    );
  END LOOP;
END $$;
