ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.tool_calls
  ADD COLUMN IF NOT EXISTS canonical_tool_id text,
  ADD COLUMN IF NOT EXISTS tool_version text,
  ADD COLUMN IF NOT EXISTS capability_binding_id uuid REFERENCES __SOPHIA_RUNTIME_SCHEMA__.capability_bindings(capability_binding_id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS command_id uuid,
  ADD COLUMN IF NOT EXISTS provenance text,
  ADD COLUMN IF NOT EXISTS deadline_at timestamptz,
  ADD COLUMN IF NOT EXISTS attempt_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS outcome_class text;

ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.tool_calls
  DROP CONSTRAINT IF EXISTS tool_calls_status_check;
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.tool_calls
  ADD CONSTRAINT tool_calls_status_check CHECK (
    status IN ('accepted', 'executing', 'succeeded', 'failed', 'denied', 'timed_out', 'cancelled', 'unknown', 'outcome_unknown')
  );

ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.tool_calls
  DROP CONSTRAINT IF EXISTS tool_calls_provenance_check;
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.tool_calls
  ADD CONSTRAINT tool_calls_provenance_check CHECK (
    provenance IS NULL OR provenance IN (
      'server-provider-connection', 'verified-provider-webhook',
      'authenticated-user-action', 'untrusted-client-bridge'
    )
  );

ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.tool_calls
  DROP CONSTRAINT IF EXISTS tool_calls_outcome_class_check;
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.tool_calls
  ADD CONSTRAINT tool_calls_outcome_class_check CHECK (
    outcome_class IS NULL OR outcome_class IN ('success', 'denied', 'failed', 'cancelled', 'outcome_unknown')
  );

ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.tool_calls
  DROP CONSTRAINT IF EXISTS tool_calls_attempt_count_check;
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.tool_calls
  ADD CONSTRAINT tool_calls_attempt_count_check CHECK (attempt_count >= 0 AND attempt_count <= 3);

CREATE UNIQUE INDEX IF NOT EXISTS uq_sophia_tool_command_execution
  ON __SOPHIA_RUNTIME_SCHEMA__.tool_calls(session_id, canonical_tool_id, command_id)
  WHERE command_id IS NOT NULL AND canonical_tool_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_sophia_action_review_command
  ON __SOPHIA_RUNTIME_SCHEMA__.action_reviews(command_id);

ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.tool_calls ENABLE ROW LEVEL SECURITY;
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.tool_calls FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tool_calls_tenant_isolation ON __SOPHIA_RUNTIME_SCHEMA__.tool_calls;
CREATE POLICY tool_calls_tenant_isolation ON __SOPHIA_RUNTIME_SCHEMA__.tool_calls
  USING (customer_id = NULLIF(current_setting('sophia.tenant_id', true), '')::uuid)
  WITH CHECK (customer_id = NULLIF(current_setting('sophia.tenant_id', true), '')::uuid);

ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.action_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.action_reviews FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS action_reviews_tenant_isolation ON __SOPHIA_RUNTIME_SCHEMA__.action_reviews;
CREATE POLICY action_reviews_tenant_isolation ON __SOPHIA_RUNTIME_SCHEMA__.action_reviews
  USING (customer_id = NULLIF(current_setting('sophia.tenant_id', true), '')::uuid)
  WITH CHECK (customer_id = NULLIF(current_setting('sophia.tenant_id', true), '')::uuid);
