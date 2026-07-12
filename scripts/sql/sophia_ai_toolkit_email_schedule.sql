CREATE TABLE IF NOT EXISTS sophia_ai_toolkit_email_schedule (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id UUID NOT NULL REFERENCES sophia_ai_toolkit_payments(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email_key TEXT NOT NULL,
  day_offset INTEGER NOT NULL,
  recipient_email TEXT NOT NULL,
  recipient_name TEXT,
  subject TEXT NOT NULL,
  preview_text TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  scheduled_for TIMESTAMPTZ NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_attempt_at TIMESTAMPTZ,
  sent_at TIMESTAMPTZ,
  failed_at TIMESTAMPTZ,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (payment_id, email_key)
);

CREATE INDEX IF NOT EXISTS idx_toolkit_email_schedule_due
  ON sophia_ai_toolkit_email_schedule(status, scheduled_for);

CREATE INDEX IF NOT EXISTS idx_toolkit_email_schedule_user
  ON sophia_ai_toolkit_email_schedule(user_id, created_at DESC);
