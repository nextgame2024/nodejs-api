ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.tool_admission_reservations
  ADD COLUMN IF NOT EXISTS tool_id text NOT NULL DEFAULT 'legacy.unknown',
  ADD COLUMN IF NOT EXISTS admission_class text NOT NULL DEFAULT 'sensitive'
    CHECK (admission_class IN ('read-search','mutation','sensitive'));

CREATE INDEX IF NOT EXISTS idx_tool_admission_class_recent
  ON __SOPHIA_RUNTIME_SCHEMA__.tool_admission_reservations(
    customer_id, session_id, admission_class, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tool_admission_tool_recent
  ON __SOPHIA_RUNTIME_SCHEMA__.tool_admission_reservations(
    customer_id, session_id, tool_id, created_at DESC);

CREATE OR REPLACE FUNCTION __SOPHIA_RUNTIME_SCHEMA__.provider_session_capacity_occupied(
  requested_adapter_key text
) RETURNS bigint
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = pg_catalog, __SOPHIA_RUNTIME_SCHEMA__
AS $$
  SELECT count(*)
  FROM __SOPHIA_RUNTIME_SCHEMA__.provider_session_allocations
  WHERE lifecycle_adapter_key = requested_adapter_key
    AND stage IN ('allocating','allocated','attached','cleanup_pending','cleaning')
$$;

REVOKE ALL ON FUNCTION __SOPHIA_RUNTIME_SCHEMA__.provider_session_capacity_occupied(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION __SOPHIA_RUNTIME_SCHEMA__.provider_session_capacity_occupied(text)
  TO sophia_runtime_app;

COMMENT ON FUNCTION __SOPHIA_RUNTIME_SCHEMA__.provider_session_capacity_occupied(text) IS
  'Provider-neutral global occupied-slot count used under an adapter-key advisory lock; commercial plans contain no vendor capacity.';
