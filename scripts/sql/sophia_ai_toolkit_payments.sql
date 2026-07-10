CREATE TABLE IF NOT EXISTS sophia_ai_toolkit_payments (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount_cents INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'aud',
  status TEXT NOT NULL DEFAULT 'created',
  stripe_session_id TEXT UNIQUE,
  stripe_payment_intent TEXT,
  stripe_customer_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  paid_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_sophia_ai_toolkit_payments_user
  ON sophia_ai_toolkit_payments(user_id);

CREATE INDEX IF NOT EXISTS idx_sophia_ai_toolkit_payments_status
  ON sophia_ai_toolkit_payments(status);
