CREATE TABLE IF NOT EXISTS __SOPHIA_RUNTIME_SCHEMA__.session_activity_intervals (
  session_activity_interval_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES __SOPHIA_RUNTIME_SCHEMA__.customers(customer_id) ON DELETE RESTRICT,
  session_id uuid NOT NULL,
  connection_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'finalised', 'expired')),
  started_at timestamptz NOT NULL DEFAULT now(),
  last_confirmed_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,
  end_reason text CHECK (end_reason IN ('client_disconnect', 'session_close', 'lease_expired', 'session_reconciled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (session_id, connection_id),
  FOREIGN KEY (session_id, customer_id)
    REFERENCES __SOPHIA_RUNTIME_SCHEMA__.sessions(session_id, customer_id) ON DELETE RESTRICT,
  CHECK (last_confirmed_at >= started_at),
  CHECK (
    (status = 'open' AND ended_at IS NULL AND end_reason IS NULL)
    OR (status IN ('finalised', 'expired') AND ended_at IS NOT NULL AND end_reason IS NOT NULL
        AND ended_at >= started_at AND last_confirmed_at <= ended_at)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_session_activity_open_interval
  ON __SOPHIA_RUNTIME_SCHEMA__.session_activity_intervals (session_id)
  WHERE status = 'open';
CREATE INDEX IF NOT EXISTS idx_session_activity_customer_period
  ON __SOPHIA_RUNTIME_SCHEMA__.session_activity_intervals (customer_id, started_at, ended_at)
  WHERE status IN ('finalised', 'expired');

CREATE OR REPLACE FUNCTION __SOPHIA_RUNTIME_SCHEMA__.protect_session_activity_interval()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.session_activity_interval_id <> OLD.session_activity_interval_id
    OR NEW.customer_id <> OLD.customer_id OR NEW.session_id <> OLD.session_id
    OR NEW.connection_id <> OLD.connection_id OR NEW.started_at <> OLD.started_at
    OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'Session activity interval identity is immutable';
  END IF;
  IF OLD.status IN ('finalised', 'expired') THEN
    RAISE EXCEPTION 'Finalised session activity is immutable';
  END IF;
  IF NEW.last_confirmed_at < OLD.last_confirmed_at THEN
    RAISE EXCEPTION 'Session activity confirmation cannot move backwards';
  END IF;
  IF NEW.status = 'open' THEN
    IF NEW.ended_at IS NOT NULL OR NEW.end_reason IS NOT NULL THEN
      RAISE EXCEPTION 'Open session activity cannot contain finalisation evidence';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.status NOT IN ('finalised', 'expired') OR NEW.ended_at IS NULL OR NEW.end_reason IS NULL THEN
    RAISE EXCEPTION 'Session activity interval has an invalid transition';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_protect_session_activity_interval
  ON __SOPHIA_RUNTIME_SCHEMA__.session_activity_intervals;
CREATE TRIGGER trg_protect_session_activity_interval
  BEFORE UPDATE ON __SOPHIA_RUNTIME_SCHEMA__.session_activity_intervals
  FOR EACH ROW EXECUTE FUNCTION __SOPHIA_RUNTIME_SCHEMA__.protect_session_activity_interval();

ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.session_activity_intervals ENABLE ROW LEVEL SECURITY;
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.session_activity_intervals FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS session_activity_intervals_tenant_isolation
  ON __SOPHIA_RUNTIME_SCHEMA__.session_activity_intervals;
CREATE POLICY session_activity_intervals_tenant_isolation
  ON __SOPHIA_RUNTIME_SCHEMA__.session_activity_intervals
  USING (customer_id = NULLIF(current_setting('sophia.tenant_id', true), '')::uuid)
  WITH CHECK (customer_id = NULLIF(current_setting('sophia.tenant_id', true), '')::uuid);

REVOKE ALL ON __SOPHIA_RUNTIME_SCHEMA__.session_activity_intervals FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON __SOPHIA_RUNTIME_SCHEMA__.session_activity_intervals TO sophia_runtime_app;

COMMENT ON TABLE __SOPHIA_RUNTIME_SCHEMA__.session_activity_intervals IS
  'Canonical server-timestamped connected activity. Operational session lifetime and provider cleanup delays are not billable activity.';
COMMENT ON COLUMN __SOPHIA_RUNTIME_SCHEMA__.session_activity_intervals.last_confirmed_at IS
  'Latest authenticated evidence that the connection remained active; retry updates are monotonic and never additive.';
