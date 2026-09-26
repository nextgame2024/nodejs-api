ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.tool_calls
  ADD COLUMN IF NOT EXISTS invocation_id uuid,
  ADD COLUMN IF NOT EXISTS correlation_id uuid,
  ADD COLUMN IF NOT EXISTS policy_decision text,
  ADD COLUMN IF NOT EXISTS error_code text,
  ADD COLUMN IF NOT EXISTS accepted_at timestamptz,
  ADD COLUMN IF NOT EXISTS executing_at timestamptz,
  ADD COLUMN IF NOT EXISTS duration_ms integer;

UPDATE __SOPHIA_RUNTIME_SCHEMA__.tool_calls
SET invocation_id = COALESCE(invocation_id, tool_call_id),
    accepted_at = COALESCE(accepted_at, started_at),
    policy_decision = COALESCE(policy_decision, 'legacy'),
    status = CASE WHEN status = 'pending' THEN 'accepted' ELSE status END
WHERE invocation_id IS NULL OR accepted_at IS NULL OR policy_decision IS NULL OR status = 'pending';

ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.tool_calls
  ALTER COLUMN invocation_id SET NOT NULL,
  ALTER COLUMN accepted_at SET NOT NULL,
  ALTER COLUMN policy_decision SET NOT NULL;

ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.tool_calls
  ALTER COLUMN status SET DEFAULT 'accepted';

ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.tool_calls
  DROP CONSTRAINT IF EXISTS tool_calls_status_check;

ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.tool_calls
  ADD CONSTRAINT tool_calls_status_check
  CHECK (status IN ('accepted', 'executing', 'succeeded', 'failed', 'denied', 'timed_out', 'unknown'));

CREATE UNIQUE INDEX IF NOT EXISTS idx_sophia_runtime_tool_calls_invocation
  ON __SOPHIA_RUNTIME_SCHEMA__.tool_calls(invocation_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_sophia_runtime_tool_calls_provider_call
  ON __SOPHIA_RUNTIME_SCHEMA__.tool_calls(session_id, provider_call_id)
  WHERE provider_call_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_sophia_runtime_tool_calls_correlation
  ON __SOPHIA_RUNTIME_SCHEMA__.tool_calls(correlation_id)
  WHERE correlation_id IS NOT NULL;
