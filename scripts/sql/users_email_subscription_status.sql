ALTER TABLE users
  ADD COLUMN IF NOT EXISTS email_subscription_status char(1) NOT NULL DEFAULT 'Y';

CREATE INDEX IF NOT EXISTS idx_users_email_subscription_status
  ON users (email_subscription_status);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'chk_users_email_subscription_status'
  ) THEN
    ALTER TABLE users
      ADD CONSTRAINT chk_users_email_subscription_status
      CHECK (email_subscription_status IN ('Y', 'N'));
  END IF;
END $$;
