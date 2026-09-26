ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.privacy_subject_requests
  ADD COLUMN IF NOT EXISTS processing_started_at timestamptz;

ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.privacy_subject_request_targets
  ADD COLUMN IF NOT EXISTS result_counts jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(result_counts) = 'object'),
  ADD COLUMN IF NOT EXISTS verification_method text
    CHECK (verification_method IS NULL OR verification_method IN (
      'runtime_transaction', 'owner_api', 'approved_not_stored', 'documented_manual_evidence'
      , 'system_evaluation'
    ));

CREATE TABLE IF NOT EXISTS __SOPHIA_RUNTIME_SCHEMA__.privacy_subject_bindings (
  privacy_subject_binding_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL,
  subject_reference_digest text NOT NULL CHECK (subject_reference_digest ~ '^[a-f0-9]{64}$'),
  session_id uuid NOT NULL,
  created_by_request_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (session_id, customer_id)
    REFERENCES __SOPHIA_RUNTIME_SCHEMA__.sessions(session_id, customer_id) ON DELETE CASCADE,
  FOREIGN KEY (created_by_request_id, customer_id)
    REFERENCES __SOPHIA_RUNTIME_SCHEMA__.privacy_subject_requests(privacy_subject_request_id, customer_id) ON DELETE CASCADE,
  UNIQUE (customer_id, subject_reference_digest, session_id)
);

