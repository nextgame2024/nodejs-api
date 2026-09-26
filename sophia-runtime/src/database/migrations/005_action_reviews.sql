CREATE TABLE IF NOT EXISTS __SOPHIA_RUNTIME_SCHEMA__.action_reviews (
  review_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES __SOPHIA_RUNTIME_SCHEMA__.sessions(session_id) ON DELETE CASCADE,
  customer_id uuid NOT NULL REFERENCES __SOPHIA_RUNTIME_SCHEMA__.customers(customer_id) ON DELETE CASCADE,
  action_type text NOT NULL,
  payload jsonb NOT NULL,
  payload_hash text NOT NULL,
  status text NOT NULL DEFAULT 'reviewed',
  command_id uuid NOT NULL DEFAULT gen_random_uuid(),
  expires_at timestamptz NOT NULL,
  confirmed_at timestamptz,
  committed_at timestamptz,
  invalidated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT action_reviews_status_check
    CHECK (status IN ('reviewed', 'confirmed', 'committed', 'expired', 'invalidated'))
);

CREATE INDEX IF NOT EXISTS idx_sophia_runtime_action_reviews_session
  ON __SOPHIA_RUNTIME_SCHEMA__.action_reviews(session_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_sophia_runtime_action_reviews_expiry
  ON __SOPHIA_RUNTIME_SCHEMA__.action_reviews(status, expires_at);
