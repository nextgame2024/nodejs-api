CREATE TABLE IF NOT EXISTS user_mfa_factors (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  factor_type text NOT NULL DEFAULT 'totp' CHECK (factor_type = 'totp'),
  status text NOT NULL CHECK (status IN ('pending','active')),
  secret_ciphertext bytea NOT NULL,
  secret_iv bytea NOT NULL CHECK (octet_length(secret_iv) = 12),
  secret_auth_tag bytea NOT NULL CHECK (octet_length(secret_auth_tag) = 16),
  last_verified_counter bigint,
  failed_attempts integer NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0),
  locked_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  activated_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_user_mfa_factors_status
  ON user_mfa_factors(status, locked_until);