CREATE TABLE IF NOT EXISTS __SOPHIA_RUNTIME_SCHEMA__.privacy_subject_request_events (
  privacy_subject_request_event_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL,
  privacy_subject_request_id uuid NOT NULL,
  event_type text NOT NULL CHECK (event_type IN (
    'created', 'verified', 'rejected', 'execution_started', 'target_completed',
    'target_blocked', 'completed', 'blocked'
  )),
  actor_identity text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (privacy_subject_request_id, customer_id)
    REFERENCES __SOPHIA_RUNTIME_SCHEMA__.privacy_subject_requests(privacy_subject_request_id, customer_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS __SOPHIA_RUNTIME_SCHEMA__.privacy_retention_runs (
  privacy_retention_run_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES __SOPHIA_RUNTIME_SCHEMA__.customers(customer_id) ON DELETE CASCADE,
  privacy_retention_policy_id uuid NOT NULL,
  dataset_key text NOT NULL CHECK (dataset_key IN ('session_content', 'review_payloads')),
  status text NOT NULL CHECK (status IN ('previewed', 'completed', 'blocked')),
  cutoff_at timestamptz NOT NULL,
  execute_requested boolean NOT NULL,
  candidate_count integer NOT NULL DEFAULT 0 CHECK (candidate_count >= 0),
  held_count integer NOT NULL DEFAULT 0 CHECK (held_count >= 0),
  unbound_count integer NOT NULL DEFAULT 0 CHECK (unbound_count >= 0),
  unsafe_cleanup_count integer NOT NULL DEFAULT 0 CHECK (unsafe_cleanup_count >= 0),
  processed_count integer NOT NULL DEFAULT 0 CHECK (processed_count >= 0),
  outcome_digest text NOT NULL CHECK (outcome_digest ~ '^[a-f0-9]{64}$'),
  created_by_identity text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (privacy_retention_policy_id, customer_id)
    REFERENCES __SOPHIA_RUNTIME_SCHEMA__.privacy_retention_policies(privacy_retention_policy_id, customer_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_privacy_subject_bindings_session
  ON __SOPHIA_RUNTIME_SCHEMA__.privacy_subject_bindings(customer_id, session_id);
CREATE INDEX IF NOT EXISTS idx_privacy_subject_request_events_request
  ON __SOPHIA_RUNTIME_SCHEMA__.privacy_subject_request_events(customer_id, privacy_subject_request_id, created_at);
CREATE INDEX IF NOT EXISTS idx_privacy_retention_runs_customer_created
  ON __SOPHIA_RUNTIME_SCHEMA__.privacy_retention_runs(customer_id, created_at DESC);

CREATE OR REPLACE FUNCTION __SOPHIA_RUNTIME_SCHEMA__.protect_privacy_request_event()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Privacy request events are append-only';
END;
$$;
DROP TRIGGER IF EXISTS protect_privacy_request_event ON __SOPHIA_RUNTIME_SCHEMA__.privacy_subject_request_events;
CREATE TRIGGER protect_privacy_request_event BEFORE UPDATE OR DELETE
  ON __SOPHIA_RUNTIME_SCHEMA__.privacy_subject_request_events
  FOR EACH ROW EXECUTE FUNCTION __SOPHIA_RUNTIME_SCHEMA__.protect_privacy_request_event();

CREATE OR REPLACE FUNCTION __SOPHIA_RUNTIME_SCHEMA__.protect_privacy_retention_run()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Privacy retention run evidence is immutable';
END;
$$;
DROP TRIGGER IF EXISTS protect_privacy_retention_run ON __SOPHIA_RUNTIME_SCHEMA__.privacy_retention_runs;
CREATE TRIGGER protect_privacy_retention_run BEFORE UPDATE OR DELETE
  ON __SOPHIA_RUNTIME_SCHEMA__.privacy_retention_runs
  FOR EACH ROW EXECUTE FUNCTION __SOPHIA_RUNTIME_SCHEMA__.protect_privacy_retention_run();

CREATE OR REPLACE FUNCTION __SOPHIA_RUNTIME_SCHEMA__.protect_privacy_request_target()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.customer_id IS DISTINCT FROM OLD.customer_id
     OR NEW.privacy_subject_request_id IS DISTINCT FROM OLD.privacy_subject_request_id
     OR NEW.target_key IS DISTINCT FROM OLD.target_key
     OR NEW.ownership IS DISTINCT FROM OLD.ownership
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'Privacy request target identity is immutable';
  END IF;
  IF OLD.status IN ('completed', 'not_applicable') AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'Verified privacy request target evidence is immutable';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS protect_privacy_request_target ON __SOPHIA_RUNTIME_SCHEMA__.privacy_subject_request_targets;
CREATE TRIGGER protect_privacy_request_target BEFORE UPDATE
  ON __SOPHIA_RUNTIME_SCHEMA__.privacy_subject_request_targets
  FOR EACH ROW EXECUTE FUNCTION __SOPHIA_RUNTIME_SCHEMA__.protect_privacy_request_target();

CREATE OR REPLACE FUNCTION __SOPHIA_RUNTIME_SCHEMA__.protect_privacy_evidence_delete()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Privacy lifecycle evidence cannot be deleted';
END;
$$;
DROP TRIGGER IF EXISTS protect_privacy_subject_request_delete ON __SOPHIA_RUNTIME_SCHEMA__.privacy_subject_requests;
CREATE TRIGGER protect_privacy_subject_request_delete BEFORE DELETE
  ON __SOPHIA_RUNTIME_SCHEMA__.privacy_subject_requests
  FOR EACH ROW EXECUTE FUNCTION __SOPHIA_RUNTIME_SCHEMA__.protect_privacy_evidence_delete();
DROP TRIGGER IF EXISTS protect_privacy_request_target_delete ON __SOPHIA_RUNTIME_SCHEMA__.privacy_subject_request_targets;
CREATE TRIGGER protect_privacy_request_target_delete BEFORE DELETE
  ON __SOPHIA_RUNTIME_SCHEMA__.privacy_subject_request_targets
  FOR EACH ROW EXECUTE FUNCTION __SOPHIA_RUNTIME_SCHEMA__.protect_privacy_evidence_delete();
DROP TRIGGER IF EXISTS protect_privacy_legal_hold_delete ON __SOPHIA_RUNTIME_SCHEMA__.privacy_legal_holds;
CREATE TRIGGER protect_privacy_legal_hold_delete BEFORE DELETE
  ON __SOPHIA_RUNTIME_SCHEMA__.privacy_legal_holds
  FOR EACH ROW EXECUTE FUNCTION __SOPHIA_RUNTIME_SCHEMA__.protect_privacy_evidence_delete();

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'privacy_subject_bindings', 'privacy_subject_request_events', 'privacy_retention_runs'
  ] LOOP
    EXECUTE format('ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.%I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('DROP POLICY IF EXISTS %I ON __SOPHIA_RUNTIME_SCHEMA__.%I', table_name || '_tenant_isolation', table_name);
    EXECUTE format(
      'CREATE POLICY %I ON __SOPHIA_RUNTIME_SCHEMA__.%I USING (customer_id = NULLIF(current_setting(''sophia.tenant_id'', true), '''')::uuid) WITH CHECK (customer_id = NULLIF(current_setting(''sophia.tenant_id'', true), '''')::uuid)',
      table_name || '_tenant_isolation', table_name
    );
  END LOOP;
END;
$$;

REVOKE DELETE ON
  __SOPHIA_RUNTIME_SCHEMA__.privacy_notice_versions,
  __SOPHIA_RUNTIME_SCHEMA__.privacy_consent_events,
  __SOPHIA_RUNTIME_SCHEMA__.privacy_retention_policies,
  __SOPHIA_RUNTIME_SCHEMA__.privacy_legal_holds,
  __SOPHIA_RUNTIME_SCHEMA__.privacy_subject_requests,
  __SOPHIA_RUNTIME_SCHEMA__.privacy_subject_request_targets,
  __SOPHIA_RUNTIME_SCHEMA__.privacy_data_flows,
  __SOPHIA_RUNTIME_SCHEMA__.privacy_legal_reviews,
  __SOPHIA_RUNTIME_SCHEMA__.privacy_subject_bindings,
  __SOPHIA_RUNTIME_SCHEMA__.privacy_subject_request_events,
  __SOPHIA_RUNTIME_SCHEMA__.privacy_retention_runs
FROM sophia_runtime_app;
GRANT SELECT, INSERT, UPDATE ON __SOPHIA_RUNTIME_SCHEMA__.privacy_subject_bindings TO sophia_runtime_app;
GRANT SELECT, INSERT ON
  __SOPHIA_RUNTIME_SCHEMA__.privacy_subject_request_events,
  __SOPHIA_RUNTIME_SCHEMA__.privacy_retention_runs
TO sophia_runtime_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA __SOPHIA_RUNTIME_SCHEMA__ TO sophia_runtime_app;
